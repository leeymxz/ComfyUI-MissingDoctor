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
import threading
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
    # jsDelivr 国内可达（放最前）；raw.githubusercontent.com 国内经常不可达
    "https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main/extension-node-map.json",
    "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/extension-node-map.json",
    "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/extension-node-map.json",
]
MODEL_DB_URLS = [
    # Manager 官方维护的模型下载库（564+ 条目，含 name+url），jsdelivr 国内可达
    "https://cdn.jsdelivr.net/gh/ltdrdata/ComfyUI-Manager@main/model-list.json",
    "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-list.json",
    "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/model-list.json",
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

# 魔搭（ModelScope）搜索接口：PUT /api/v1/dolphin/agg，无需登录/无需 cookie，
# body 传 {"Query": 关键词, "Target": ""}，返回全站 19 类聚合结果（模型在 Data.Data.Model）。
MODELSCOPE_SEARCH_URL = "https://modelscope.cn/api/v1/dolphin/agg"


# ---------------------------------------------------------------- 基础 HTTP

def _http_get_json(url, retries=1):
    """GET JSON，失败自动重试一次（hf-mirror 偶发限流 429）"""
    last_err = None
    for attempt in range(retries + 1):
        try:
            if _HAS_REQUESTS:
                r = requests.get(url, timeout=HTTP_TIMEOUT, headers=_UA)
                if r.status_code in (429, 503) and attempt < retries:
                    time.sleep(2)
                    continue
                r.raise_for_status()
                return r.json()
            req = urllib.request.Request(url, headers=_UA)
            try:
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code in (429, 503) and attempt < retries:
                    time.sleep(2)
                    continue
                raise
        except Exception as e:
            last_err = e
    raise last_err if last_err else RuntimeError("请求失败")


def _http_put_json(url, body, retries=1):
    """PUT JSON（魔搭搜索接口用），失败自动重试一次"""
    last_err = None
    payload = json.dumps(body).encode("utf-8")
    for attempt in range(retries + 1):
        try:
            if _HAS_REQUESTS:
                r = requests.put(url, data=payload, timeout=HTTP_TIMEOUT,
                                 headers={**_UA, "Content-Type": "application/json"})
                if r.status_code in (429, 503) and attempt < retries:
                    time.sleep(2)
                    continue
                r.raise_for_status()
                return r.json()
            req = urllib.request.Request(url, data=payload, method="PUT",
                                         headers={**_UA, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last_err = e
    raise last_err if last_err else RuntimeError("请求失败")


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
    """构建 节点类名(lower) -> [{repo, title}] 索引，附 nodename_pattern 模糊规则

    Manager 官方 extension-node-map.json 的 value 是二元数组 [nodes_list, meta_dict]，
    旧实现只处理了 dict 形态导致官方数据库匹配完全失效（v1.4.5 及之前），
    这里同时兼容 [list, dict] 与 dict 两种形态。
    """
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
                # 宽容格式: {"nodes": [...], "title_aux": ...}
                title = info.get("title_aux") or info.get("title") or repo_url.rsplit("/", 1)[-1]
                nodes_list = info.get("nodes") or []
                pattern = info.get("nodename_pattern")
            elif isinstance(info, (list, tuple)) and info:
                # Manager 官方格式: [nodes_list, meta_dict]
                if isinstance(info[0], list):
                    nodes_list = info[0]
                meta = info[1] if len(info) > 1 and isinstance(info[1], dict) else {}
                title = (meta.get("title_aux") or meta.get("title")
                         or repo_url.rsplit("/", 1)[-1])
                pattern = meta.get("nodename_pattern")
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


_ICU_SEM = threading.BoundedSemaphore(3)   # comfy.icu 并发限流：批量缺失节点同时查询时防止被打挂


def search_comfyicu(node_name):
    """comfy.icu 目录站精确查询：按节点类名找 GitHub 仓库。

    comfy.icu 是 ComfyUI 节点生态目录站，按节点类名精确收录（SSR 渲染）。
    很多新热节点还没进 ComfyUI-Manager 数据库，但 comfy.icu 已收录，
    用它可补上 Manager 数据库的滞后空白。
    页面 URL 稳定：https://comfy.icu/node/{节点名}，抓 HTML 提取 git clone 仓库。
    返回 [{"repo", "title", "match": "comfyicu"}] 或 []。命中结果缓存 24h。
    并发限流 3 + 超时重试 1 次（检测工作流时会对多个缺失节点并发查询）。
    """
    try:
        cache_key = "icu_%s" % re.sub(r"[^a-zA-Z0-9_-]", "_", str(node_name).lower())[:100]
        cached = _load_cache(cache_key, 24 * 3600)
        if cached is not None:
            return cached
    except Exception:
        cache_key = None

    result = []
    url = "https://comfy.icu/node/" + quote(str(node_name))
    for attempt in (1, 2):
        try:
            with _ICU_SEM:
                if _HAS_REQUESTS:
                    r = requests.get(url, timeout=HTTP_TIMEOUT, headers=_UA)
                    html = (r.text or "") if r.status_code == 200 else ""
                else:
                    req = urllib.request.Request(url, headers=_UA)
                    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                        html = resp.read().decode("utf-8", "replace")
            if html:
                # 优先取 git clone 指令（最明确的仓库地址），其次任意 github 链接
                m = re.search(r"git clone\s+https?://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", html)
                if not m:
                    m = re.search(r"https?://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", html)
                if m:
                    repo = "https://github.com/" + m.group(1)
                    result = [{"repo": repo, "title": m.group(1), "match": "comfyicu"}]
            break
        except Exception:
            if attempt == 1:
                time.sleep(1.0)   # 短退避后重试一次（瞬时超时常见于并发高峰）
                continue
            result = []

    try:
        if cache_key is not None and result:
            # 只缓存非空结果：空结果不缓存，下次自动重试（网络偶发失败不应锁死 24h）
            _save_cache(cache_key, result)
    except Exception:
        pass
    return result


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


def _camel_words(s):
    """CamelCase 拆词：ApplyInstantID -> [Apply, Instant, ID]"""
    return re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+", s)


def _repo_code_verify(repo_url, node_name):
    """代码级验证：用 jsDelivr 文件树找到仓库 .py 源文件，
    抓取内容检查是否定义了该节点（NODE_CLASS_MAPPINGS["xxx"] / class xxx / @register_node）。
    返回 True(代码中确认) / False(代码中无) / None(无法验证)。结果缓存 24h。

    精确匹配规则（避免 README/注释提到节点名就误报）：
      - NODE_CLASS_MAPPINGS["NodeName"] / NODE_CLASS_MAPPINGS.update({...})
      - NODE_CLASS_MAPPINGS = {... "NodeName": ...}
      - class NodeName(...) 定义
      - @register_node("NodeName", ...) 新版注册装饰器
    """
    try:
        cache_key = "codev2_%s_%s" % (
            re.sub(r"[^a-zA-Z0-9_-]", "_", repo_url),
            re.sub(r"[^a-zA-Z0-9_-]", "_", str(node_name).lower()))[:160]
        cached = _load_cache(cache_key, 24 * 3600)
        if cached is not None:
            return cached
    except Exception:
        cache_key = None

    result = None
    try:
        m = re.match(r"https?://github\.com/([^/]+)/([^/]+)", repo_url or "")
        if not m:
            return None
        owner, repo = m.group(1), m.group(2)
        target = node_name.lower()
        # 精确匹配模式：节点名作为字典键 / 类名 / 注册装饰器参数
        # 兼容 f-string 键（f"NodeName": ...）与普通字符串键（"NodeName": / 'NodeName':）
        pat_key = re.compile(r'(?:f)?["\']%s["\']\s*:' % re.escape(target), re.I)
        pat_class = re.compile(r"class\s+%s\s*(?:\(|:)" % re.escape(target), re.I)
        pat_register = re.compile(r'@\s*register_node\s*\(\s*["\']%s["\']' % re.escape(target), re.I)

        for branch in ("main", "master"):
            try:
                tree_url = ("https://data.jsdelivr.com/v1/packages/gh/%s/%s@%s"
                            % (owner, repo, branch))
                tree = _http_get_json(tree_url)
            except Exception:
                continue
            py_files = []

            def walk(node, prefix):
                # 兼容 jsDelivr 树 API：顶层 type="gh"（name 是 owner/repo，代表仓库根，不拼入路径）
                if not isinstance(node, dict):
                    return
                ntype = node.get("type")
                if ntype == "gh":
                    for c in node.get("files") or []:
                        walk(c, prefix)
                elif ntype == "directory":
                    for c in node.get("files") or []:
                        walk(c, prefix + node.get("name", "") + "/")
                elif ntype == "file":
                    name = node.get("name", "")
                    if name.endswith(".py"):
                        py_files.append(prefix + name)
            walk(tree, "")
            if not py_files:
                continue

            # 排序：仓库根 __init__.py / 含节点名文件 最优先（节点通常注册在入口文件），
            # 其余按"路径短优先"（越靠近根越可能是入口）；再多抓几个（前 10）
            ranked = sorted(py_files,
                            key=lambda p: (
                                # 1) 仓库根 __init__.py（最常见的注册入口）
                                1 if p == "__init__.py" else 0,
                                # 2) 文件名含节点名
                                target.replace(" ", "") in p.lower(),
                                # 3) 任意 __init__.py
                                p.endswith("/__init__.py"),
                                # 4) 路径短优先（靠近根）
                                -len(p.split("/")),
                            ),
                            reverse=True)
            scanned = 0
            for p in ranked[:10]:
                try:
                    content = _http_get_text("https://cdn.jsdelivr.net/gh/%s/%s@%s/%s"
                                             % (owner, repo, branch, p), max_bytes=256 * 1024)
                except Exception:
                    continue
                scanned += 1
                low = content.lower()
                if pat_key.search(content) or pat_class.search(low) or pat_register.search(low):
                    result = True
                    break
            if result is not None:
                break
            if scanned >= 5:
                # 抓了足够多的文件都没找到 → 明确未找到
                result = False
                break
            if py_files and scanned == len(ranked):
                result = False
                break
    except Exception:
        result = None

    try:
        if cache_key and result is not None:
            _save_cache(cache_key, result)
    except Exception:
        pass
    return result


def _http_get_text(url, max_bytes=131072):
    """抓取文本内容（限长），供代码验证用。
    jsDelivr CDN 在部分网络环境会被限流，故多通道兜底：
    raw.githubusercontent.com → ghproxy.net / gh-proxy.com 国内镜像。"""
    candidates = [url]
    if "cdn.jsdelivr.net" in url:
        # 原 URL 形如 https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}
        m = re.match(r"https://cdn\.jsdelivr\.net/gh/([^@]+)@([^/]+)/(.*)", url)
        if m:
            raw = "https://raw.githubusercontent.com/%s/%s/%s" % (m.group(1), m.group(2), m.group(3))
            candidates = [
                raw,
                "https://ghproxy.net/" + raw,
                "https://gh-proxy.com/" + raw,
            ]
    last_err = None
    for u in candidates:
        try:
            if _HAS_REQUESTS:
                r = requests.get(u, timeout=8, headers=_UA)
                if r.status_code == 200:
                    txt = r.text
                    return txt[:max_bytes] if txt else ""
            else:
                req = urllib.request.Request(u, headers=_UA)
                with urllib.request.urlopen(req, timeout=8) as resp:
                    data = resp.read(max_bytes)
                    return data.decode("utf-8", "replace")
        except Exception as e:
            last_err = e
            continue
    if last_err:
        raise last_err
    return ""


# 文件名 → 模型目录 关键词推断（与前端 guessFolderName 一致，用于提示建议目录）
_FOLDER_INFER_RULES = [
    (("vae",), "vae"), (("lora",), "loras"), (("clip",), "text_encoders"),
    (("unet",), "diffusion_models"), (("diffusion",), "diffusion_models"),
    (("upscale", "ultrasharp", "esrgan"), "upscale_models"),
    (("control", "canny", "openpose"), "controlnet"),
    (("embed", "ti_"), "embeddings"), (("sam",), "sams"),
    (("ipadapter",), "ipadapter"), (("ckpt",), "checkpoints"),
    (("checkpoint",), "checkpoints"),
]


def infer_folder_hint(filename):
    """根据文件名推断应存放的模型目录（供缺失提示与下载默认目录）"""
    n = (filename or "").lower()
    for kws, folder in _FOLDER_INFER_RULES:
        if any(k in n for k in kws):
            return folder
    return None


def _repo_readme_verify(repo_url, node_name):
    """抓取仓库 README，验证是否真的包含该节点名（多通道，国内镜像兜底）。
    返回 True(确认) / False(未找到) / None(无法验证，如无 README)"""
    try:
        m = re.match(r"https?://github\.com/([^/]+)/([^/]+)", repo_url or "")
        if not m:
            return None
        owner, repo = m.group(1), m.group(2)
        target = node_name.lower()
        for branch in ("main", "master"):
            try:
                txt = _http_get_text(
                    "https://cdn.jsdelivr.net/gh/%s/%s@%s/README.md" % (owner, repo, branch),
                    max_bytes=64 * 1024)
                if txt:
                    return target in txt.lower()
            except Exception:
                continue
    except Exception:
        pass
    return None


def _node_search_queries(class_type):
    """为缺失节点生成多组 GitHub 搜索查询（按命中率从高到低排列）"""
    words = _camel_words(class_type)
    # 拼出更合理的仓库名关键词：取前 2-3 个有意义的词
    # 例：MiniMaxH3AVDecodeT8 -> [Mini, Max, H3, AV, Decode, T8]
    #     → 候选 "MiniMax H3" / "minimax-h3" / "MiniMaxH3"
    w = [x for x in words if len(x) >= 2]
    phrases = [class_type]
    if w:
        phrases.append(" ".join(w[:3]))
        phrases.append(" ".join(w[:2]))
        phrases.append("".join(w[:3]))
    for i in range(len(words) - 1):
        phrases.append(words[i] + " " + words[i + 1])
    if words:
        phrases.append(max(words, key=len))

    queries = []
    # 1) 代码注册关键字 + 节点名（命中即确认仓库源码定义了该节点）
    queries.append('NODE_CLASS_MAPPINGS "%s"' % class_type)
    # 2) 仓库名/描述/README 含节点名
    queries.append('%s in:name,description,readme' % class_type)
    # 3) 拆词后的仓库名关键词（GitHub repo search 只搜仓库名/描述，必须用宽词）
    for p in phrases[:3]:
        if p != class_type:
            queries.append('comfyui %s in:name,description,readme' % p)
    # 4) 宽松兜底
    if words:
        queries.append("ComfyUI " + max(words, key=len))
    return queries


def _verify_node_candidate(repo, class_type, wrong):
    """验证单个候选仓库：代码级 > README 级。
    返回候选 dict（含 verify 字段）或 None（明确未找到 / 无法验证 → 剔除）。

    注意：GitHub 兜底搜索的候选必须能证明自己包含该节点，否则不推荐——
    无法验证源码（verify_level=none）的仓库与节点关系未知，直接推荐容易误装。
    """
    if repo in wrong:
        return None
    code_hit = _repo_code_verify(repo, class_type)
    if code_hit is True:
        return {"repo": repo, "title": "", "match": "github-search",
                "verify": True, "verify_level": "code"}
    if code_hit is False:
        # 源码里明确没有该节点 → 剔除，避免误装
        return None
    # 无法验证源码（树/抓取失败）→ README 提及作为弱证据；README 也没有 → 剔除
    verify = _repo_readme_verify(repo, class_type)
    if verify is True:
        return {"repo": repo, "title": "", "match": "github-search",
                "verify": True, "verify_level": "readme"}
    return None


def suggest_node_sources(class_type):
    """缺失节点的安装来源建议（应用社区纠错表）。

    1. Manager 数据库精确/模式匹配（官方库，最可靠）
    2. comfy.icu 目录站精确查询（按节点类名收录，补 Manager 滞后空白）
    3. 用户确认过的正确来源（置顶）
    4. GitHub 搜索兜底：优先代码注册关键字，逐候选做代码级/README 实据验证，
       明确未找到的候选剔除，无法验证的降权排后。
    返回 (results, advice)；results 为空时 advice 给出可行行动指引。
    """
    from . import corrections

    results = []
    wrong = corrections.wrong_repos(class_type)

    # 1) Manager 官方数据库
    for r in find_repo_for_node(class_type):
        if r["repo"] not in wrong:
            results.append({"repo": r["repo"], "title": r["title"], "match": "manager-db"})

    # 2) comfy.icu 目录站：Manager 无「精确命中」时都查。
    #    不能只看 results 是否为空——nodename_pattern 模糊规则可能误命中，
    #    挡住 comfy.icu 的真命中（如 MiniMaxH3*T8 系列节点）。
    exact_hit = bool(get_node_index()["exact"].get(str(class_type).lower()))
    if not exact_hit:
        for r in search_comfyicu(class_type):
            if r["repo"] not in wrong and all(r["repo"] != x["repo"] for x in results):
                results.append({"repo": r["repo"], "title": r["title"], "match": "comfyicu"})

    # 3) 用户确认过的正确来源置顶
    for repo in corrections.correct_repos(class_type):
        if repo not in wrong:
            results.append({"repo": repo, "title": "★ 用户确认", "match": "user-correct"})

    advice = None
    if not results:
        # GitHub 兜底：预算内搜多个查询词，跨查询汇总候选；
        # 代码级实据（NODE_CLASS_MAPPINGS 注册）优先于 README 提及，
        # 避免 readme 级弱候选抢先占位（如 Nana_H3 抢占 MiniMaxH3*T8 的真源 T8mars）。
        deadline = time.time() + 20.0
        best, seen_repos = [], set()
        for q in _node_search_queries(class_type):
            if time.time() > deadline:
                break
            hits = search_github_repos(q, limit=5)
            for g in hits:
                if time.time() > deadline:
                    break
                if g["repo"] in seen_repos:
                    continue
                seen_repos.add(g["repo"])
                c = _verify_node_candidate(g["repo"], class_type, wrong)
                if c:
                    c["title"] = g["title"]
                    c["stars"] = g.get("stars")
                    best.append(c)
            if any(c.get("verify_level") == "code" for c in best):
                break   # 已有代码级实据，无需继续搜
        best.sort(key=lambda c: ({"code": 0, "readme": 1, "none": 2}.get(c.get("verify_level"), 3),
                                 -(c.get("stars") or 0)))
        results = best[:6]

    # 排序：comfy.icu / manager-db / 用户确认 > 代码验证 > README 验证 > 未验证；有 star 的参考排前
    def _rank(x):
        src = {"comfyicu": 0, "manager-db": 0, "user-correct": 0,
               "github-search": 1}.get(x.get("match"), 2)
        level = {"code": 0, "readme": 1, "none": 2}.get(x.get("verify_level"), 3)
        stars = x.get("stars") or 0
        return (src, level, -stars)
    results = sorted(results, key=_rank)
    results = results[:6]

    if not results:
        advice = {
            "found": False,
            "class_type": class_type,
            "reason": ("已查询：ComfyUI-Manager 官方节点库、comfy.icu 节点目录、GitHub 仓库搜索"
                       "（含 NODE_CLASS_MAPPINGS 注册关键字）。未找到提供该节点的可信仓库。"),
            "tips": [
                "1️⃣ 在 comfy.icu 查节点：comfy.icu/node/%s（ComfyUI 节点目录站，按节点名精确收录）" % class_type,
                "2️⃣ 在 GitHub 搜代码：github.com/search?q=NODE_CLASS_MAPPINGS+\"%s\"&type=code" % class_type,
                "3️⃣ 在 GitHub 搜仓库：github.com/search?q=%s&type=repositories" % class_type,
                "4️⃣ 若工作流来自某个分享页/教程，回原页面找「安装依赖/自定义节点」说明",
                "5️⃣ 检查节点名拼写：大小写、下划线/连字符、前后缀（如 ComfyUI_ 前缀常被省略）",
                "6️⃣ 部分节点是「幽灵节点」（工作流作者误写或已删除）：可用画布定位删除后重建",
                "7️⃣ 去 ComfyUI 社区问：Discord（comfyanonymous 官方）或国内 Q 群/论坛贴出节点名",
            ],
        }
    return results, advice


# ---------------------------------------------------------------- 模型查询

# 知名模型别名表：工作流常见引用名与仓库内实际文件名不一致时的已验证官方直链。
# 例如官方 FLUX.1-schnell 仓库内文件叫 ae.safetensors，而大量工作流引用 flux-ae.safetensors，
# 文件名对不上导致四路搜索都拿不到"精确匹配"，这里直接给出可下载源（下载时仍保存为引用名）。
KNOWN_MODEL_ALIASES = {
    "flux-ae.safetensors": [
        {"source": "modelscope", "kind": "file", "match": "exact",
         "title": "魔搭 AI-ModelScope/FLUX.1-schnell · ae.safetensors（官方镜像，已验证）",
         "url": "https://modelscope.cn/api/v1/models/AI-ModelScope/FLUX.1-schnell/repo?FilePath=ae.safetensors&Revision=master"},
        {"source": "modelscope", "kind": "file", "match": "exact",
         "title": "魔搭 black-forest-labs/FLUX.1-schnell · ae.safetensors（官方，已验证）",
         "url": "https://modelscope.cn/api/v1/models/black-forest-labs/FLUX.1-schnell/repo?FilePath=ae.safetensors&Revision=master"},
    ],
}

# HF URL 拼接名：ComfyUI 系下载工具从 HuggingFace 链接生成引用名时的常见格式
# 例：kijai_MiniMax-H3-experimental_resolve_main_minimax_h3_video_vae_int8_convrot.safetensors
#     → 作者 kijai / 仓库 MiniMax-H3-experimental / 真实文件 minimax_h3_video_vae_int8_convrot.safetensors
_HF_URLNAME_RE = re.compile(r"^(?P<prefix>.+?)_resolve_main_(?P<fname>.+)$")


def _try_hf_urlname(filename):
    """解析 '作者_仓库_resolve_main_文件名' 风格引用名，在 HF 镜像上验证真实文件后给出直链。

    验证失败（404/网络不通）一律返回空——不给未经验证的下载链接。
    """
    base = os.path.basename(str(filename))
    m = _HF_URLNAME_RE.match(base)
    if not m:
        return []
    prefix, fname = m.group("prefix"), m.group("fname")
    if "_" not in prefix or "/" in fname or fname.startswith("_"):
        return []
    author, repo = prefix.split("_", 1)
    if not author or not repo or len(fname) < 4:
        return []
    # 扩展名白名单（与下载器一致）
    if os.path.splitext(fname)[1].lower() not in (".safetensors", ".sft", ".gguf", ".ckpt", ".pt", ".bin"):
        return []
    for host in ("https://hf-mirror.com", "https://huggingface.co"):
        url = "%s/%s/%s/resolve/main/%s" % (host, author, repo, fname)
        try:
            r = requests.head(url, timeout=8, headers=_UA, allow_redirects=True)
            if r.status_code in (200, 301, 302, 303):
                return [{"source": "huggingface", "kind": "file", "match": "exact",
                         "title": "%s/%s · %s（由引用名解析验证）" % (author, repo, fname),
                         "url": url}]
        except Exception:
            continue
    return []


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
            h["match"] = "exact"  # Manager 库按文件名精确匹配
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
            # 下载直链：优先 files[].downloadUrl，其次由 modelVersions[0] 构造稳定直链
            durl, fname = None, None
            files = item.get("files") or []
            if files:
                durl = files[0].get("downloadUrl")
                fname = files[0].get("name")
            if not durl:
                versions = item.get("modelVersions") or []
                if versions and versions[0].get("id"):
                    durl = "https://civitai.com/api/download/models/%s" % versions[0]["id"]
            exact = bool(fname) and os.path.basename(fname).lower() == os.path.basename(str(filename)).lower()
            out.append({
                "source": "civitai",
                "title": item.get("name"),
                "url": durl or ("https://civitai.com/models/%s" % item.get("id") if item.get("id") else None),
                "filename": fname,
                "type": item.get("type"),
                "match": "exact" if (exact and durl) else "search",
            })
        return [x for x in out if x.get("url")]
    except Exception:
        return []


HF_HOSTS = [
    "https://hf-mirror.com",     # 国内镜像，优先（API 与官方兼容）
    "https://huggingface.co",
]


def search_advice(filename, folder_hint=None, results_count=0):
    """候选搜索结果为空/稀少时，给出原因分析与行动指引"""
    q = _base_query(filename)
    if results_count > 0:
        return {
            "found": True,
            "tips": [
                "✓ 带「文件匹配」的候选与缺失文件名精确一致，最可靠",
                "~ 「近似文件」请先核对是否为目标模型（可能是低显存版/不同作者版）",
                "🔍 「搜索候选」来自关键词搜索，可能是同名不同款，下载前务必核对",
            ],
        }
    return {
        "found": False,
        "query": q,
        "reason": ("已查询：Manager 官方模型库（564+ 条目）、魔搭 ModelScope、Civitai、"
                   "HuggingFace（国内镜像）。未找到同名或近似候选——通常因为模型较新/较冷门、"
                   "文件名较特殊，或需要登录下载。"),
        "tips": [
            "1️⃣ 用下方「手动搜索」改更短的关键词重试（去掉版本号、精度后缀、作者前缀）",
            "2️⃣ 浏览器打开 civitai.com 直接搜索模型名",
            "3️⃣ 浏览器打开 hf-mirror.com 搜索（国内可达的 HuggingFace 镜像）",
            "4️⃣ 浏览器打开 modelscope.cn 搜索（魔搭，国内直达）",
            "5️⃣ 如果模型来自某个工作流分享页/教程，回原页面找下载链接",
            "6️⃣ 检查缺失文件名的拼写（下划线/连字符/大小写）",
            "7️⃣ Civitai 与 HuggingFace 部分模型需登录下载：浏览器登录后用「复制链接」手动下载",
        ],
    }


MODEL_FILE_PATTERNS = (".safetensors", ".ckpt", ".gguf", ".pth", ".pt", ".bin", ".sft", ".onnx")


def search_modelscope_by_url(url, target_name=None):
    """解析魔搭（ModelScope）模型页链接 → 文件列表 → 匹配模型文件直链。

    输入形如 https://modelscope.cn/models/{owner}/{name}
    魔搭文件列表与下载直链 API 公开可用（搜索 API 需登录，故用链接解析方式）。
    返回 (候选列表, 模型标识) 或 (None, None)。
    """
    m = re.match(r"https?://(?:www\.)?modelscope\.cn/models/([^/]+)/([^/?#]+)", url or "")
    if not m:
        return None, None
    owner, name = m.group(1), m.group(2)
    target = os.path.basename(str(target_name or "")).lower()
    target_stem = os.path.splitext(target)[0]

    files_url = ("https://modelscope.cn/api/v1/models/%s/%s/repo/files"
                 "?Recursive=true&Revision=master" % (owner, name))
    try:
        data = _http_get_json(files_url)   # 内建重试
        fl = (data.get("Data") or {}).get("Files") or []
    except Exception:
        fl = []

    out = []
    for f in fl:
        p = f.get("Path") or ""
        pl = p.lower()
        if not pl.endswith(MODEL_FILE_PATTERNS):
            continue
        label = p.split("/")[-1]
        dl = ("https://modelscope.cn/api/v1/models/%s/%s/repo?FilePath=%s&Revision=master"
              % (owner, name, quote(p)))
        lb = label.lower()
        if target and (lb == target or lb.endswith(target)):
            match = "exact"
        elif target and target_stem and target_stem in pl:
            match = "near"
        else:
            match = "search"
        out.append({"source": "modelscope", "title": "%s/%s · %s" % (owner, name, label),
                    "url": dl, "kind": "file", "filename": label, "match": match})
    return out, ("%s/%s" % (owner, name))


def search_modelscope(filename, folder_hint=None, limit=3):
    """魔搭（ModelScope）按文件名关键词自动搜索模型 → 匹配文件直链。

    实测接口：PUT /api/v1/dolphin/agg（body {"Query": kw, "Target": ""}），
    无需登录、无需 cookie，返回全站聚合结果，模型在 Data.Data.Model.Models。
    魔搭搜索是分词匹配：camelCase 连写（如 waiIllustriousSDXL）召回差，
    空格分词（如 "wai illustrious sdxl"）召回好，因此优先拆词查询。
    对候选模型逐个调用文件列表 API 精确匹配目标文件（复用 search_modelscope_by_url），
    返回与 Civitai/HF 一致结构的候选列表；无匹配时返回 []。
    """
    base_q = _base_query(filename)
    if not base_q:
        return []
    target = os.path.basename(str(filename)).lower()
    target_stem = os.path.splitext(target)[0]

    # 构建查询候选：1) camelCase 拆词空格连接（召回最好） 2) 原始关键词
    words = _camel_words(base_q)
    spaced = " ".join(words).strip() if words else base_q
    query_candidates = []
    for q in (spaced, base_q):
        if q and q not in query_candidates:
            query_candidates.append(q)
    # 拆词后若剩下多个独立词，再加一版只取前两个词（更宽召回）
    if len(words) > 2:
        short = " ".join(words[:2]).strip()
        if short and short not in query_candidates:
            query_candidates.append(short)

    # 归一化：去掉所有非字母数字字符后比对，兼容 连字符/下划线/空格 等写法差异
    q_norm = re.sub(r"[^a-z0-9]", "", base_q.lower())
    stem_norm = re.sub(r"[^a-z0-9]", "", (target_stem or "").lower())

    out = []
    for qi, query in enumerate(query_candidates):
        try:
            data = _http_put_json(MODELSCOPE_SEARCH_URL, {"Query": query, "Target": ""})
            models = (((data.get("Data") or {}).get("Data") or {}).get("Model") or {}).get("Models") or []
        except Exception:
            models = []
        if not models:
            continue

        # 只处理有限个候选，避免对无关仓库反复请求文件列表
        for m in models[: limit * 3]:
            owner = m.get("Path")
            name = m.get("Name")
            if not owner or not name:
                continue
            # 快速过滤：候选模型名含关键词才值得进一步解析（减少无效请求）
            combined = re.sub(r"[^a-z0-9]", "", (str(owner) + " " + str(name)).lower())
            if q_norm and q_norm not in combined and stem_norm and stem_norm not in combined:
                continue
            try:
                hits, _mid = search_modelscope_by_url(
                    "https://modelscope.cn/models/%s/%s" % (owner, name), filename)
            except Exception:
                hits = []
            for h in hits or []:
                # 只收 exact / near，避免把无关仓库的其它文件全塞进来
                if h.get("match") in ("exact", "near"):
                    h["title"] = "%s/%s" % (owner, name)
                    out.append(h)
            if len(out) >= limit:
                break
        if out:
            break  # 第一个有结果的查询即可
    return out[:limit]


def search_huggingface(filename, folder_hint=None, limit=4):
    """HuggingFace 模型搜索（自动尝试镜像）。

    注意：hf-mirror 的搜索列表 API 不返回 siblings（files=true 被忽略），
    因此对候选仓库逐个调用详情 API 确认文件后再给出直链。

    - 仓库内找到与目标文件名一致的文件 → resolve 直链（kind=file，可直接下载）
    - 未找到同名文件 → 仓库页链接并标记 kind=repo（仅作参考，不作为下载候选）
    """
    q = _base_query(filename)
    if not q:
        return []
    target = os.path.basename(str(filename)).lower()
    target_stem = os.path.splitext(target)[0]

    for host in HF_HOSTS:
        out = []
        try:
            url = host + "/api/models?search=" + quote(q) + "&limit=5"
            data = _http_get_json(url)
            repos = []
            for m in (data or [])[:limit]:
                mid = m.get("id") or m.get("modelId")
                if mid:
                    repos.append(mid)
            if not repos:
                continue

            for mid in repos:
                # 列表 API 不含 siblings（hf-mirror），用详情 API 确认文件
                sib = []
                try:
                    time.sleep(0.5)  # hf-mirror 限流保护
                    detail = _http_get_json(host + "/api/models/" + quote(mid) + "?files=true")
                    sib = detail.get("siblings") or []
                except Exception:
                    sib = []

                direct = None
                near = None
                for s in sib:
                    rf = s.get("rfilename") or ""
                    base = os.path.basename(rf).lower()
                    if base == target:
                        direct = host + "/" + mid + "/resolve/main/" + rf
                        break
                    if (not near and target_stem and target_stem in base
                            and base.endswith((".safetensors", ".sft", ".gguf", ".ckpt"))):
                        near = (host + "/" + mid + "/resolve/main/" + rf, base)

                if direct:
                    out.append({"source": "huggingface", "title": "%s · %s" % (mid, target),
                                "url": direct, "kind": "file", "match": "exact"})
                elif near:
                    out.append({"source": "huggingface", "title": "%s · %s" % (mid, near[1]),
                                "url": near[0], "kind": "file", "match": "near"})
                else:
                    out.append({"source": "huggingface", "title": mid,
                                "url": host + "/" + mid, "kind": "repo", "match": "search"})
            if out:
                return out[:limit]
        except Exception:
            continue
    return []


def suggest_model_downloads(filename, folder_hint=None, budget=None):
    """并行查询多个来源给出模型下载建议（应用社区纠错表）。

    - 三路并发（Manager 库 / Civitai / HuggingFace），总耗时受 budget 限制
    - 查询结果（含空结果）短缓存 NEG_TTL，弱网下避免重复超时
    - 用户标记错误的候选剔除；确认正确的置顶
    """
    from . import corrections

    # 知名别名表优先（在缓存检查之前）：官方文件名与引用名不一致时（如 flux-ae.safetensors）
    # 直接返回已验证直链，秒出「⬇ 下载到模型库」按钮，不再依赖四路网络搜索。
    _alias = KNOWN_MODEL_ALIASES.get(os.path.basename(str(filename)).lower())
    if _alias:
        _wrong = corrections.wrong_repos(os.path.basename(filename))
        return [a for a in _alias if a.get("url") not in _wrong]

    # HF URL 拼接名解析（kijai_仓库_resolve_main_文件.safetensors 等）：
    # 解析出真实仓库文件并 HEAD 验证，命中即秒出下载按钮
    _alt = _try_hf_urlname(filename)
    if _alt:
        _wrong = corrections.wrong_repos(os.path.basename(filename))
        _alt = [a for a in _alt if a.get("url") not in _wrong]
        if _alt:
            try:
                _save_cache("sugg_%s_%s" % (os.path.basename(str(filename)).lower(), folder_hint or ""), _alt)
            except Exception:
                pass
            return _alt

    budget = QUERY_BUDGET if budget is None else float(budget)
    cache_key = "sugg_%s_%s" % (os.path.basename(str(filename)).lower(), folder_hint or "")
    cached = _load_cache(cache_key, NEG_TTL)
    if cached is not None:
        return cached

    out = []
    ex = ThreadPoolExecutor(max_workers=4)
    try:
        futures = [
            ex.submit(find_model_db_matches, filename),
            ex.submit(search_civitai, filename, folder_hint),
            ex.submit(search_huggingface, filename),
            ex.submit(search_modelscope, filename, folder_hint),
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

    # 排序：官方库 > 魔搭 > Civitai > HuggingFace，去重
    order = {"manager-db": 0, "modelscope": 1, "civitai": 2, "huggingface": 3}
    out.sort(key=lambda x: order.get(x.get("source"), 3))
    seen, results = set(), []
    for item in out:
        u = item.get("url")
        if u and u not in seen:
            seen.add(u)
            results.append(item)

    # 预检"精确匹配"的文件直链：HEAD 探测存活/失效/需登录（并行，限 5 条）
    to_check = [x for x in results if x.get("kind") == "file" and x.get("match") == "exact"][:5]
    if to_check:
        ex = ThreadPoolExecutor(max_workers=min(5, len(to_check)))

        def _check(d):
            try:
                r = requests.head(d["url"], timeout=8, headers=_UA, allow_redirects=True)
                st = r.status_code
                if st in (200, 301, 302, 303):
                    return
                if st in (401, 403) and "civitai.com" in d["url"]:
                    d["auth"] = True
                elif st in (404, 410, 451):
                    d["dead"] = True
            except Exception:
                pass

        try:
            ex.map(_check, to_check)
        finally:
            ex.shutdown(wait=True)

    # 应用社区纠错：剔除错误候选，用户确认的置顶
    try:
        wrong = corrections.wrong_repos(os.path.basename(filename))
        ok = [x for x in results if x.get("url") not in wrong]
        correct_first = [x for x in ok if x.get("url") in corrections.correct_repos(os.path.basename(filename))]
        rest = [x for x in ok if x.get("url") not in corrections.correct_repos(os.path.basename(filename))]
        results = correct_first + rest
    except Exception:
        pass

    _save_cache(cache_key, results)
    return results
