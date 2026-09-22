# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - pip 安装/卸载后台执行

- 使用 ComfyUI 自身的 Python（sys.executable -m pip），装对地方
- 后台线程执行，流式捕获输出（保留尾部 40 行供前端展示）
- 包名格式校验；卸载前由调用方（API 层）校验核心包黑名单
"""

import os
import re
import subprocess
import sys
import threading

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

_lock = threading.Lock()
_state = {
    "running": False,
    "done": False,
    "error": None,
    "exitcode": None,
    "cmd": None,
    "output_tail": [],
}
_thread = None

PKG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-\[\]]*(\s*[=<>!~]=?\s*[A-Za-z0-9._\-]+)*$")


def status():
    with _lock:
        s = dict(_state)
        s["output_tail"] = list(_state["output_tail"])
    return s


def _validate_package(p):
    p = (p or "").strip()
    if not p or len(p) > 300:
        return None
    # git+https 依赖
    if p.startswith("git+") and re.match(r"^git\+https://[^\s]+$", p):
        return p
    # 直链 wheel/tar（.whl / .tar.gz / .zip）
    if re.match(r"^https?://[^\s]+\.(whl|tar\.gz|zip)(\?.*)?$", p):
        return p
    if not PKG_RE.match(p):
        return None
    return p


def install_packages(packages):
    """pip install 多个包。返回 {ok, cmd} 或 {error}"""
    pkgs = []
    for p in packages or []:
        v = _validate_package(p)
        if not v:
            return {"error": "非法的包名: %r" % (p,)}
        pkgs.append(v)
    if not pkgs:
        return {"error": "未指定要安装的包"}
    return _run(["install", "--disable-pip-version-check", "--no-input"] + pkgs)


def install_requirements_file(path):
    """pip install -r <插件 requirements.txt>（路径须位于 custom_nodes 内）"""
    import folder_paths

    if not path or not os.path.isfile(path):
        return {"error": "requirements 文件不存在"}
    rp = os.path.normcase(os.path.realpath(os.path.abspath(path)))
    if os.path.basename(rp).lower() != "requirements.txt":
        return {"error": "仅允许安装 requirements.txt"}
    base = getattr(folder_paths, "base_path", None)
    if base:
        cn = os.path.normcase(os.path.realpath(os.path.join(os.path.abspath(base), "custom_nodes")))
        if not rp.startswith(cn + os.sep):
            return {"error": "路径不在 custom_nodes 内，已拒绝"}
    else:
        return {"error": "无法定位 custom_nodes 目录"}
    return _run(["install", "--disable-pip-version-check", "--no-input", "-r", rp])


def uninstall_package(name):
    """pip uninstall 单个包（兼容旧接口）"""
    return uninstall_packages([name])


def uninstall_packages(names):
    """pip uninstall 多个包（一条命令批量执行）"""
    pkgs = []
    for n in names or []:
        v = _validate_package(n)
        if not v:
            return {"error": "非法的包名: %r" % (n,)}
        pkgs.append(v)
    if not pkgs:
        return {"error": "未指定要卸载的包"}
    if len(pkgs) > 30:
        return {"error": "单次最多卸载 30 个包"}
    return _run(["uninstall", "-y", "--disable-pip-version-check"] + pkgs)


def _run(args):
    global _thread
    with _lock:
        if _state["running"]:
            return {"error": "pip 任务进行中，请等待完成"}
        _state.update({
            "running": True, "done": False, "error": None, "exitcode": None,
            "cmd": "python -m pip " + " ".join(args), "output_tail": [],
        })

    def worker():
        try:
            proc = subprocess.Popen(
                [sys.executable, "-m", "pip"] + args,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
                creationflags=CREATE_NO_WINDOW,
            )
            tail = []
            for line in proc.stdout or []:
                line = line.rstrip()
                if line:
                    tail.append(line)
                    if len(tail) > 60:
                        tail = tail[-60:]
                    with _lock:
                        _state["output_tail"] = tail[-40:]
            code = proc.wait()
            with _lock:
                _state["running"] = False
                _state["done"] = True
                _state["exitcode"] = code
                if code != 0:
                    _state["error"] = "pip 退出码 %d（详见输出）" % code
        except Exception as e:
            msg = str(e)
            # Windows 上已加载的 .pyd/DLL 无法删除，给出可执行的建议
            if "WinError 5" in msg or "拒绝访问" in msg or "PermissionError" in msg:
                msg = ("文件被 ComfyUI 进程占用（该包正在使用中，Windows 不允许删除已加载的模块）。"
                       "解决办法：重启 ComfyUI 后重试，或关闭 ComfyUI 后手动执行 pip uninstall")
            with _lock:
                _state.update(running=False, done=True, error=msg[:400])

    _thread = threading.Thread(target=worker, daemon=True, name="MissingDoctor-Pip")
    _thread.start()
    return {"ok": True, "cmd": _state["cmd"]}
