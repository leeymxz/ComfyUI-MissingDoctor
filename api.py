# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - HTTP API 路由

挂载在 ComfyUI 的 aiohttp 应用上（/md/* 前缀）：
- POST /md/check_nodes      检测工作流缺失节点（附安装仓库建议）
- POST /md/check_models     检测工作流缺失模型（附下载地址建议）
- POST /md/remote_search    手动搜索模型下载地址
- GET  /md/aged_models      扫描老旧模型（?days=90&sort=oldest|size）
- GET  /md/cleanup_preview  清理目标预览（temp/output/pycache/logs）
- POST /md/cleanup          执行清理（必须 confirm=true）
- POST /md/self_update      插件自更新（插件目录 git pull --ff-only，后台执行）
- GET  /md/self_update_status  自更新进度查询
"""

import asyncio
import os
import re
import time
import traceback

import folder_paths
from aiohttp import web
from server import PromptServer

from . import checker
from . import aged as aged_mod
from . import cleaner
from . import dedupe
from . import downloader
from . import envinfo
from . import installer
from . import mapper
from . import pkgmgr
from . import remote_lookup
from . import self_update


def _json(data, status=200):
    return web.json_response(data, status=status)


def _err(message, status=500):
    return _json({"status": "error", "message": str(message)}, status=status)


async def _body(request):
    try:
        return await request.json()
    except Exception:
        return {}


# ---------------------------------------------------------------- handlers

async def h_check_nodes(request):
    try:
        body = await _body(request)
        wf = body.get("workflow") or {}
        # 检测本身在事件循环内很快（纯内存比对）
        data = checker.check_missing_nodes(wf)
        missing = data.get("missing_nodes", [])

        # 建议查询（含代码级验证等网络请求）必须在线程池执行，否则阻塞整个 ComfyUI 事件循环
        if missing:
            async def _one(ct):
                return ct, await asyncio.to_thread(remote_lookup.suggest_node_sources, ct)

            gathered = await asyncio.gather(*[_one(ct) for ct in missing])
            suggestions, advices = {}, {}
            for ct, (sug, adv) in gathered:
                suggestions[ct] = sug
                if adv:
                    advices[ct] = adv
            data["suggestions"] = suggestions
            data["node_advice"] = advices
        else:
            data["suggestions"] = {}
            data["node_advice"] = {}
        return _json({"status": "ok", "data": data})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_check_models(request):
    try:
        body = await _body(request)
        wf = body.get("workflow") or {}
        data = checker.check_missing_models(wf)
        missing = data.get("missing_models", [])

        # 下载建议查询在网络线程池执行，避免阻塞事件循环
        if missing:
            async def _one(m):
                hint = (m.get("folders_hint") or [None])[0]
                return m["value"], await asyncio.to_thread(
                    remote_lookup.suggest_model_downloads, m["value"], hint)

            results = await asyncio.gather(*[_one(m) for m in missing])
            lookup = dict(results)
            for m in missing:
                m["downloads"] = lookup.get(m["value"], [])

        # 空结果/稀少结果时附上原因与行动指引
        try:
            data["advice"] = remote_lookup.search_advice(
                (missing[0]["value"] if missing else ""), results_count=len(missing))
        except Exception:
            pass
        return _json({"status": "ok", "data": data})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_remote_search(request):
    try:
        body = await _body(request)
        q = body.get("query") or ""
        ftype = body.get("type")
        if not q:
            return _err("query 不能为空", 400)

        # 魔搭（ModelScope）模型页链接：解析为下载直链
        if re.match(r"https?://(?:www\.)?modelscope\.cn/models/", q):
            results, model_id = await asyncio.to_thread(
                remote_lookup.search_modelscope_by_url, q, body.get("filename"))
            advice = {"found": bool(results),
                      "query": q,
                      "tips": ["🇨🇳 已解析魔搭模型：%s" % (model_id or q),
                               "✓ 文件匹配 = 与缺失模型同名；~ 近似 = 相似名（请核对）",
                               "🔍 其他 = 该仓库内的其它模型文件"]}
            return _json({"status": "ok", "data": {"query": q, "results": results or [],
                                                   "advice": advice}})

        results = await asyncio.to_thread(remote_lookup.suggest_model_downloads, q, ftype)
        advice = remote_lookup.search_advice(q, ftype, results_count=len(results))
        return _json({"status": "ok", "data": {"query": q, "results": results, "advice": advice}})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_aged_models(request):
    try:
        try:
            days = float(request.query.get("days", 90))
        except (TypeError, ValueError):
            days = 90.0
        days = max(1.0, min(days, 3650.0))
        sort = request.query.get("sort", "oldest")
        if sort not in ("oldest", "size"):
            sort = "oldest"
        data = await asyncio.to_thread(aged_mod.scan_aged_models, min_age_days=days, sort=sort)
        return _json({"status": "ok", "data": data})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_cleanup_preview(request):
    try:
        try:
            output_days = float(request.query.get("output_days", 0) or 0)
        except (TypeError, ValueError):
            output_days = 0
        output_days = max(0.0, min(output_days, 3650.0))

        def _collect_all():
            data = {}
            for cat in cleaner.CLEAN_CATEGORIES:
                targets = cleaner.collect_targets(cat, keep_days=output_days if cat == "output" else 0)
                data[cat] = {
                    "count": len(targets),
                    "size": sum(t["size"] for t in targets),
                    "paths": [t["path"] for t in targets[:200]],
                }
            data["output_days"] = output_days
            return data

        data = await asyncio.to_thread(_collect_all)
        return _json({"status": "ok", "data": data})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_cleanup(request):
    try:
        body = await _body(request)
        category = body.get("category")
        confirm = bool(body.get("confirm"))
        paths = body.get("paths")
        use_trash = body.get("trash", True)

        if not confirm:
            return _err("缺少 confirm=true，已拒绝删除（安全保护）", 400)

        if category == "models":
            if not paths or not isinstance(paths, list):
                return _err("models 清理必须提供待删除文件路径列表 paths", 400)
            for p in paths:
                if not cleaner.is_path_allowed(p):
                    return _err("路径不在允许范围内，已拒绝: %s" % p, 403)
            result = cleaner.delete_paths(paths, use_trash=use_trash)
            # 后端保险：标注删除目标中近期有调用记录的文件
            try:
                recent = []
                for p in paths:
                    lu = aged_mod.usage_tracker.get_last_used(p)
                    if lu and (time.time() - lu) < aged_mod.RECENT_USE_DAYS * 86400:
                        recent.append(p)
                result["recently_used"] = recent
            except Exception:
                result["recently_used"] = []
        elif category in cleaner.CLEAN_CATEGORIES:
            try:
                keep_days = float(body.get("keep_days", 0) or 0)
            except (TypeError, ValueError):
                keep_days = 0
            keep_days = max(0.0, min(keep_days, 3650.0))

            def _clean():
                targets = cleaner.collect_targets(category, keep_days=keep_days if category == "output" else 0)
                return cleaner.delete_paths([t["path"] for t in targets], use_trash=use_trash)

            result = await asyncio.to_thread(_clean)
        else:
            return _err("未知清理类别: %s" % category, 400)

        return _json({"status": "ok", "data": result})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_download_start(request):
    try:
        body = await _body(request)
        url = body.get("url") or ""
        folder_type = body.get("folder_type") or "checkpoints"
        filename = body.get("filename")
        dest_dir = body.get("dest_dir")
        result = downloader.start_download(url, folder_type, filename, dest_dir)
        if "error" in result:
            return _err(result["error"], 400)
        return _json({"status": "ok", "data": result})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_download_status(request):
    try:
        return _json({"status": "ok", "data": downloader.status()})
    except Exception as e:
        return _err(e)


async def h_download_cancel(request):
    try:
        return _json({"status": "ok", "data": downloader.cancel_download()})
    except Exception as e:
        return _err(e)


async def h_model_folders(request):
    try:
        return _json({"status": "ok", "data": {"folders": downloader.list_model_folders()}})
    except Exception as e:
        return _err(e)


async def h_install_start(request):
    try:
        body = await _body(request)
        items = body.get("items") or []
        result = installer.start_install(items)
        if "error" in result:
            return _err(result["error"], 400)
        return _json({"status": "ok", "data": result})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_install_status(request):
    try:
        return _json({"status": "ok", "data": installer.status()})
    except Exception as e:
        return _err(e)


async def h_env_summary(request):
    try:
        return _json({"status": "ok", "data": envinfo.env_summary()})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_env_requirements(request):
    try:
        force = request.query.get("force", "0") == "1"
        return _json({"status": "ok", "data": await asyncio.to_thread(envinfo.scan_requirements, force)})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_env_heavy(request):
    try:
        try:
            top = int(request.query.get("top", 25))
        except (TypeError, ValueError):
            top = 25
        force = request.query.get("force", "0") == "1"
        return _json({"status": "ok", "data": await asyncio.to_thread(envinfo.heavy_packages, top, force)})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_pip_install(request):
    try:
        body = await _body(request)
        req_file = body.get("requirements_file")
        if req_file:
            result = pkgmgr.install_requirements_file(req_file)
        else:
            result = pkgmgr.install_packages(body.get("packages") or [])
        if "error" in result:
            return _err(result["error"], 400)
        return _json({"status": "ok", "data": result})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_pip_uninstall(request):
    try:
        body = await _body(request)
        names = body.get("packages")
        if not names and body.get("package"):
            names = [body.get("package")]
        if not names or not isinstance(names, list):
            return _err("未指定要卸载的包", 400)
        # 核心包保护：卸了 ComfyUI 会崩的包直接拒绝
        cores = envinfo.core_packages()
        cleaned = []
        for n in names:
            name_only = envinfo.split_requirement(str(n))[0] or str(n)
            if envinfo._canon(name_only) in cores:
                return _err("「%s」是 ComfyUI 核心依赖，禁止卸载" % name_only, 403)
            cleaned.append(name_only)
        result = pkgmgr.uninstall_packages(cleaned)
        if "error" in result:
            return _err(result["error"], 400)
        return _json({"status": "ok", "data": result})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_pip_status(request):
    try:
        return _json({"status": "ok", "data": pkgmgr.status()})
    except Exception as e:
        return _err(e)


async def h_duplicates(request):
    """扫描重复模型（采样指纹比对），耗时扫描线程执行"""
    try:
        data = await asyncio.to_thread(dedupe.scan_duplicates)
        return _json({"status": "ok", "data": data})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_mapper_scan(request):
    """扫描本机所有 ComfyUI 安装与 models 映射状态"""
    try:
        data = await asyncio.to_thread(mapper.scan_installs)
        return _json({"status": "ok", "data": {"installs": data,
                                               "supported": mapper.supported()}})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_mapper_apply(request):
    """建立 models 目录映射（源真实仓库 → 目标安装）"""
    try:
        body = await _body(request)
        source = body.get("source") or ""
        targets = body.get("targets") or []
        if not source or not targets:
            return _err("缺少 source 或 targets", 400)
        results = []
        for t in targets:
            r = await asyncio.to_thread(mapper.map_models, source, t)
            results.append({"target": t, **r})
        return _json({"status": "ok", "data": {"results": results}})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_mapper_unmap(request):
    try:
        body = await _body(request)
        results = []
        for t in body.get("targets") or []:
            r = await asyncio.to_thread(mapper.unmap_models, t)
            results.append({"target": t, **r})
        return _json({"status": "ok", "data": {"results": results}})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_mapper_restore(request):
    try:
        body = await _body(request)
        results = []
        for t in body.get("targets") or []:
            r = await asyncio.to_thread(mapper.restore_backup, t)
            results.append({"target": t, **r})
        return _json({"status": "ok", "data": {"results": results}})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_version(request):
    try:
        import sys
        from .version import VERSION, REPO_URL
        base = getattr(folder_paths, "base_path", None)
        data = {
            "version": VERSION,
            "repo_url": REPO_URL,
            "plugin_path": os.path.dirname(os.path.abspath(__file__)),
            "comfyui_base": os.path.abspath(base) if base else None,
            "python": sys.version.split()[0],
        }
        try:
            import comfyui_version  # noqa
            data["comfyui"] = getattr(comfyui_version, "__version__", "unknown")
        except Exception:
            data["comfyui"] = "unknown"
        return _json({"status": "ok", "data": data})
    except Exception as e:
        return _err(e)


async def h_feedback(request):
    """社区纠错反馈：{type: node|model, key, repo, correct?}"""
    try:
        body = await _body(request)
        from . import corrections
        kind = body.get("type")
        key = body.get("key") or ""
        repo = body.get("repo") or ""
        if not key or not repo:
            return _err("缺少 key 或 repo", 400)
        if kind == "model":
            import os as _os
            key = _os.path.basename(key)
        if body.get("correct"):
            corrections.mark_correct(key, repo)
        else:
            corrections.mark_wrong(key, repo)
        return _json({"status": "ok", "data": {"accepted": True}})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_self_update(request):
    """插件自更新：在插件目录 git pull --ff-only（后台执行）"""
    try:
        ok, msg = await asyncio.to_thread(self_update.start_update)
        return _json({"status": "ok" if ok else "error",
                      "message": msg,
                      "data": self_update.get_status()})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_self_update_status(request):
    """自更新进度查询"""
    try:
        return _json({"status": "ok", "data": self_update.get_status()})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


# ---------------------------------------------------------------- 注册

ROUTES = [
    ("POST", "/md/check_nodes", h_check_nodes),
    ("POST", "/md/check_models", h_check_models),
    ("POST", "/md/remote_search", h_remote_search),
    ("GET", "/md/aged_models", h_aged_models),
    ("GET", "/md/cleanup_preview", h_cleanup_preview),
    ("POST", "/md/cleanup", h_cleanup),
    ("POST", "/md/download_start", h_download_start),
    ("GET", "/md/download_status", h_download_status),
    ("POST", "/md/download_cancel", h_download_cancel),
    ("GET", "/md/model_folders", h_model_folders),
    ("POST", "/md/install_start", h_install_start),
    ("GET", "/md/install_status", h_install_status),
    ("GET", "/md/env_summary", h_env_summary),
    ("GET", "/md/env_requirements", h_env_requirements),
    ("GET", "/md/env_heavy", h_env_heavy),
    ("POST", "/md/pip_install", h_pip_install),
    ("POST", "/md/pip_uninstall", h_pip_uninstall),
    ("GET", "/md/pip_status", h_pip_status),
    ("GET", "/md/version", h_version),
    ("POST", "/md/feedback", h_feedback),
    ("POST", "/md/self_update", h_self_update),
    ("GET", "/md/self_update_status", h_self_update_status),
    ("GET", "/md/duplicates", h_duplicates),
    ("GET", "/md/mapper_scan", h_mapper_scan),
    ("POST", "/md/mapper_apply", h_mapper_apply),
    ("POST", "/md/mapper_unmap", h_mapper_unmap),
    ("POST", "/md/mapper_restore", h_mapper_restore),
]


def register_routes():
    instance = getattr(PromptServer, "instance", None)
    app = getattr(instance, "app", None)
    if app is None:
        print("[MissingDoctor] PromptServer 不可用，API 未注册（可能运行在非 ComfyUI 环境）")
        return
    for method, path, handler in ROUTES:
        try:
            app.router.add_route(method, path, handler)
        except Exception as e:
            print(f"[MissingDoctor] 注册路由失败 {path}: {e}")
    print("[MissingDoctor] API 已注册: /md/check_nodes, /md/check_models, /md/remote_search, "
          "/md/aged_models, /md/cleanup_preview, /md/cleanup, /md/download_start, "
          "/md/download_status, /md/model_folders")
