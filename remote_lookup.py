# -*- coding: utf-8 -*-
"""
ComfyUI-MissingDoctor - 远程下载地址查询

数据来源（按优先级）：
1. ComfyUI-Manager extension-node-map.json（节点类名 -> GitHub 仓库）
2. ComfyUI-Manager model-db.json（模型文件名 -> 官方下载地址，尽力匹配）
3. Civitai API（按关键词搜索模型）
4. HuggingFace API（按关键词搜索模型仓库）
5. GitHub Search API（缺失节点仓库搜索兜底）

全部带本地缓存（24h TTL）与超时容错，网络不可用时不阻塞检测结果。
"""

import os
import re
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout
from urllib.parse import quote, urlencode

try:
    import requests
    _HAS_REQUESTS = True
except Exception:  # pragma: no cover
    import urllib.request
    _HAS_REQUESTS = False

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
CACHE_TTL = 24 * 3600
NEG_TTL = 600          # 负缓存/搜索结果短缓存（10 分钟），避免弱网下反复超时
HTTP_TIMEOUT = 10      # 单请求超时，弱网下快速失败
QUERY_BUDGET = 25.0    # 单文件下载建议的总预算（秒），并行查询也整体受控
_UA = {"User-Agent": "ComfyUI-MissingDoctor/1.0"}

MANAGER_RAW_URLS = [
    "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/extension-node-map.json",
    "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/extension-node-map.json",
]
MODEL_DB_URLS = [
    "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/model-db.json",
    "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-db.json",
]

CIVITAI_TYPE_MAP = {
    "checkpoints": "Checkpoint",
    "loras": "LORA",
    "vae": "VAE",
    "controlnet": "Controlnet",
    "embeddings": "TextualInversion",
    "upscale_models": "Upscale",
    "hypernetworks": "Hypernetwork",
    "text_encoders": "Checkpoint",
}


# ---------------------------------------------------------------- 基础 HTTP

def _http_get_json(url):
    if _HAS_REQUESTS:
        r = requests.get(url, timeout=HTTP_TIMEOUT, headers=_UA)
        r.raise_for_status()
        return r.json()
    req = urllib.request.Request(url, headers=_UA)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _cache_path(key):
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, re.sub(r"[^a-zA-Z0-9_.-]", "_", key) + ".json")


def _load_cache(key, ttl=None):
    try:
        p = _cache_path(key)
        if time.time() - os.path.getmtime(p) < (ttl if ttl is not None else CACHE_TTL):
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return None


