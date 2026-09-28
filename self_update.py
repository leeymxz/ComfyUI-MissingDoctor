# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 插件自更新（一键更新）

在插件自身目录执行 git pull --ff-only：
- 安全约束：仅更新插件目录自身；--ff-only 拒绝覆盖本地修改（有冲突直接失败而非强推）
- 后台线程执行，120s 超时保护；不执行仓库内任何脚本，更新后由用户重启 ComfyUI 生效
- 状态查询供前端轮询（模式与 installer 一致）
"""

import os
import re
import subprocess
import threading

CREATE_NO_WINDOW = 0x08000000  # Windows 下不弹黑窗
PULL_TIMEOUT = 120             # git pull 超时（秒）
REPO_URL = "https://github.com/leeymxz/ComfyUI-MissingDoctor"

STATUS_IDLE = "idle"
STATUS_PULLING = "pulling"
STATUS_DONE = "done"
STATUS_FAILED = "failed"

_lock = threading.Lock()
_state = {
    "status": STATUS_IDLE,
    "log": "",
    "error": "",
    "started_at": "",
    "finished_at": "",
    "new_version": "",   # pull 成功后从 version.py 读取
}


def _plugin_dir():
    return os.path.dirname(os.path.abspath(__file__))


def _is_git_repo():
    return os.path.isdir(os.path.join(_plugin_dir(), ".git"))


def _read_version():
    """从 version.py 读版本号（pull 后重新读取）"""
    try:
        path = os.path.join(_plugin_dir(), "version.py")
        with open(path, "r", encoding="utf-8") as f:
            m = re.search(r'VERSION\s*=\s*["\']([^"\']+)["\']', f.read())
        return m.group(1) if m else ""
    except Exception:
        return ""


def _set(**kw):
    with _lock:
        _state.update(kw)


def get_status():
    with _lock:
        return dict(_state)


def start_update():
    """启动自更新（幂等：进行中时拒绝重复启动）。返回 (ok, message)。"""
    with _lock:
        if _state["status"] == STATUS_PULLING:
            return False, "更新正在进行中，请稍候"
    if not _is_git_repo():
        return False, "插件目录不是 git 仓库（可能是手动解压安装），请按 README 重新 git clone"
    import shutil
    if not shutil.which("git"):
        return False, "未找到 git 命令，请先安装 Git"

    _set(status=STATUS_PULLING, log="", error="",
         started_at=time_str(), finished_at="", new_version="")
    t = threading.Thread(target=_do_pull, daemon=True)
    t.start()
    return True, "更新已启动"


def time_str():
    import time as _t
    return _t.strftime("%H:%M:%S")


def _do_pull():
    try:
        cwd = _plugin_dir()
        log_lines = []

        def run(args):
            p = subprocess.run(
                ["git"] + args, cwd=cwd, capture_output=True, text=True,
                timeout=PULL_TIMEOUT, creationflags=CREATE_NO_WINDOW,
                encoding="utf-8", errors="replace")
            out = ((p.stdout or "") + (p.stderr or "")).strip()
            log_lines.append("$ git " + " ".join(args))
            log_lines.extend(out.splitlines()[:20])
            return p.returncode, out

        # 1. 确认远端地址指向本仓库（防呆：fork/镜像也能 pull，只做提示）
        _code, remote_out = run(["remote", "get-url", "origin"])
        _set(log="\n".join(log_lines))

        # 2. git pull --ff-only（拒绝合并/变基，本地有修改时直接失败而非覆盖）
        code, out = run(["pull", "--ff-only"])
        _set(log="\n".join(log_lines))
        if code != 0:
            hint = "git pull 失败（--ff-only 模式不会覆盖本地修改）"
            if "not possible" in out or "diverged" in out.lower():
                hint = "本地有改动与远端冲突。如无重要修改，可删除插件目录后重新 git clone"
            elif "network" in out.lower() or "timed out" in out.lower() or "Could not resolve" in out:
                hint = "网络连接 GitHub 失败，请检查网络/代理后重试"
            _set(status=STATUS_FAILED, error=hint,
                 finished_at=time_str(), log="\n".join(log_lines))
            return

        # 3. 读取新版本号
        nv = _read_version()
        _set(status=STATUS_DONE, new_version=nv,
             finished_at=time_str(), log="\n".join(log_lines))
    except subprocess.TimeoutExpired:
        _set(status=STATUS_FAILED, error="git pull 超时（%ds），网络较慢，请稍后重试" % PULL_TIMEOUT,
             finished_at=time_str())
    except Exception as e:
        _set(status=STATUS_FAILED, error=str(e)[:200], finished_at=time_str())
