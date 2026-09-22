# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor
缺失节点/模型体检 + 下载地址推荐 + 老旧模型检索 + 安全清理

本插件不注册画布节点，通过菜单「🩺 体检清理」按钮打开面板，
并在 /md/* 提供 HTTP API。
"""

WEB_DIRECTORY = "./web/js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

MISSING_DOCTOR_VERSION = "1.1.0"

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

print(f"[MissingDoctor] v{MISSING_DOCTOR_VERSION} 加载中...")

try:
    from . import usage_tracker
    usage_tracker.install()
except Exception as e:
    print(f"[MissingDoctor] usage_tracker 初始化失败: {e}")

try:
    from . import api
    api.register_routes()
except Exception as e:  # 防止导入失败导致整个 ComfyUI 启动异常
    import traceback
    print(f"[MissingDoctor] API 注册失败（不影响 ComfyUI 启动）: {e}")
    traceback.print_exc()