def _save_cache(key, data):
    try:
        with open(_cache_path(key), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def _fetch_with_fallback(urls, cache_key):
    """多 URL 兜底下载 + 本地缓存"""
    cached = _load_cache(cache_key)
    if cached is not None:
        return cached
    for url in urls:
        try:
            data = _http_get_json(url)
            _save_cache(cache_key, data)
            return data
        except Exception:
            continue
    return None


def clear_cache():
    """清空本地查询缓存"""
    n = 0
    try:
        for f in os.listdir(CACHE_DIR):
            try:
                os.remove(os.path.join(CACHE_DIR, f))
                n += 1
            except OSError:
                pass
    except OSError:
        pass
    return n


# ---------------------------------------------------------------- 节点查询

_node_index = None


def _manager_local_file(name):
    """优先从 ComfyUI-Manager 本地缓存读取数据库文件（零网络依赖，国内环境更可靠）"""
    try:
        import folder_paths
        base = getattr(folder_paths, "base_path", None)
    except Exception:
        base = None
    if not base:
        return None
    user_dir = os.path.join(base, "user")
    candidates = [
        os.path.join(user_dir, "default", "ComfyUI-Manager", name),
        os.path.join(user_dir, "ComfyUI-Manager", name),
        os.path.join(user_dir, "manager", name),
    ]
    for p in candidates:
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception:
            continue
    return None


def get_node_index():
    """构建 节点类名(lower) -> [{repo, title}] 索引，附 nodename_pattern 模糊规则"""
    global _node_index
    if _node_index is not None:
        return _node_index

    data = _manager_local_file("extension-node-map.json")
    if data is None:
        data = _fetch_with_fallback(MANAGER_RAW_URLS, "extension-node-map.json")
    index = {"exact": {}, "patterns": []}
    if isinstance(data, dict):
        for repo_url, info in data.items():
            if not isinstance(repo_url, str):
                continue
            title = ""
            nodes_list = []
            pattern = None
            if isinstance(info, dict):
                title = info.get("title_aux") or info.get("title") or repo_url.rsplit("/", 1)[-1]
                nodes_list = info.get("nodes") or []
                pattern = info.get("nodename_pattern")
            for n in nodes_list:
                if not isinstance(n, str):
                    continue
                entry = {"repo": repo_url, "title": title}
                bucket = index["exact"].setdefault(n.lower(), [])
                if entry not in bucket:
                    bucket.append(entry)
            if pattern:
                try:
                    index["patterns"].append((re.compile(pattern, re.I), {"repo": repo_url, "title": title}))
                except re.error:
                    pass

    _node_index = index
    return index


def find_repo_for_node(class_type):
    """按节点类名查候选安装仓库，最多 5 条"""
    idx = get_node_index()
    if not idx:
        return []
    key = str(class_type).lower()
    results = list(idx["exact"].get(key, []))
    if not results:
        for pat, entry in idx["patterns"]:
            try:
                if pat.search(class_type):
                    results.append(entry)
            except re.error:
                continue
    seen, out = set(), []
    for r in results:
        if r["repo"] not in seen:
            seen.add(r["repo"])
            out.append(r)
    return out[:5]


def search_github_repos(query, limit=3):
    """GitHub 仓库搜索（无 token，限流 60 次/小时，仅兜底）"""
    try:
        url = "https://api.github.com/search/repositories?q=" + quote(query) + "&per_page=" + str(limit)
        data = _http_get_json(url)
        out = []
        for it in (data.get("items") or [])[:limit]:
            out.append({
                "repo": it.get("html_url"),
                "title": it.get("full_name"),
                "stars": it.get("stargazers_count"),
            })
        return out
    except Exception:
        return []


def suggest_node_sources(class_type):
    """缺失节点的安装来源建议"""
    results = []
    for r in find_repo_for_node(class_type):
        results.append({"repo": r["repo"], "title": r["title"], "match": "manager-db"})
    if not results:
        for g in search_github_repos("ComfyUI " + class_type):
            results.append({
                "repo": g["repo"],
                "title": g.get("title") or "",
                "match": "github-search",
            })
    return results


# ---------------------------------------------------------------- 模型查询

_model_db = None


def get_model_db():
    global _model_db
    if _model_db is not None:
        return _model_db
    data = _manager_local_file("model-list.json")
    if data is None:
        data = _manager_local_file("model-db.json")
    if data is None:
        data = _fetch_with_fallback(MODEL_DB_URLS, "model-db.json")
    _model_db = data if isinstance(data, (dict, list)) else {}
    return _model_db


def find_model_db_matches(filename):
    """在 Manager 模型库中按文件名（大小写不敏感）精确匹配下载地址"""
    db = get_model_db()
    hits = []
    if not db:
        return hits
    fname = os.path.basename(str(filename)).lower()

    def scan(obj):
        if len(hits) >= 6:
            return
        if isinstance(obj, list):
            for it in obj:
                scan(it)
                if len(hits) >= 6:
                    return
        elif isinstance(obj, dict):
            name = str(obj.get("name") or obj.get("filename") or "")
            if name.lower() == fname and isinstance(obj.get("url"), str) and obj["url"]:
                hits.append({
                    "source": "manager-db",
                    "title": name,
                    "url": obj["url"],
                    "size": obj.get("size"),
                })
            else:
                for v in obj.values():
                    scan(v)

    scan(db)
    seen, out = set(), []
    for h in hits:
        if h["url"] not in seen:
            seen.add(h["url"])
            out.append(h)
    return out[:3]


def _base_query(filename):
    """从模型文件名提取搜索关键词：去扩展名、分隔符转空格、去版本/精度尾巴"""
    q = os.path.splitext(os.path.basename(str(filename)))[0]
    q = re.sub(r"[_\-\.\[\]()]+", " ", q)
    q = re.sub(r"\b(v\d+(\.\d+)?|fp16|fp8|f16|pruned|ema|only|safetensors|gguf)\b", " ", q, flags=re.I)
    return re.sub(r"\s+", " ", q).strip()


def search_civitai(filename, folder_hint=None, limit=3):
    """Civitai 搜索，返回候选下载条目"""
    try:
        params = {"query": _base_query(filename) or os.path.basename(filename), "limit": str(limit * 2)}
        t = CIVITAI_TYPE_MAP.get(folder_hint)
        if t:
            params["types"] = t
        url = "https://civitai.com/api/v1/models?" + urlencode(params)
        data = _http_get_json(url)
        out = []
        for item in (data.get("items") or [])[:limit]:
            files = item.get("files") or []
            durl, fname = None, None
            if files:
                durl = files[0].get("downloadUrl")
                fname = files[0].get("name")
            out.append({
                "source": "civitai",
                "title": item.get("name"),
                "url": durl or ("https://civitai.com/models/%s" % item.get("id") if item.get("id") else None),
                "filename": fname,
                "type": item.get("type"),
            })
        return [x for x in out if x.get("url")]
    except Exception:
        return []


HF_HOSTS = [
    "https://hf-mirror.com",     # 国内镜像，优先（API 与官方兼容）
    "https://huggingface.co",
]


def search_huggingface(filename, folder_hint=None, limit=4):
    """HuggingFace 模型搜索（自动尝试镜像）。

    若在仓库文件列表中找到与目标文件名一致的文件，给出 resolve 直链；
    否则给出仓库页链接。
    """
    q = _base_query(filename)
    if not q:
        return []
    target = os.path.basename(str(filename)).lower()

    for host in HF_HOSTS:
        out = []
        try:
            url = host + "/api/models?search=" + quote(q) + "&files=true&limit=5"
            data = _http_get_json(url)
            for m in (data or [])[:limit]:
                mid = m.get("id") or m.get("modelId")
                if not mid:
                    continue
                direct = None
                for s in (m.get("siblings") or []):
                    rf = s.get("rfilename") or ""
                    if os.path.basename(rf).lower() == target:
                        direct = host + "/" + mid + "/resolve/main/" + rf
                        break
                if direct:
                    out.append({"source": "huggingface", "title": "%s · %s" % (mid, target), "url": direct})
                else:
                    out.append({"source": "huggingface", "title": mid, "url": host + "/" + mid})
            if out:
                return out[:limit]
        except Exception:
            continue
    return []


def suggest_model_downloads(filename, folder_hint=None, budget=None):
    """并行查询多个来源给出模型下载建议。

    - 三路并发（Manager 库 / Civitai / HuggingFace），总耗时受 budget 限制
    - 查询结果（含空结果）短缓存 NEG_TTL，弱网下避免重复超时
    """
    budget = QUERY_BUDGET if budget is None else float(budget)
    cache_key = "dl_%s_%s" % (os.path.basename(str(filename)).lower(), folder_hint or "")
    cached = _load_cache(cache_key, NEG_TTL)
    if cached is not None:
        return cached

    out = []
    ex = ThreadPoolExecutor(max_workers=3)
    try:
        futures = [
            ex.submit(find_model_db_matches, filename),
            ex.submit(search_civitai, filename, folder_hint),
            ex.submit(search_huggingface, filename),
        ]
        try:
            for f in as_completed(futures, timeout=budget):
                try:
                    out += f.result()
                except Exception:
                    pass
        except (TimeoutError, FuturesTimeout):
            pass
        except Exception:
            pass
    finally:
        ex.shutdown(wait=False)

    # 排序：官方库 > Civitai > HuggingFace，去重
    order = {"manager-db": 0, "civitai": 1, "huggingface": 2}
    out.sort(key=lambda x: order.get(x.get("source"), 3))
    seen, results = set(), []
    for item in out:
        u = item.get("url")
        if u and u not in seen:
            seen.add(u)
            results.append(item)

    _save_cache(cache_key, results)
    return results
