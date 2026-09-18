# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 模型使用记录追踪

ComfyUI 原生不记录模型"最后使用时间"，本模块通过挂钩
folder_paths.get_full_path（所有标准模型加载的必经之路）记录
每个模型文件的真实调用时间，持久化到插件 .cache/usage.json。

- 记录从插件安装后开始积累，越用越准
- 单线程锁保护，30 秒节流落盘 + 进程退出时强制落盘
- 记录按路径大小写/分隔符归一化（Windows 兼容）
"""

import atexit
import json
import os
import threading
import time

import folder_paths

_RECORDS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache", "usage.json")

SAVE_INTERVAL = 30.0

_lock = threading.Lock()
_records = {}       # normcase(normpath(abspath)) -> last_used_ts
_dirty = False
_last_save = 0.0
_installed = False


def _load():
    global _records
    try:
        if os.path.isfile(_RECORDS_PATH):
            with open(_RECORDS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                _records = {str(k): float(v) for k, v in data.items() if v}
    except Exception:
        _records = {}


def save(force=False):
    """落盘（带脏标记节流）。"""
    global _dirty, _last_save
    with _lock:
        if not _dirty and not force:
            return
        try:
            os.makedirs(os.path.dirname(_RECORDS_PATH), exist_ok=True)
            tmp = _RECORDS_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(_records, f, ensure_ascii=False)
            os.replace(tmp, _RECORDS_PATH)
            _dirty = False
            _last_save = time.time()
        except Exception:
            pass


def _norm(path):
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


def record(path):
    """记录一次模型调用。"""
    global _dirty
    try:
        if not path:
            return
        key = _norm(path)
        now = time.time()
        with _lock:
            # 1 秒内重复调用去重，减少写放大
            if _records.get(key, 0) < now - 1:
                _records[key] = now
                _dirty = True
        if time.time() - _last_save > SAVE_INTERVAL:
            save()
    except Exception:
        pass


def get_last_used(path):
    """返回该路径最近一次调用的时间戳，无记录返回 None。"""
    try:
        if not path:
            return None
        key = _norm(path)
        with _lock:
            v = _records.get(key)
        return float(v) if v else None
    except Exception:
        return None


def forget(paths):
    """删除记录（文件被清理后调用，避免脏数据）。"""
    global _dirty
    try:
        with _lock:
            for p in paths or []:
                _records.pop(_norm(p), None)
            _dirty = True
        save()
    except Exception:
        pass


def install():
    """挂钩 folder_paths.get_full_path，开始记录。幂等。"""
    global _installed, _orig_get_full_path
    if _installed:
        return
    _installed = True

    _load()

    orig = getattr(folder_paths, "get_full_path", None)
    if orig is None:
        print("[MissingDoctor] usage_tracker: folder_paths.get_full_path 不存在，跳过挂钩")
        return
    _orig_get_full_path = orig

    def patched(folder_name, filename):
        p = orig(folder_name, filename)
        try:
            if p:
                record(p)
        except Exception:
            pass
        return p

    try:
        folder_paths.get_full_path = patched
        print("[MissingDoctor] usage_tracker: 已挂钩 folder_paths.get_full_path，开始记录模型调用时间")
    except Exception as e:
        print(f"[MissingDoctor] usage_tracker: 挂钩失败 {e}")
        return

    atexit.register(save, True)
