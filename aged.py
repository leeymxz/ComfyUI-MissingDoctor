# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 老旧模型扫描

按文件最后修改时间（mtime）筛选长期未变动的模型文件，
遍历 folder_paths 注册的所有模型目录（含 custom_nodes 注册的自定义模型目录）。
"""

import os
import time

import folder_paths

from . import usage_tracker

MODEL_EXTS = {
    ".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf",
    ".onnx", ".sft", ".engine", ".trt", ".pt2",
}

# 这些目录不是模型目录，跳过
SKIP_FOLDERS = {"temp", "output"}

# 被视为"近期仍在使用"的阈值（天），用于防误删提示
RECENT_USE_DAYS = 7


def iter_model_files():
    """遍历所有注册模型目录中的模型文件，yield 描述 dict"""
    seen = set()
    try:
        registry = dict(folder_paths.folder_names_and_paths)
    except Exception:
        registry = {}

    for folder_name, entry in registry.items():
        if folder_name in SKIP_FOLDERS:
            continue
        try:
            paths = entry[0]
        except Exception:
            continue

        for base in paths:
            try:
                base = os.path.abspath(base)
            except Exception:
                continue
            if not os.path.isdir(base):
                continue

            for root, dirs, files in os.walk(base):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for f in files:
                    if f.startswith("."):
                        continue
                    if os.path.splitext(f)[1].lower() not in MODEL_EXTS:
                        continue
                    full = os.path.normpath(os.path.join(root, f))
                    if full in seen:
                        continue
                    seen.add(full)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    try:
                        rel = os.path.relpath(full, base).replace("\\", "/")
                    except ValueError:
                        rel = f
                    yield {
                        "path": full,
                        "rel_path": rel,
                        "folder_type": folder_name,
                        "size": st.st_size,
                        "mtime": int(st.st_mtime),
                        "atime": int(getattr(st, "st_atime", 0) or 0),
                    }


def scan_aged_models(min_age_days=90, sort="oldest"):
    """扫描超过 min_age_days 未修改的模型文件

    sort: "oldest" 按最旧优先 | "size" 按大小优先
    附带最近调用信息：
    - last_used / last_used_days / last_used_src("record"|"atime")
      record = 插件挂钩记录的真实调用；atime = 文件系统访问时间（仅供参考兜底）
    """
    now = time.time()
    threshold = now - float(min_age_days) * 86400
    items = []
    total_size = 0

    for it in iter_model_files():
        if it["mtime"] <= threshold:
            it["age_days"] = round((now - it["mtime"]) / 86400, 1)

            lu = usage_tracker.get_last_used(it["path"])
            src = None
            if lu:
                src = "record"
            elif it.get("atime") and it["atime"] > it["mtime"] + 3600:
                # 访问时间晚于修改时间超过 1 小时才有参考意义
                lu = float(it["atime"])
                src = "atime"
            if lu:
                it["last_used"] = int(lu)
                it["last_used_days"] = round(max(0.0, (now - lu) / 86400), 1)
                it["last_used_src"] = src
                it["recently_used"] = (now - lu) < RECENT_USE_DAYS * 86400
            else:
                it["last_used"] = None
                it["recently_used"] = False

            total_size += it["size"]
            items.append(it)

    if sort == "size":
        items.sort(key=lambda x: (-x["size"], x["mtime"]))
    else:
        items.sort(key=lambda x: x["mtime"])

    return {
        "items": items,
        "count": len(items),
        "total_size": total_size,
        "days": float(min_age_days),
        "recent_use_days": RECENT_USE_DAYS,
        "recently_used_count": sum(1 for i in items if i.get("recently_used")),
        "tracked_count": sum(1 for i in items if i.get("last_used_src") == "record"),
    }
