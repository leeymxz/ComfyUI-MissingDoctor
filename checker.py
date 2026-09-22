# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 缺失检测核心

1. 缺失节点检测：对比工作流引用的 class_type 与当前已注册的 NODE_CLASS_MAPPINGS
2. 缺失模型检测：对比工作流引用的模型文件与 folder_paths 注册目录中的实际文件
"""

import folder_paths
import nodes as comfy_nodes

from .workflow_parser import parse_workflow


def installed_node_names():
    """当前已注册的节点类名集合"""
    try:
        return set(comfy_nodes.NODE_CLASS_MAPPINGS.keys())
    except Exception:
        return set()


def _all_folder_lists():
    """{目录名: [文件名列表]}，folder_paths.get_filename_list 自带缓存"""
    out = {}
    try:
        names = list(folder_paths.folder_names_and_paths.keys())
    except Exception:
        names = []
    for fn in names:
        try:
            out[fn] = folder_paths.get_filename_list(fn)
        except Exception:
            out[fn] = []
    return out


def _find_file_in_folders(value, folder_names, lower_lists):
    """在指定目录集合中查找文件名（Windows 文件系统大小写不敏感，统一 lower 比对）"""
    v = value.lower()
    found = []
    for fn in folder_names:
        if v in lower_lists.get(fn, ()):
            found.append(fn)
    return found


def check_missing_nodes(workflow):
    """检测工作流中缺失的节点类型"""
    class_types, _ = parse_workflow(workflow)
    installed = installed_node_names()
    used = sorted(set(class_types))
    missing_types = sorted(set(used) - installed)
    return {
        "used_nodes": used,
        "missing_nodes": missing_types,
        "installed_count": len(installed),
        "used_count": len(used),
        "missing_count": len(missing_types),
    }


def check_missing_models(workflow):
    """检测工作流中缺失的模型文件

    返回:
    {
      "missing_models": [{value, inputs, node_ids, folders_hint, folders: []}],
      "found_count", "missing_count", "checked_values"
    }
    """
    _, refs = parse_workflow(workflow)
    lists = _all_folder_lists()
    # 大小写不敏感匹配（Windows 文件系统特性）
    lower_lists = {fn: frozenset(n.lower() for n in names) for fn, names in lists.items()}
    all_folder_names = list(lower_lists.keys())

    missing, found = [], 0
    for ref in refs:
        value = ref["value"]
        hints = ref.get("folders_hint") or []
        # 优先在提示目录中找，找不到再全目录兜底（避免新版/旧版目录名差异漏报）
        search_dirs = hints if hints else all_folder_names
        hit = _find_file_in_folders(value.lower(), search_dirs, lower_lists)
        if not hit:
            hit = _find_file_in_folders(value.lower(), all_folder_names, lower_lists)

        if hit:
            found += 1
            ref["folders"] = hit
        else:
            ref["folders"] = []
            missing.append(ref)

    return {
        "missing_models": missing,
        "found_count": found,
        "missing_count": len(missing),
        "checked_values": len(refs),
    }
