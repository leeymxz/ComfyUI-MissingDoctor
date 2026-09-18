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
"""

import time
import traceback

from aiohttp import web
from server import PromptServer

from . import checker
from . import aged as aged_mod
from . import cleaner
from . import downloader
from . import envinfo
from . import installer
from . import pkgmgr
from . import remote_lookup


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
        data = checker.check_missing_nodes(wf)
        suggestions = {}
        for ct in data.get("missing_nodes", []):
            suggestions[ct] = remote_lookup.suggest_node_sources(ct)
        data["suggestions"] = suggestions
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

        # 多个缺失文件并行查询下载建议，避免弱网下串行叠加超时
        if missing:
            from concurrent.futures import ThreadPoolExecutor

            def _suggest(m):
                hint = (m.get("folders_hint") or [None])[0]
                try:
                    return m["value"], remote_lookup.suggest_model_downloads(m["value"], hint)
                except Exception:
                    return m["value"], []

            ex = ThreadPoolExecutor(max_workers=min(6, max(1, len(missing))))
            try:
                for value, downloads in ex.map(_suggest, missing):
                    for m in missing:
                        if m["value"] == value:
                            m["downloads"] = downloads
                            break
            finally:
                ex.shutdown(wait=False)

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
        results = remote_lookup.suggest_model_downloads(q, ftype)
        return _json({"status": "ok", "data": {"query": q, "results": results}})
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
        data = aged_mod.scan_aged_models(min_age_days=days, sort=sort)
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
        data = {}
        for cat in cleaner.CLEAN_CATEGORIES:
            targets = cleaner.collect_targets(cat, keep_days=output_days if cat == "output" else 0)
            data[cat] = {
                "count": len(targets),
                "size": sum(t["size"] for t in targets),
                "paths": [t["path"] for t in targets[:200]],
            }
        data["output_days"] = output_days
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
            targets = cleaner.collect_targets(category, keep_days=keep_days if category == "output" else 0)
            result = cleaner.delete_paths([t["path"] for t in targets], use_trash=use_trash)
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
        result = downloader.start_download(url, folder_type, filename)
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
        return _json({"status": "ok", "data": envinfo.scan_requirements(force=force)})
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
        return _json({"status": "ok", "data": envinfo.heavy_packages(top=top, force=force)})
    except Exception as e:
        traceback.print_exc()
        return _err(e)


async def h_pip_install(request):
    try:
        body = await _body(request)
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
