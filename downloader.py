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
    """所有可用的模型目录：[{name, paths:[绝对路径...]}]（供前端精确选择下载位置）"""
    result = []
    try:
        for name, entry in folder_paths.folder_names_and_paths.items():
            if name in ("temp", "output"):
                continue
            paths = [os.path.abspath(p) for p in entry[0] if p]
            if paths:
                result.append({"name": name, "paths": paths})
        result.sort(key=lambda x: x["name"])
    except Exception:
        pass
    return result


def _all_registered_paths():
    """所有注册模型路径的白名单集合（归一化）"""
    out = set()
    try:
        for _name, entry in folder_paths.folder_names_and_paths.items():
            for p in entry[0]:
                if p:
                    out.add(os.path.normcase(os.path.realpath(os.path.abspath(p))))
    except Exception:
        pass
    return out


# 自定义路径黑名单（系统关键目录不允许作为下载目标）
_CUSTOM_DENY = re.compile(
    r"^[a-z]:\\(windows|program files( \(x86\))?|programdata)(\\|$)", re.I)


def _validate_custom_dir(dest_dir):
    """自定义路径校验：非系统关键目录、非盘符根。返回 (ok, error)"""
    try:
        rp = os.path.normcase(os.path.realpath(os.path.abspath(dest_dir)))
    except Exception:
        return False, "路径无效"
    drive, tail = os.path.splitdrive(rp)
    if not drive or not tail.strip("\\/"):
        return False, "不能选择盘符根目录，请选择一个子文件夹"
    if _CUSTOM_DENY.match(rp):
        return False, "不允许下载到系统关键目录（Windows/Program Files/ProgramData）"
    if "$recycle.bin" in rp:
        return False, "路径无效"
    return True, ""


def start_download(url, folder_type, filename=None, dest_dir=None):
    """启动一个下载任务。返回 {ok} 或 {error}。

    dest_dir: 可选。
      - 提供注册路径中的绝对路径 → 精确选择（同一目录名可能注册多个路径）
      - 提供自定义路径 → 通过黑名单校验后使用（任意文件夹）
      - 未提供 → 使用该 folder_type 注册的第一个路径
    """
    global _thread

    url = (url or "").strip()
    if not url.startswith("https://"):
        return {"error": "仅支持 https 下载链接"}

    with _lock:
        if _state["running"]:
            return {"error": "已有下载任务进行中，请等待完成或稍后再试"}

    # 目标目录：注册路径优先，其次用户自定义（黑名单校验）
    try:
        paths = folder_paths.get_folder_paths(folder_type)
    except Exception:
        paths = []

    if dest_dir:
        want = os.path.normcase(os.path.realpath(os.path.abspath(dest_dir)))
        registered = _all_registered_paths()
        if want in registered:
            dest_dir = os.path.abspath(dest_dir)
        else:
            ok, err = _validate_custom_dir(dest_dir)
            if not ok:
                return {"error": err}
            dest_dir = os.path.abspath(dest_dir)
    elif paths:
        dest_dir = os.path.abspath(paths[0])
    else:
        return {"error": "未知或不可用的模型目录: %s" % folder_type}

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
                # 预检：网页类响应直接拒绝（如 Civitai 未登录跳转、失效候选）
                ctype = (r.headers.get("Content-Type") or "").lower()
                if "text/html" in ctype:
                    raise RuntimeError("链接返回的是网页而不是文件（可能需要登录或候选已失效），请换其他候选来源")

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
                # 内容校验：拒绝网页 / Git LFS 指针等假文件（HTTP 200 但不是模型本体）
                head = b""
                try:
                    with open(part, "rb") as f2:
                        head = f2.read(512)
                except OSError:
                    pass
                low = head.lstrip()[:64].lower()
                if low.startswith((b"<!doctype", b"<html")) or head.startswith(b"version https://git-lfs"):
                    try:
                        os.remove(part)
                    except OSError:
                        pass
                    err = ("链接返回的是网页/占位文件而非模型本体"
                           "（候选可能需要登录或已失效），请换其他候选来源或手动下载")
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
