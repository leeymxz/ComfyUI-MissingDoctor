# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 模型直接下载器

把缺失模型的候选下载地址直接下载到对应的模型目录：
- 后台线程分块下载，进度可查询（/md/download_status）
- 先写 .part 临时文件，完成后原子改名，避免半成品被 ComfyUI 扫描
- 安全校验：仅 https、目标目录必须是 folder_paths 注册的模型目录、
  文件名净化、仅允许模型扩展名、重名拒绝
- 同时只允许一个下载任务
"""

import os
import re
import threading
import time

import requests

import folder_paths

from . import usage_tracker
from .aged import MODEL_EXTS

_UA = {"User-Agent": "ComfyUI-MissingDoctor/1.0"}

_lock = threading.Lock()
_state = {
    "running": False,
    "done": False,
    "error": None,
    "url": None,
    "folder_type": None,
    "filename": None,
    "target": None,
    "downloaded": 0,
    "total": 0,
    "speed": 0,
}
_thread = None
_cancel = threading.Event()


def status():
    with _lock:
        s = dict(_state)
    if s["total"] > 0 and s["running"]:
        s["percent"] = round(s["downloaded"] * 100.0 / s["total"], 1)
    elif s.get("done") and not s.get("error"):
        s["percent"] = 100.0
    else:
        s["percent"] = 0.0
    return s


def list_model_folders():
    """所有可用的模型目录名（供前端选择下载位置）"""
    try:
        names = [n for n in folder_paths.folder_names_and_paths.keys()
                 if n not in ("temp", "output")]
        return sorted(names)
    except Exception:
        return []


def start_download(url, folder_type, filename=None):
    """启动一个下载任务。返回 {ok} 或 {error}。"""
    global _thread

    url = (url or "").strip()
    if not url.startswith("https://"):
        return {"error": "仅支持 https 下载链接"}

    with _lock:
        if _state["running"]:
            return {"error": "已有下载任务进行中，请等待完成或稍后再试"}

    # 目标目录必须是注册的模型目录
    try:
        paths = folder_paths.get_folder_paths(folder_type)
    except Exception:
        paths = []
    if not paths:
        return {"error": "未知或不可用的模型目录: %s" % folder_type}
    dest_dir = os.path.abspath(paths[0])

    # 目标目录可能尚未在磁盘上创建（插件注册的自定义目录常见），自动创建
    try:
        os.makedirs(dest_dir, exist_ok=True)
    except OSError as e:
        return {"error": "无法创建目标目录 %s: %s" % (dest_dir, e)}

    # 文件名净化 + 扩展名白名单
    raw_name = filename or url.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
    name = os.path.basename(raw_name)
    name = re.sub(r'[\\/:*?"<>|\s]+', "_", name).strip("._")
    if not name:
        return {"error": "无法从链接确定文件名"}
    if os.path.splitext(name)[1].lower() not in MODEL_EXTS:
        return {"error": "不支持的文件类型（仅允许模型文件）: %s" % name}

    target = os.path.join(dest_dir, name)
    if os.path.exists(target):
        return {"error": "目标文件已存在: %s" % name}

    with _lock:
        _state.update({
            "running": True, "done": False, "error": None,
            "url": url, "folder_type": folder_type, "filename": name,
            "target": target, "downloaded": 0, "total": 0, "speed": 0,
        })

    _cancel.clear()

    def worker():
        try:
            with requests.get(url, stream=True, timeout=(15, 120), headers=_UA, allow_redirects=True) as r:
                r.raise_for_status()
                total = int(r.headers.get("Content-Length", 0) or 0)
                with _lock:
                    _state["total"] = total

                part = target + ".part"
                downloaded = 0
                last_t = time.time()
                last_d = 0
                with open(part, "wb") as f:
                    for chunk in r.iter_content(chunk_size=512 * 1024):
                        if _cancel.is_set():
                            break
                        if not chunk:
                            continue
                        f.write(chunk)
                        downloaded += len(chunk)
                        with _lock:
                            _state["downloaded"] = downloaded
                            now = time.time()
                            if now - last_t >= 0.5:
                                _state["speed"] = (downloaded - last_d) / (now - last_t)
                                last_t = now
                                last_d = downloaded

            err = None
            if _cancel.is_set():
                try:
                    os.remove(part)
                except OSError:
                    pass
                err = "已取消"
            else:
                # 确保目录仍在（极少数情况下载过程中被删），再原子改名
                try:
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    os.replace(part, target)
                    try:
                        usage_tracker.record(target)
                    except Exception:
                        pass
                except OSError as e:
                    err = "保存失败: %s" % e

            with _lock:
                _state["running"] = False
                _state["done"] = True
                _state["error"] = err
                if err:
                    _state["target"] = None
        except Exception as e:
            with _lock:
                _state["running"] = False
                _state["done"] = True
                _state["error"] = str(e)

    _thread = threading.Thread(target=worker, daemon=True, name="MissingDoctor-Downloader")
    _thread.start()
    return {"ok": True, "filename": name, "folder_type": folder_type}


def cancel_download():
    _cancel.set()
    return {"ok": True}
