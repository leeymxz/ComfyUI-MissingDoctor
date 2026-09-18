# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 缺失节点自动安装器

对检测出的缺失节点候选仓库执行 git clone 到 custom_nodes：
- 任务队列串行执行，支持批量（一键安装全部）
- 安全校验：git 可用性、https 协议、托管域名白名单、目录名净化、重名跳过
- 浅克隆 --depth 1 加速，10 分钟超时保护
- 安装完成后需重启 ComfyUI 加载新节点（前端会提示）
"""

import os
import re
import shutil
import subprocess
import threading

import folder_paths

CREATE_NO_WINDOW = 0x08000000  # Windows 下不弹黑窗
CLONE_TIMEOUT = 600            # 单仓库克隆超时（秒）
ALLOWED_HOSTS = (
    "github.com", "gitlab.com", "gitee.com",
    "www.github.com", "www.gitlab.com", "www.gitee.com",
    "huggingface.co", "hf-mirror.com", "gitcode.com", "gitea.com",
)


def git_available():
    return bool(shutil.which("git"))


def _custom_nodes_dir():
    base = getattr(folder_paths, "base_path", None)
    if base:
        return os.path.join(os.path.abspath(base), "custom_nodes")
    try:
        paths = folder_paths.get_folder_paths("custom_nodes")
        if paths:
            return os.path.abspath(paths[0])
    except Exception:
        pass
    return os.path.join(os.getcwd(), "custom_nodes")


def _repo_name(url):
    name = url.rstrip("/").rsplit("/", 1)[-1]
    if name.endswith(".git"):
        name = name[:-4]
    return re.sub(r'[\\/:*?"<>|\s]+', "_", name).strip("._") or "unknown_repo"


def _validate_url(url):
    """返回 (ok, error)"""
    if not isinstance(url, str) or not url.strip():
        return False, "仓库地址为空"
    url = url.strip()
    if not url.startswith("https://"):
        return False, "仅支持 https 仓库地址"
    m = re.match(r"https://([^/]+)/([^/]+)/([^/]+)", url)
    if not m:
        return False, "仓库地址格式无效"
    host = m.group(1).lower()
    if host not in ALLOWED_HOSTS:
        return False, "仅支持常见托管平台（github/gitlab/gitee 等）: " + host
    return True, ""


_lock = threading.Lock()
_jobs = []          # [{url, title, name, target, status, error}]
_running = False
_thread = None

STATUS_PENDING = "pending"
STATUS_CLONING = "cloning"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_EXISTS = "exists"


def status():
    with _lock:
        jobs = [dict(j) for j in _jobs]
        running = _running
    return {
        "running": running,
        "git_available": git_available(),
        "jobs": jobs,
        "total": len(jobs),
        "done_count": sum(1 for j in jobs if j["status"] in (STATUS_DONE, STATUS_EXISTS, STATUS_FAILED)),
    }


def start_install(items):
    """items: [{url, title}]。返回 {ok, count} 或 {error}"""
    global _thread, _running, _jobs

    if not git_available():
        return {"error": "未检测到 git，请先安装 git（https://git-scm.com）并重启 ComfyUI"}

    with _lock:
        if _running:
            return {"error": "安装任务进行中，请等待完成"}

        jobs = []
        seen = set()
        nodes_dir = _custom_nodes_dir()
        if not os.path.isdir(nodes_dir):
            try:
                os.makedirs(nodes_dir, exist_ok=True)
            except OSError as e:
                return {"error": "custom_nodes 目录不可用: %s" % e}

        for it in items or []:
            url = (it or {}).get("url", "").strip()
            ok, err = _validate_url(url)
            if not ok:
                continue
            if url in seen:
                continue
            seen.add(url)
            name = _repo_name(url)
            target = os.path.join(nodes_dir, name)
            if os.path.exists(target):
                jobs.append({"url": url, "title": (it or {}).get("title") or name,
                             "name": name, "target": target, "status": STATUS_EXISTS, "error": None})
                continue
            jobs.append({"url": url, "title": (it or {}).get("title") or name,
                         "name": name, "target": target, "status": STATUS_PENDING, "error": None})

        if not jobs:
            return {"error": "没有可安装的仓库（地址无效或均已安装）"}

        _jobs = jobs
        _running = True

    def worker():
        global _running
        for job in _jobs:
            if job["status"] == STATUS_EXISTS:
                continue
            with _lock:
                job["status"] = STATUS_CLONING
            try:
                cmd = ["git", "clone", "--depth", "1", "--progress", job["url"], job["target"]]
                proc = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=CLONE_TIMEOUT,
                    encoding="utf-8", errors="replace",
                    creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                with _lock:
                    if proc.returncode == 0:
                        job["status"] = STATUS_DONE
                    else:
                        job["status"] = STATUS_FAILED
                        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
                        job["error"] = tail[-1][:300] if tail else ("git 返回码 %s" % proc.returncode)
                        # 失败时清理半成品目录
                        try:
                            if os.path.isdir(job["target"]) and not os.listdir(job["target"]):
                                os.rmdir(job["target"])
                        except OSError:
                            pass
            except subprocess.TimeoutExpired:
                with _lock:
                    job["status"] = STATUS_FAILED
                    job["error"] = "克隆超时（%d 秒）" % CLONE_TIMEOUT
            except FileNotFoundError:
                with _lock:
                    job["status"] = STATUS_FAILED
                    job["error"] = "git 命令不可用"
            except Exception as e:
                with _lock:
                    job["status"] = STATUS_FAILED
                    job["error"] = str(e)[:300]

        with _lock:
            _running = False

    _thread = threading.Thread(target=worker, daemon=True, name="MissingDoctor-Installer")
    _thread.start()
    return {"ok": True, "count": len(_jobs)}
