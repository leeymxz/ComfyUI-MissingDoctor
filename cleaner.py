# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 安全清理模块

安全设计：
- 路径白名单：只允许操作 folder_paths 注册目录及 ComfyUI 的 temp/output/user/custom_nodes
- 删除操作必须显式 confirm，且逐路径校验白名单，防路径穿越
- 优先移入回收站（send2trash），未安装时才直接删除
"""

import os
import shutil
import time

import folder_paths

from . import usage_tracker

try:
    from send2trash import send2trash
    _HAS_TRASH = True
except Exception:  # pragma: no cover
    send2trash = None
    _HAS_TRASH = False


def _base_path():
    """推断 ComfyUI 主目录"""
    base = getattr(folder_paths, "base_path", None)
    if base:
        return os.path.abspath(base)
    try:
        ckpts = folder_paths.get_folder_paths("checkpoints")
        if ckpts:
            p = os.path.abspath(ckpts[0])
            # <root>/models/checkpoints -> root
            return os.path.dirname(os.path.dirname(p))
    except Exception:
        pass
    return os.getcwd()


def safe_roots():
    """允许清理操作的白名单根目录集合（normcase + realpath 归一化）"""
    roots = set()
    try:
        for _name, entry in folder_paths.folder_names_and_paths.items():
            for p in entry[0]:
                roots.add(os.path.normcase(os.path.realpath(os.path.abspath(p))))
    except Exception:
        pass

    base = _base_path()
    for sub in ("temp", "output", "custom_nodes", "user", "models", "input"):
        roots.add(os.path.normcase(os.path.realpath(os.path.join(base, sub))))
    return roots


def is_path_allowed(path):
    """校验路径是否落在白名单根之内（防路径穿越）"""
    try:
        rp = os.path.normcase(os.path.realpath(os.path.abspath(path)))
    except Exception:
        return False
    for root in safe_roots():
        if rp == root or rp.startswith(root + os.sep):
            return True
    return False


def _size(p):
    try:
        return os.path.getsize(p)
    except OSError:
        return 0


def _walk_files(d):
    out = []
    if not os.path.isdir(d):
        return out
    for root, dirs, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            out.append({"path": p, "size": _size(p)})
    return out


CLEAN_CATEGORIES = ("temp", "output", "pycache", "logs")


def collect_targets(category, keep_days=0):
    """收集某类清理目标（只列出，不删除），返回 [{path, size}]

    keep_days: 仅对 output 生效——只列出修改时间早于 N 天前的文件，
    保留最近 N 天的输出，避免误删还在用的新图。
    """
    base = _base_path()
    targets = []

    if category == "temp":
        targets = _walk_files(os.path.join(base, "temp"))
    elif category == "output":
        targets = _walk_files(os.path.join(base, "output"))
        try:
            keep_days = float(keep_days or 0)
        except (TypeError, ValueError):
            keep_days = 0
        if keep_days > 0:
            cutoff = time.time() - keep_days * 86400
            filtered = []
            for t in targets:
                try:
                    if os.path.getmtime(t["path"]) < cutoff:
                        filtered.append(t)
                except OSError:
                    pass
            targets = filtered
    elif category == "pycache":
        cn = os.path.join(base, "custom_nodes")
        if os.path.isdir(cn):
            for root, dirs, _files in os.walk(cn):
                for d in list(dirs):
                    if d == "__pycache__":
                        sub = os.path.join(root, d)
                        size = sum(t["size"] for t in _walk_files(sub))
                        targets.append({"path": sub, "size": size})
    elif category == "logs":
        ud = os.path.join(base, "user")
        if os.path.isdir(ud):
            for root, _dirs, files in os.walk(ud):
                for f in files:
                    if f.endswith(".log"):
                        p = os.path.join(root, f)
                        targets.append({"path": p, "size": _size(p)})

    return targets


def delete_paths(paths, use_trash=True):
    """删除给定路径（逐个白名单校验）。返回 {deleted, freed, errors}"""
    deleted, freed, errors = [], 0, []
    trash_fn = send2trash if (use_trash and _HAS_TRASH) else None

    for p in paths or []:
        if not is_path_allowed(p):
            errors.append({"path": p, "error": "路径不在允许范围内（安全白名单限制）"})
            continue
        if not os.path.exists(p) and not os.path.isdir(p):
            errors.append({"path": p, "error": "文件不存在"})
            continue
        try:
            if os.path.isdir(p):
                sz = sum(t["size"] for t in _walk_files(p))
            else:
                sz = _size(p)

            if trash_fn:
                trash_fn(p)
            elif os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                os.remove(p)

            deleted.append(p)
            freed += sz
        except Exception as e:
            errors.append({"path": p, "error": str(e)})

    return {
        "deleted": deleted,
        "deleted_count": len(deleted),
        "freed": freed,
        "errors": errors,
        "trash_used": bool(trash_fn),
        "_cleanup_usage": _forget_usage(deleted),
    }


def _forget_usage(deleted):
    """删除成功后同步清理使用记录，避免残留脏数据"""
    try:
        usage_tracker.forget(deleted)
        return True
    except Exception:
        return False
