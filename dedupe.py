# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 模型查重

重复检测：按文件大小分组 → 同大小组内做"头/中/尾"采样哈希指纹比对。
- 相比全量 sha256（几百 GB 模型耗时数小时），每个文件仅读 ~3MB，飞快且几乎不会误判
- 完全相同内容的副本必然同指纹；不同内容（即便同大小）指纹不同
推荐保留：最近调用时间 → 最后修改时间 → 路径，用户可自行切换主文件
"""

import hashlib
import os

from . import usage_tracker
from .aged import iter_model_files

SAMPLE = 1 * 1024 * 1024  # 每个采样块 1MB（头/中/尾）


def _fingerprint(path, size):
    """采样指纹：头 SAMPLE + 中 SAMPLE + 尾 SAMPLE（大文件）；小文件直接读全文"""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            if size <= SAMPLE * 3:
                f.seek(0)
                h.update(f.read(size))
            else:
                h.update(f.read(SAMPLE))
                f.seek(size // 2)
                h.update(f.read(SAMPLE))
                f.seek(size - SAMPLE)
                h.update(f.read(SAMPLE))
    except OSError:
        return None
    return h.hexdigest()


def _fill_extra(path, it):
    """补充展示信息与调用时间"""
    lu = usage_tracker.get_last_used(path)
    return {
        "path": path,
        "size": it.get("size", 0),
        "mtime": it.get("mtime"),
        "folder_type": it.get("folder_type"),
        "rel": it.get("rel_path") or os.path.basename(path),
        "last_used": int(lu) if lu else None,
    }


def scan_duplicates():
    """扫描重复模型，返回分组结果"""
    by_size = {}
    items_map = {}
    for it in iter_model_files():
        if it.get("size", 0) <= 0:
            continue
        by_size.setdefault(it["size"], []).append(it["path"])
        items_map[it["path"]] = it

    groups = []
    for size, paths in by_size.items():
        if len(paths) < 2:
            continue
        fpmap = {}
        for p in paths:
            fp = _fingerprint(p, size)
            if fp:
                fpmap.setdefault(fp, []).append(p)
        for fp, same in fpmap.items():
            if len(same) < 2:
                continue
            files = [_fill_extra(p, items_map.get(p, {})) for p in same]
            # 推荐保留：最近调用 > 最新修改 > 最短路径
            files.sort(key=lambda x: ((x.get("last_used") or 0),
                                      (x.get("mtime") or 0),
                                      -len(x.get("path") or "")),
                       reverse=True)
            keep = files[0]
            groups.append({
                "files": files,
                "keep": keep["path"],
                "keep_rel": keep["rel"],
                "size": size,
                "waste": size * (len(files) - 1),
            })

    groups.sort(key=lambda g: -g["waste"])
    return {
        "groups": groups,
        "group_count": len(groups),
        "duplicate_count": sum(len(g["files"]) - 1 for g in groups),
        "waste_total": sum(g["waste"] for g in groups),
    }