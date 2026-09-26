# -*- coding: utf-8 -*-
"""社区纠错表（本地）：wrong 候选降权 / correct 候选优先

用户对候选点击「🚩 不对」后写入，检测/搜索时自动应用：
- 被判定为"错误"的仓库/链接从该节点的候选中移除
- 被用户确认"正确"的来源优先置顶展示
数据仅存本机（.cache/corrections.json），可一键复制反馈内容供提交反馈。
"""

import json
import os
import threading
import time

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache", "corrections.json")

_lock = threading.Lock()
_loaded = False
_data = {"wrong": {}, "correct": {}}   # key(小写) -> {repo: ts}


def _now():
    return int(time.time())


def _load():
    global _loaded, _data
    with _lock:
        if _loaded:
            return _data
        try:
            if os.path.isfile(_PATH):
                with open(_PATH, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                _data = {
                    "wrong": raw.get("wrong", {}),
                    "correct": raw.get("correct", {}),
                }
        except Exception:
            _data = {"wrong": {}, "correct": {}}
        _loaded = True
        return _data


def _save():
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(_PATH, "w", encoding="utf-8") as f:
            json.dump(_data, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def mark_wrong(key, repo, source="user"):
    """把 (节点/模型 key → 仓库/链接) 标记为错误候选"""
    d = _load()
    with _lock:
        k = key.lower()
        d["wrong"].setdefault(k, {})[repo] = _now()
        d["correct"].get(k, {}).pop(repo, None)
        _save()


def mark_correct(key, repo, source="user"):
    """把 (节点/模型 key → 仓库/链接) 标记为用户确认的正确来源"""
    d = _load()
    with _lock:
        k = key.lower()
        d["correct"].setdefault(k, {})[repo] = _now()
        d["wrong"].get(k, {}).pop(repo, None)
        _save()


def wrong_repos(key):
    return set(_load()["wrong"].get(key.lower(), {}).keys())


def correct_repos(key):
    return set(_load()["correct"].get(key.lower(), {}).keys())


def export_report():
    """导出纠错报告文本（用户可复制反馈/发 Issue）"""
    d = _load()
    lines = []
    for k, repos in d.get("wrong", {}).items():
        for repo in repos:
            lines.append("[错误] %s -> %s" % (k, repo))
    for k, repos in d.get("correct", {}).items():
        for repo in repos:
            lines.append("[正确] %s -> %s" % (k, repo))
    return "\n".join(lines) or "（暂无纠错记录）"


def clear():
    global _data
    with _lock:
        _data = {"wrong": {}, "correct": {}}
        _save()