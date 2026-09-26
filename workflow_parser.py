# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 工作流解析器

解析 ComfyUI 工作流的两种格式：
- API / prompt 格式: {node_id: {"class_type": ..., "inputs": {...}}}
- UI 格式: {"nodes": [...], "links": [...], ...}

提取：节点类型列表 + 疑似模型文件引用（供缺失模型检测使用）
"""

import os

# 认可的模型文件扩展名
MODEL_EXTS = {
    ".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf",
    ".onnx", ".sft", ".engine", ".trt", ".pt2",
}

# 前端 UI 专属节点（不属于后端执行流，不应参与缺失检测）
UI_ONLY_NODES = {
    "Note", "MarkdownNote", "Reroute", "PrimitiveNode",
    "PrimitiveString", "PrimitiveStringMultiline", "ComfyUINoteNode",
    # rgthree 的纯前端虚拟节点（无需后端安装）
    "Fast Groups Bypasser (rgthree)", "Label (rgthree)",
    "Fast Bypasser (rgthree)", "Mute/Bypass Repeater (rgthree)",
}

# 常见输入名 -> 可能的模型目录
# 一个输入名有多个候选目录，是因为新旧版本 ComfyUI 目录名不同
# （例如 clip -> text_encoders，unet -> diffusion_models）
INPUT_TO_FOLDER = {
    "ckpt_name": ["checkpoints"],
    "lora_name": ["loras"],
    "lora_name_1": ["loras"],
    "lora_name_2": ["loras"],
    "lora_name_3": ["loras"],
    "lora_stack_1": ["loras"],
    "vae_name": ["vae"],
    "taesd_name": ["vae"],
    "taesd_encoder_name": ["vae"],
    "taesd_decoder_name": ["vae"],
    "control_net_name": ["controlnet"],
    "control_net_name1": ["controlnet"],
    "control_net_name2": ["controlnet"],
    "controlnet_name": ["controlnet"],
    "unet_name": ["unet", "diffusion_models"],
    "unet_name1": ["unet", "diffusion_models"],
    "unet_name2": ["unet", "diffusion_models"],
    "diffusion_model_name": ["diffusion_models"],
    "model_name": ["upscale_models", "diffusion_models", "unet", "sams"],
    "clip_name": ["text_encoders", "clip"],
    "clip_name1": ["text_encoders", "clip"],
    "clip_name2": ["text_encoders", "clip"],
    "clip_name3": ["text_encoders", "clip"],
    "clip_vision_name": ["clip_vision"],
    "style_model_name": ["style_models"],
    "gligen_name": ["gligen"],
    "hypernetwork_name": ["hypernetworks"],
    "photomaker_name": ["photomaker"],
    "sam_model_name": ["sams"],
    "sam_model": ["sams"],
    "bbox_model_name": ["ultralytics_bbox"],
    "segm_model_name": ["ultralytics_segm"],
    "ultralytics_model_name": ["ultralytics_bbox", "ultralytics_segm"],
    "upscale_model_name": ["upscale_models"],
}


def is_model_file(name):
    """判断字符串是否疑似模型文件名"""
    if not isinstance(name, str):
        return False
    return os.path.splitext(name.strip())[1].lower() in MODEL_EXTS


def extract_from_prompt(prompt):
    """从 API/prompt 格式提取节点类型与模型引用。

    返回 (class_types, model_refs)
    model_refs 元素: {"value", "inputs", "node_ids", "folders_hint"}
    """
    class_types = []
    refs = {}
    if not isinstance(prompt, dict):
        return class_types, []

    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        # 过滤前端 UI 节点（Note/便签等不参与后端执行，不应报缺失）
        if ct and str(ct) in UI_ONLY_NODES:
            continue
        if ct:
            class_types.append(str(ct))

        inputs = node.get("inputs") or {}
        for k, v in inputs.items():
            # link 引用形如 "[12, 0]"，跳过
            if not isinstance(v, str) or v.startswith("["):
                continue
            if not is_model_file(v):
                continue
            key = v.lower()
            hint = INPUT_TO_FOLDER.get(k, [])
            if key not in refs:
                refs[key] = {"value": v, "inputs": [], "node_ids": [], "folders_hint": []}
            refs[key]["inputs"].append(k)
            refs[key]["node_ids"].append(str(node_id))
            for h in hint:
                if h not in refs[key]["folders_hint"]:
                    refs[key]["folders_hint"].append(h)

    return class_types, list(refs.values())


def extract_from_ui(ui_workflow):
    """从 UI 格式工作流提取（widgets_values 启发式，作为兜底）。

    返回 (class_types, model_refs)，结构同上。
    """
    class_types = []
    refs = {}
    if not isinstance(ui_workflow, dict):
        return class_types, []

    for node in ui_workflow.get("nodes", []) or []:
        if not isinstance(node, dict):
            continue
        ct = node.get("type")
        if ct and str(ct) in UI_ONLY_NODES:
            continue
        if ct:
            class_types.append(str(ct))

        wv = node.get("widgets_values")
        values = []
        if isinstance(wv, list):
            values = [x for x in wv if isinstance(x, str)]
        elif isinstance(wv, dict):
            values = [x for x in wv.values() if isinstance(x, str)]

        for v in values:
            if not is_model_file(v):
                continue
            key = v.lower()
            if key not in refs:
                refs[key] = {
                    "value": v,
                    "inputs": ["(widgets_values)"],
                    "node_ids": [str(node.get("id"))],
                    "folders_hint": [],
                }

    return class_types, list(refs.values())


def parse_workflow(workflow):
    """统一入口：接受 {"prompt":..., "ui":...} / 只有其中一种 / 直接是 prompt dict。

    返回 (class_types, model_refs)，两个来源的结果已合并去重。
    """
    class_types, refs = [], []

    if isinstance(workflow, dict):
        prompt = workflow.get("prompt")
        ui = workflow.get("ui")
        # 兼容直接传 API 格式（顶层含 class_type 的节点 dict）
        if prompt is None and ui is None and workflow:
            sample = next(iter(workflow.values()), None)
            if isinstance(sample, dict) and "class_type" in sample:
                prompt = workflow

        if prompt:
            ct, r = extract_from_prompt(prompt)
            class_types += ct
            refs += r
        if ui:
            ct_ui, r_ui = extract_from_ui(ui)
            # class_type 以 prompt（API 格式）为准——UI 格式会混入前端虚拟节点
            # （如 rgthree 的 Label/Fast Groups Bypasser，纯前端实现无需安装）
            # 导致误报缺失。仅当 prompt 不可用时才采用 UI 的节点类型。
            if not ct:
                class_types += ct_ui
            merged = {x["value"].lower(): x for x in refs}
            for item in r_ui:
                k = item["value"].lower()
                if k in merged:
                    for f in item["folders_hint"]:
                        if f not in merged[k]["folders_hint"]:
                            merged[k]["folders_hint"].append(f)
                else:
                    merged[k] = item
            refs = list(merged.values())
    elif isinstance(workflow, str):
        import json
        try:
            return parse_workflow(json.loads(workflow))
        except Exception:
            return [], []

    return class_types, refs
