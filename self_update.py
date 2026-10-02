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


def get_capability():
    """一键更新能力检测：插件是否为 git 仓库 + 系统是否安装 git"""
    import shutil
    return {
        "is_git_repo": _is_git_repo(),
        "git_installed": bool(shutil.which("git")),
        "plugin_dir": _plugin_dir(),
    }


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


# 连接类错误关键词（命中则尝试代理/镜像兜底，而不是直接失败）
_NET_ERR_KEYWORDS = ("curl 28", "could not connect", "timed out", "connection refused",
                     "could not resolve", "rpc failed", "ssl", "network", "reset")

# 国内可达的 GitHub 加速镜像（只用于 fetch/pull 命令行，不修改用户 remote 配置）
MIRROR_URLS = [
    "https://ghproxy.net/https://github.com/leeymxz/ComfyUI-MissingDoctor.git",
    "https://gh-proxy.com/https://github.com/leeymxz/ComfyUI-MissingDoctor.git",
]

# 常见本机代理端口（Clash 7890 / Clash Verge 7897 / v2rayN 10809 / 常规 1080 等）
_PROXY_PORTS = [7890, 7897, 10809, 1080, 8118, 8889]


def _is_network_error(out):
    low = (out or "").lower()
    return any(k in low for k in _NET_ERR_KEYWORDS)


def _detect_working_proxy():
    """探测环境变量代理 + 本机常见代理端口，返回真实可连 GitHub 的代理 URL 或 None"""
    candidates = []
    for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        v = os.environ.get(k)
        if v:
            candidates.append(v)
            break
    candidates += ["http://127.0.0.1:%d" % p for p in _PROXY_PORTS]
    try:
        import requests as _rq
    except Exception:
        return None
    for proxy in candidates:
        try:
            # 端口开着不代表能翻出去，真实访问一次 github.com 验证
            _rq.head("https://github.com", proxies={"http": proxy, "https": proxy},
                     timeout=4, allow_redirects=False)
            return proxy
        except Exception:
            continue
    return None


def _do_pull():
    try:
        cwd = _plugin_dir()
        log_lines = []

        def run(args, timeout=None):
            p = subprocess.run(
                ["git"] + args, cwd=cwd, capture_output=True, text=True,
                timeout=timeout or PULL_TIMEOUT, creationflags=CREATE_NO_WINDOW,
                encoding="utf-8", errors="replace")
            out = ((p.stdout or "") + (p.stderr or "")).strip()
            log_lines.append("$ git " + " ".join(args))
            log_lines.extend(out.splitlines()[:20])
            _set(log="\n".join(log_lines))
            return p.returncode, out

        def finish_done():
            nv = _read_version()
            _set(status=STATUS_DONE, new_version=nv,
                 finished_at=time_str(), log="\n".join(log_lines))

        # 1. 确认远端地址指向本仓库（防呆：fork/镜像也能 pull，只做提示）
        run(["remote", "get-url", "origin"])

        # 2. 直连 git pull --ff-only（拒绝合并/变基，本地有修改时直接失败而非覆盖）
        code, out = run(["pull", "--ff-only"])
        if code == 0:
            finish_done()
            return

        # 本地改动冲突：换网络也解决不了，直接给指引
        low_out = (out or "").lower()
        if "not possible" in low_out or "diverged" in low_out:
            _set(status=STATUS_FAILED,
                 error="本地有改动与远端冲突。如无重要修改，可删除插件目录后重新 git clone",
                 finished_at=time_str(), log="\n".join(log_lines))
            return

        # 3. 网络类失败 → 代理兜底：探测本机可用代理后带代理重试
        if _is_network_error(out):
            log_lines.append("-- 直连失败，正在探测本机代理...")
            _set(log="\n".join(log_lines))
            proxy = _detect_working_proxy()
            if proxy:
                log_lines.append("-- 使用代理 %s 重试" % proxy)
                code, out = run(["-c", "http.proxy=" + proxy, "-c", "https.proxy=" + proxy,
                                 "pull", "--ff-only"])
                if code == 0:
                    finish_done()
                    return

            # 4. 代理不可用/仍失败 → 镜像站兜底（不改用户 remote 配置）
            for mirror in MIRROR_URLS:
                log_lines.append("-- 尝试镜像: %s" % mirror.split("/https://")[0])
                _set(log="\n".join(log_lines))
                code, out = run(["pull", mirror, "main", "--ff-only"], timeout=90)
                if code == 0:
                    finish_done()
                    return

            _set(status=STATUS_FAILED,
                 error="直连/代理/镜像均失败：网络无法访问 GitHub。可手动下载 Release zip 覆盖安装",
                 finished_at=time_str(), log="\n".join(log_lines))
            return

        # 非网络类失败（--ff-only 等其他 git 错误）
        _set(status=STATUS_FAILED,
             error="git pull 失败（--ff-only 模式不会覆盖本地修改）",
             finished_at=time_str(), log="\n".join(log_lines))
    except subprocess.TimeoutExpired:
        _set(status=STATUS_FAILED, error="git pull 超时（%ds），网络较慢，请稍后重试" % PULL_TIMEOUT,
             finished_at=time_str())
    except Exception as e:
        _set(status=STATUS_FAILED, error=str(e)[:200], finished_at=time_str())
