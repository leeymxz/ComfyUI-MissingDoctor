# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - Python 环境信息与依赖体检

1. 环境总览：Python / PyTorch / CUDA / GPU / 内存 / 磁盘空间 / 包数量
2. 插件依赖体检：扫描 custom_nodes/*/requirements.txt，找出缺失或版本不符的依赖
3. 重量级包扫描：按磁盘占用排序 site-packages，标记核心包（禁止卸载）

核心包名单自动来自 ComfyUI 根目录的 requirements.txt（卸了就崩的包）
+ 一组基础设施包，卸载接口会拒绝这些包。
"""

import os
import platform
import re
import sys
import time
import ctypes
import shutil
import posixpath

import folder_paths

_CACHE = {"req": {"t": 0, "data": None}, "heavy": {"t": 0, "data": None}}
CACHE_TTL = 600  # 扫描结果缓存 10 分钟

# 基础设施包（除 ComfyUI requirements 外，额外视为核心）
CORE_EXTRA = {
    "pip", "setuptools", "wheel", "send2trash", "requests", "urllib3",
    "gitpython", "websocket-client", "httpx", "certifi", "charset-normalizer",
    "comfyui", "comfyui-frontend-package", "comfyui-workflow-templates",
}


def _canon(name):
    """PEP 503 包名规范化"""
    return re.sub(r"[-_.]+", "-", str(name).strip().lower())


def _comfy_base():
    return getattr(folder_paths, "base_path", None)


def _custom_nodes_dir():
    base = _comfy_base()
    if base:
        return os.path.join(os.path.abspath(base), "custom_nodes")
    return None


def parse_requirements(path):
    """解析 requirements.txt，返回需求行列表（忽略注释与 -- 选项）"""
    reqs = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or line.startswith("-"):
                    continue
                line = line.split("#", 1)[0].strip()
                if line:
                    reqs.append(line)
    except OSError:
        pass
    return reqs


# 常见"特殊安装"包的提示（前端展示，帮助用户理解为何直接 pip 会失败）
KNOWN_HINTS = {
    "tensorrt": "TensorRT 需 NVIDIA 索引，建议手动: pip install tensorrt --extra-index-url https://pypi.nvidia.com",
    "nvidia-cudnn-cu12": "CUDA 库类包体积大且跟随 torch 版本，一般随 torch 自动安装",
    "flash-attn": "需要与 torch/CUDA 匹配的预编译轮子，建议从发布页下载对应 whl",
}


def split_requirement(req):
    """把 'pkg>=1.2' 拆成 (名称, 版本说明符或空)。

    git+https / 直链 whl 等 URL 依赖返回 (None, "")——由调用方按 kind=url 处理。
    """
    req = (req or "").strip()
    if req.startswith(("git+", "http://", "https://")):
        return None, ""
    m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._\-]*)\s*(.*)$", req)
    if not m:
        return None, ""
    name = m.group(1)
    spec = (m.group(2) or "").strip()
    # 去掉 extras：pkg[extra1,extra2]>=1.0
    if "[" in name:
        name = name.split("[", 1)[0]
    return name, spec


def _ver_tuple(ver):
    parts = re.findall(r"\d+", str(ver).split("+")[0])
    return tuple(int(p) for p in parts[:6])


def marker_applies(marker):
    """评估 requirements 环境标记（如 '; platform_system != "Windows"'）是否适用于当前平台。

    仅支持 and 连接的简单比较；复杂标记保守返回 True（pip 安装时会自行评估）。
    """
    if not marker:
        return True
    env = {
        "platform_system": "Windows" if sys.platform == "win32" else ("Darwin" if sys.platform == "darwin" else "Linux"),
        "platform_machine": platform.machine(),
        "sys_platform": sys.platform,
        "python_version": "%d.%d" % sys.version_info[:2],
        "python_full_version": "%d.%d.%d" % sys.version_info[:3],
    }
    for part in re.split(r"\s+and\s+", marker.strip()):
        part = part.strip()
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_.]*)\s*(==|!=|>=|<=|>|<)\s*[\"']?([^\"']*)[\"']?$", part)
        if not m:
            return True
        key, op, val = m.group(1), m.group(2), m.group(3)
        have = env.get(key)
        if have is None:
            return True
        if key in ("python_version", "python_full_version"):
            try:
                a, b = _ver_tuple(have), _ver_tuple(val)
                ok = {"==": a == b, "!=": a != b, ">=": a >= b,
                      "<=": a <= b, ">": a > b, "<": a < b}[op]
            except Exception:
                return True
        else:
            if op not in ("==", "!="):
                return True
            ok = (have.lower() == val.lower()) if op == "==" else (have.lower() != val.lower())
        if not ok:
            return False
    return True


def _spec_satisfied(installed, spec):
    """极简版本说明符判断（>= > == <= < ~=），解析不了返回 None（视为未知）"""
    if not spec:
        return True
    m = re.match(r"^(>=|<=|==|~=|>|<)\s*([\d\.]+)$", spec.replace(" ", ""))
    if not m:
        return None
    op, want = m.group(1), _ver_tuple(m.group(2))
    have = _ver_tuple(installed)
    try:
        if op == ">=":
            return have >= want
        if op == "<=":
            return have <= want
        if op == "==":
            return have == want
        if op == ">":
            return have > want
        if op == "<":
            return have < want
        if op == "~=":
            return have >= want and have[:len(want) - 1] == want[:len(want) - 1]
    except Exception:
        return None
    return None


def core_packages():
    """核心包集合（canonical 名）：ComfyUI requirements + 基础设施"""
    cores = {_canon(x) for x in CORE_EXTRA}
    base = _comfy_base()
    if base:
        req = os.path.join(os.path.abspath(base), "requirements.txt")
        for line in parse_requirements(req):
            name, _ = split_requirement(line)
            if name:
                cores.add(_canon(name))
    return cores


# ---------------------------------------------------------------- 环境总览

def env_summary():
    s = {
        "python": sys.version.split()[0],
        "python_path": sys.executable,
        "platform": sys.platform,
    }

    # ComfyUI 版本
    try:
        import comfyui_version  # noqa
        s["comfyui"] = getattr(comfyui_version, "__version__", "unknown")
    except Exception:
        s["comfyui"] = "unknown"

    # PyTorch / CUDA / GPU（ComfyUI 进程内已加载，秒回）
    try:
        import torch
        s["torch"] = torch.__version__
        s["cuda_available"] = bool(torch.cuda.is_available())
        if torch.cuda.is_available():
            s["cuda"] = torch.version.cuda
            s["gpu"] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            s["vram_total_gb"] = round(props.total_memory / 1024 ** 3, 1)
    except Exception as e:
        s["torch"] = "不可用: " + str(e)[:100]

    # 内存（Windows）
    if sys.platform == "win32":
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            st = MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            s["mem_total_gb"] = round(st.ullTotalPhys / 1024 ** 3, 1)
            s["mem_avail_gb"] = round(st.ullAvailPhys / 1024 ** 3, 1)
            s["mem_load"] = st.dwMemoryLoad
        except Exception:
            pass

    # 磁盘：聚合所有注册模型目录与主目录所在盘
    roots = set()
    try:
        for _name, entry in folder_paths.folder_names_and_paths.items():
            for p in entry[0]:
                roots.add(p)
    except Exception:
        pass
    base = _comfy_base()
    if base:
        roots.add(base)
        roots.add(os.path.join(os.path.abspath(base), "custom_nodes"))

    disks = {}
    for p in roots:
        try:
            drive = posixpath.normpath(os.path.splitdrive(os.path.abspath(p))[0] + "\\")
        except Exception:
            continue
        if drive and drive not in disks and os.path.isdir(drive):
            try:
                u = shutil.disk_usage(drive)
                disks[drive] = {
                    "free_gb": round(u.free / 1024 ** 3, 1),
                    "total_gb": round(u.total / 1024 ** 3, 1),
                }
            except OSError:
                pass
    s["disks"] = disks

    # 已安装包数量
    try:
        import importlib.metadata as md
        s["package_count"] = len(list(md.distributions()))
    except Exception:
        pass

    return s


# ---------------------------------------------------------------- 依赖体检

def scan_requirements(force=False):
    """扫描 custom_nodes/*/requirements.txt，报告缺失/版本不符的依赖"""
    cache = _CACHE["req"]
    if not force and cache["data"] is not None and time.time() - cache["t"] < CACHE_TTL:
        return cache["data"]

    import importlib.metadata as md

    nodes_dir = _custom_nodes_dir()
    items = []
    if nodes_dir and os.path.isdir(nodes_dir):
        for plugin in sorted(os.listdir(nodes_dir)):
            rq = os.path.join(nodes_dir, plugin, "requirements.txt")
            if not os.path.isfile(rq):
                continue
            for line in parse_requirements(rq):
                # 拆分环境标记：pkg>=1.0 ; python_version >= "3.10"
                if ";" in line:
                    req_part, marker = line.split(";", 1)
                    req_part, marker = req_part.strip(), marker.strip()
                else:
                    req_part, marker = line, ""
                if not marker_applies(marker):
                    continue  # 不适用于当前平台的条件依赖（如 aarch64 专用）跳过

                # git+https / 直链 whl 等 URL 依赖：无法离线判断安装状态，
                # 标记 kind=url 单独列出，由用户逐个安装
                if req_part.startswith(("git+", "http://", "https://")):
                    items.append({
                        "plugin": plugin,
                        "requirement": req_part,
                        "name": req_part,
                        "installed": None,
                        "missing": False,
                        "version_ok": None,
                        "kind": "url",
                        "core": False,
                        "hint": "",
                    })
                    continue

                name, spec = split_requirement(req_part)
                if not name:
                    continue
                installed = None
                try:
                    installed = md.version(name)
                except Exception:
                    installed = None
                ok = None
                if installed is not None:
                    ok = _spec_satisfied(installed, spec)
                items.append({
                    "plugin": plugin,
                    "requirement": req_part,
                    "name": name,
                    "installed": installed,
                    "missing": installed is None,
                    "version_ok": ok,
                    "kind": "pypi",
                    "core": _canon(name) in core_packages(),
                    "hint": KNOWN_HINTS.get(_canon(name), ""),
                })

    data = {"items": items,
            "missing_count": sum(1 for i in items if i["missing"]),
            "warn_count": sum(1 for i in items if not i["missing"] and i["version_ok"] is False),
            "plugin_count": len({i["plugin"] for i in items})}
    _CACHE["req"] = {"t": time.time(), "data": data}
    return data


# ---------------------------------------------------------------- 重量级包

def heavy_packages(top=25, force=False):
    cache = _CACHE["heavy"]
    if not force and cache["data"] is not None and time.time() - cache["t"] < CACHE_TTL:
        return cache["data"]

    import importlib.metadata as md

    started = time.time()
    sizes = {}
    for dist in md.distributions():
        try:
            name = dist.metadata["Name"]
            ver = dist.metadata["Version"] or ""
            if not name:
                continue
            total = 0
            for f in (dist.files or []):
                try:
                    p = str(dist.locate_file(f))
                    if p and os.path.isfile(p):
                        total += os.path.getsize(p)
                except OSError:
                    continue
            key = _canon(name)
            if key not in sizes or total > sizes[key]["size"]:
                sizes[key] = {"name": name, "version": ver, "size": total}
        except Exception:
            continue

    cores = core_packages()
    data = sorted(sizes.values(), key=lambda x: -x["size"])[: max(1, min(int(top), 100))]
    for d in data:
        d["core"] = _canon(d["name"]) in cores
        d["size_str"] = "%.1f MB" % (d["size"] / 1024 / 1024) if d["size"] >= 1024 * 1024 \
            else "%.0f KB" % (d["size"] / 1024)

    result = {"items": data, "scan_seconds": round(time.time() - started, 1),
              "total_packages": len(sizes)}
    _CACHE["heavy"] = {"t": time.time(), "data": result}
    return result
