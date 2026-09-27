# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 模型目录映射（集成自 comfy-models-mapper 思想）

用 Windows 目录联接（Junction, mklink /J）把多个 ComfyUI 整合包的 models
统一映射到一份真实模型仓库，避免模型在多包重复占用硬盘。

安全机制（与 comfy-models-mapper 一致）：
- 不移动/复制/删除任何模型数据，只创建/删除链接本身
- 目标 models 非空 → 改名备份（models_backup_<ts>），绝不删除
- 删除链接用 os.rmdir（物理上无法递归删到目标内容）；非链接拒绝删除
- 防自映射 / 防链式映射（源本身是链接则拦截）
- 映射失败自动回滚（备份改回原位）
仅 Windows 可用。
"""

import os
import re
import subprocess
import time

import folder_paths

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def supported():
    return os.name == "nt"


def is_link(path):
    try:
        return bool(os.path.islink(path))
    except Exception:
        return False


def junction_target(path):
    """读取 Junction 指向的真实路径"""
    try:
        return os.path.realpath(path)
    except Exception:
        pass
    try:
        r = subprocess.run(["fsutil", "reparsepoint", "query", path],
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           creationflags=CREATE_NO_WINDOW)
        m = re.search(r"Print Name:\s+(.+)$", r.stdout, re.M)
        if m:
            return m.group(1).strip()
    except Exception:
        pass
    return None


def scan_installs():
    """扫描本机所有 ComfyUI 安装（当前实例 + 常见盘根整合包）+ models 状态"""
    found, seen = [], set()

    def add(comfy_path):
        try:
            real = os.path.normcase(os.path.realpath(os.path.abspath(comfy_path)))
        except Exception:
            return
        if real in seen:
            return
        seen.add(real)
        models = os.path.join(real, "models")
        st = {"path": real, "models": models, "status": "missing", "target": None}
        if os.path.isdir(models):
            if is_link(models):
                st["status"] = "linked"
                st["target"] = junction_target(models)
            else:
                st["status"] = "real"
        found.append(st)

    # 当前实例
    base = getattr(folder_paths, "base_path", None)
    if base:
        add(os.path.abspath(base))

    # 常见盘根下的整合包 / ComfyUI 目录
    for drive in ("C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", "I:\\"):
        if not os.path.exists(drive):
            continue
        try:
            names = os.listdir(drive)
        except OSError:
            continue
        for name in names:
            if "comfyui" not in name.lower():
                continue
            cand = os.path.join(drive, name)
            candidates = [os.path.join(cand, "ComfyUI"), cand]
            for c in candidates:
                try:
                    if os.path.isfile(os.path.join(c, "main.py")):
                        add(c)
                        break
                except OSError:
                    pass
    return found


def _mklink_j(target, link):
    try:
        r = subprocess.run(
            ["cmd", "/c", "mklink", "/J", '"%s"' % link, '"%s"' % target],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            creationflags=CREATE_NO_WINDOW)
        return r.returncode == 0
    except Exception:
        return False


def map_models(source, target_comfy):
    """把 target_comfy 的 models 映射到 source（真实模型仓库）。返回 {ok, done, errors}"""
    errors, done = [], []
    if not supported():
        return {"ok": False, "errors": ["仅支持 Windows（Junction）"]}
    try:
        src = os.path.abspath(source)
        models = os.path.join(os.path.abspath(target_comfy), "models")

        if not os.path.isdir(src):
            return {"ok": False, "errors": ["源目录不存在: %s" % source]}
        if is_link(src):
            return {"ok": False, "errors": ["源目录本身是链接，禁止链式映射: %s" % source]}

        # 防自映射：源与目标 models 指向同一物理位置
        if os.path.normcase(os.path.realpath(src)) == os.path.normcase(os.path.realpath(models)):
            return {"ok": False, "errors": ["源与目标相同，拒绝自映射"]}

        bak = None
        if os.path.isdir(models):
            if is_link(models):
                return {"ok": False, "errors": ["%s 已经是目录联接，先解除映射再操作" % models]}
            if os.listdir(models):
                bak = models + "_backup_" + time.strftime("%Y%m%d_%H%M%S")
                os.rename(models, bak)
                done.append("备份: %s → %s" % (models, bak))
            else:
                try:
                    os.rmdir(models)
                except OSError as e:
                    return {"ok": False, "errors": ["移除空目录失败: %s" % e]}
                done.append("移除空目录: %s" % models)

        if not _mklink_j(src, models):
            # 回滚
            if bak and os.path.isdir(bak) and not os.path.exists(models):
                os.rename(bak, models)
                done.append("回滚: %s → %s" % (bak, models))
            return {"ok": False, "errors": ["创建 Junction 失败（mklink /J 可能被拒绝，请检查权限）"]}

        done.append("映射: %s → %s" % (models, src))
        return {"ok": True, "done": done, "errors": errors}
    except Exception as e:
        return {"ok": False, "errors": ["映射异常: %s" % e]}


def unmap_models(target_comfy):
    """解除 models 目录联接（删除链接本身，不动目标内容）"""
    models = os.path.join(os.path.abspath(target_comfy), "models")
    if not os.path.isdir(models):
        return {"ok": False, "errors": ["%s 不存在" % models]}
    if not is_link(models):
        return {"ok": False, "errors": ["%s 不是目录联接，拒绝操作（不会误删真实目录）" % models]}
    try:
        os.rmdir(models)
        return {"ok": True, "done": ["已解除: %s" % models], "errors": []}
    except OSError as e:
        return {"ok": False, "errors": ["解除失败（可能被占用）: %s" % e]}


def restore_backup(target_comfy):
    """把 models_backup_* 还原为 models（当前 models 若为链接先解除）"""
    base = os.path.abspath(target_comfy)
    baks = sorted([os.path.join(base, n) for n in os.listdir(base)
                   if re.match(r"^models_backup_\d{8}_\d{6}$", n)])
    if not baks:
        return {"ok": False, "errors": ["没有找到 models_backup_* 备份"]}
    bak = baks[-1]
    models = os.path.join(base, "models")
    if os.path.isdir(models):
        if is_link(models):
            try:
                os.rmdir(models)
            except OSError as e:
                return {"ok": False, "errors": ["先解除当前链接失败: %s" % e]}
        else:
            return {"ok": False, "errors": ["models 已是真实目录，不能直接还原"]}
    try:
        os.rename(bak, models)
        return {"ok": True, "done": ["已还原: %s → %s" % (bak, models)], "errors": []}
    except OSError as e:
        return {"ok": False, "errors": ["还原失败: %s" % e]}