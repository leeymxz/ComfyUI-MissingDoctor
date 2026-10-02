// ComfyUI-MissingDoctor - 前端面板
// 菜单「🩺 体检清理」按钮 + 四标签面板：
// 缺失节点 / 缺失模型 / 老旧模型 / 清理
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 前端脚本版本（与后端 version.py 同步）。浏览器可能缓存旧 JS，
// 若与后端版本不一致，面板会提示 Ctrl+F5 强制刷新。
const MD_JS_VER = "1.4.9";

const MD = {
    overlay: null,
    dialogEl: null,
    escHandler: null,
    tabs: {},
    currentTab: "nodes",
    agedData: null,
    agedDays: 90,
    agedSort: "oldest",
    cleanupPreview: null,
    outputDays: 0,
    heavyItems: null,
    wfSig: null,        // 检测时的工作流签名
    wfSigTimer: null,   // 签名比对轮询
    staleBarShown: false,
};

// 计算当前画布工作流签名（节点类型计数哈希），用于判断检测结果是否过期
async function workflowSignature() {
    try {
        const gp = await Promise.resolve(app.graphToPrompt());
        const out = gp.output || {};
        const counts = {};
        for (const k of Object.keys(out)) {
            const ct = (out[k] || {}).class_type || "?";
            counts[ct] = (counts[ct] || 0) + 1;
        }
        const keys = Object.keys(counts).sort();
        const sig = keys.map(k => k + "x" + counts[k]).join("|");
        return { sig, count: keys.length };
    } catch (e) {
        return { sig: "", count: 0 };
    }
}

// 面板打开期间轮询：画布变化 → 显示过期提示条
function startStaleWatch() {
    if (MD.wfSigTimer) clearInterval(MD.wfSigTimer);
    MD.wfSigTimer = setInterval(async () => {
        if (!MD.overlay || MD.overlay.style.display === "none") return;
        const cur = await workflowSignature();
        if (MD.wfSig && cur.sig && cur.sig !== MD.wfSig && !MD.staleBarShown) {
            MD.staleBarShown = true;
            const bar = el("div", { id: "md-stale-bar", style:
                "background:#4a3a10;color:#ffd54a;border-bottom:1px solid #6e5a20;padding:8px 18px;font-size:12px;display:flex;align-items:center;gap:10px" }, [
                el("span", { text: "⚠️ 画布工作流已变化，下方检测结果可能已过期" }),
                el("button", { class: "md-btn", text: "重新检测", onclick: () => {
                    MD.staleBarShown = false;
                    document.getElementById("md-stale-bar")?.remove();
                    switchTab(MD.currentTab);
                    const rb = [...document.querySelectorAll("#md-body button")].find(b => b.textContent.includes("检测当前工作流"));
                    if (rb) rb.click();
                } }),
            ]);
            const tabs = document.getElementById("md-tabs");
            tabs.parentNode.insertBefore(bar, tabs);
        }
    }, 2000);
}

// ---------------------------------------------------------------- 工具函数

function fmtBytes(n) {
    if (n == null || isNaN(n)) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + " " + units[i];
}

function fmtDate(ts) {
    if (!ts) return "-";
    try {
        const d = new Date(Number(ts) * 1000);
        const p = (x) => String(x).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (e) { return "-"; }
}

function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") e.style.cssText = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c == null) continue;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
}

// ---------------- 面板内部对话框（替代浏览器原生 alert/confirm/prompt）----------------
let MD_POP = null;

function _popDom() {
    if (!MD_POP) {
        MD_POP = el("div", { id: "md-pop" });
        document.body.appendChild(MD_POP);
    }
    return MD_POP;
}

function _popShow(box) {
    const d = _popDom();
    d.innerHTML = "";
    d.style.display = "flex";
    d.appendChild(box);
}

function _popHide() {
    if (MD_POP) MD_POP.style.display = "none";
}

function mdAlert(message) {
    return new Promise(resolve => {
        _popShow(el("div", { class: "md-pop-box" }, [
            el("div", { class: "md-pop-title", text: "ℹ️ 提示" }),
            el("div", { class: "md-pop-msg", text: String(message) }),
            el("div", { class: "md-pop-btns" }, [
                el("button", { class: "md-btn", text: "确定", onclick: () => { _popHide(); resolve(); } }),
            ]),
        ]));
    });
}

function mdConfirm(message) {
    return new Promise(resolve => {
        _popShow(el("div", { class: "md-pop-box" }, [
            el("div", { class: "md-pop-title", text: "❓ 确认操作" }),
            el("div", { class: "md-pop-msg", text: String(message) }),
            el("div", { class: "md-pop-btns" }, [
                el("button", { class: "md-btn ghost", text: "取消", onclick: () => { _popHide(); resolve(false); } }),
                el("button", { class: "md-btn", text: "确定", onclick: () => { _popHide(); resolve(true); } }),
            ]),
        ]));
    });
}

function mdPrompt(message, def) {
    return new Promise(resolve => {
        const input = el("input", { class: "md-input md-pop-input", value: def != null ? String(def) : "" });
        const ok = () => { _popHide(); resolve(input.value.trim() || null); };
        input.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
        _popShow(el("div", { class: "md-pop-box" }, [
            el("div", { class: "md-pop-title", text: "✍️ 请输入" }),
            el("div", { class: "md-pop-msg", text: String(message) }),
            input,
            el("div", { class: "md-pop-btns" }, [
                el("button", { class: "md-btn ghost", text: "取消", onclick: () => { _popHide(); resolve(null); } }),
                el("button", { class: "md-btn", text: "确定", onclick: ok }),
            ]),
        ]));
        setTimeout(() => input.focus(), 50);
    });
}

async function mdFetch(path, options = {}) {
    const opt = { method: "GET", headers: {}, ...options };
    if (opt.body && typeof opt.body !== "string") {
        opt.body = JSON.stringify(opt.body);
        opt.headers["Content-Type"] = "application/json";
    }
    // 注意：api.fetchApi 会自动加 /api 前缀，本插件路由注册在 /md/*，
    // 因此使用原生 fetch 以相对路径请求
    const resp = await fetch(path, opt);
    let data = null;
    try { data = await resp.json(); } catch (e) { /* ignore */ }
    if (!resp.ok || (data && data.status === "error")) {
        throw new Error((data && data.message) || `HTTP ${resp.status}`);
    }
    return data && data.data !== undefined ? data.data : data;
}

// ---------------------------------------------------------------- 样式

function injectStyle() {
    if (document.getElementById("missing-doctor-style")) return;
    const style = el("style", { id: "missing-doctor-style", text: `
#md-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 2147483000;
  display: none; align-items: center; justify-content: center; font-family: sans-serif; }
#md-dialog { width: min(960px, 92vw); max-height: 86vh; background: #1e1e1e; color: #e8e8e8;
  border: 1px solid #3a3a3a; border-radius: 12px; display: flex; flex-direction: column;
  box-shadow: 0 12px 48px rgba(0,0,0,.5); overflow: hidden; }
#md-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid #333;
  cursor: move; user-select: none; touch-action: none; }
#md-head h3 { margin: 0; font-size: 16px; font-weight: 600; pointer-events: none; }
#md-head .md-sub { font-size: 12px; color: #888; pointer-events: none; }
#md-close { margin-left: auto; cursor: pointer; border: none; background: transparent; color: #aaa;
  font-size: 18px; padding: 4px 10px; border-radius: 6px; }
#md-close:hover { background: #333; color: #fff; }
.md-progress { background: #1c1c1c; border: 1px solid #3a3a3a; border-radius: 7px; height: 16px; overflow: hidden; margin: 4px 0; position: relative; }
.md-progress > div { height: 100%; background: linear-gradient(90deg, #4a6fa5, #7b4aa5); transition: width .4s; }
.md-progress .md-progress-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.8); }
.md-recent { background: #3a2323 !important; }
.md-recent-badge { display: inline-block; background: #6e2b2b; color: #ffb0b0; border-radius: 4px;
  padding: 1px 6px; font-size: 10px; margin-left: 6px; white-space: nowrap; }
#md-tabs { display: flex; gap: 4px; padding: 10px 18px 0; }
.md-tab { padding: 8px 16px; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 13px;
  color: #999; border: 1px solid transparent; border-bottom: none; user-select: none; }
.md-tab:hover { color: #ddd; }
.md-tab.active { background: #2a2a2a; color: #fff; border-color: #3a3a3a; }
#md-body { background: #2a2a2a; border-top: 1px solid #3a3a3a; padding: 16px 18px;
  overflow-y: auto; flex: 1; min-height: 320px; }
.md-card { background: #242424; border: 1px solid #383838; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
.md-card .md-title { font-weight: 600; font-size: 13px; margin-bottom: 6px; word-break: break-all; }
.md-card .md-meta { font-size: 12px; color: #999; margin-bottom: 6px; }
.md-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 6px; }
.md-pill.bad { background: #4a1f1f; color: #ff8080; }
.md-pill.ok { background: #1f3a24; color: #7fdc9a; }
.md-pill.info { background: #1f2a4a; color: #8ab4ff; }
.md-link { color: #6cb6ff; text-decoration: none; margin-right: 10px; font-size: 12px; word-break: break-all; }
.md-link:hover { text-decoration: underline; }
.md-btn { cursor: pointer; border: 1px solid #4a6fa5; background: #2f4a73; color: #fff;
  padding: 6px 14px; border-radius: 8px; font-size: 12px; }
.md-btn:hover { background: #3a5c8f; }
.md-btn.ghost { background: transparent; border-color: #555; color: #ccc; }
.md-btn.ghost:hover { background: #333; color: #fff; }
.md-btn.danger { background: #6e2b2b; border-color: #8f3a3a; }
.md-btn.danger:hover { background: #8a3636; }
.md-btn:disabled { opacity: .5; cursor: not-allowed; }
.md-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.md-empty { text-align: center; color: #777; padding: 40px 0; font-size: 13px; }
.md-error { background: #4a1f1f; color: #ff9c9c; border-radius: 8px; padding: 10px 14px; font-size: 12px; margin-bottom: 12px; }
.md-table-wrap { overflow-x: auto; max-width: 100%; }
.md-table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
.md-table th { text-align: left; color: #999; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #3a3a3a; white-space: nowrap; overflow: hidden; }
.md-table td { padding: 5px 8px; border-bottom: 1px solid #303030; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-table td.wrap { white-space: normal; word-break: break-all; }
.md-table td.path { color: #8ab4ff; font-family: monospace; font-size: 11px; cursor: copy; }
.md-table td.path:hover { color: #a8ccff; }
.md-table tr:hover td { background: #2e2e2e; }
.md-spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #666; border-top-color: #fff;
  border-radius: 50%; animation: mdspin .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
@keyframes mdspin { to { transform: rotate(360deg); } }
.md-input { background: #1c1c1c; border: 1px solid #444; color: #eee; border-radius: 6px;
  padding: 5px 10px; font-size: 12px; }
#md-float-ball { position: fixed; right: 22px; bottom: 110px; width: 52px; height: 52px;
  border-radius: 50%; background: linear-gradient(135deg, #4a6fa5, #7b4aa5);
  box-shadow: 0 4px 16px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.25);
  display: flex; align-items: center; justify-content: center; font-size: 24px;
  cursor: grab; user-select: none; z-index: 2147483000; transition: transform .15s, box-shadow .15s;
  border: 1px solid rgba(255,255,255,.18); }
#md-float-ball:hover { transform: scale(1.1); box-shadow: 0 6px 22px rgba(74,111,165,.6); }
#md-float-ball:active { cursor: grabbing; }
#md-float-ball .md-ball-tip { position: absolute; right: 60px; top: 50%; transform: translateY(-50%);
  background: #1e1e1e; color: #eee; border: 1px solid #444; border-radius: 8px;
  padding: 4px 10px; font-size: 12px; white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity .15s; }
#md-float-ball:hover .md-ball-tip { opacity: 1; }
.md-check { width: 15px; height: 15px; accent-color: #4a6fa5; cursor: pointer; }
#md-pop { position: fixed; inset: 0; z-index: 2147483001; display: none;
  align-items: center; justify-content: center; background: rgba(0,0,0,.35); }
.md-pop-box { min-width: 320px; max-width: 660px; width: fit-content; background: #222;
  border: 1px solid #4a6fa5; border-radius: 12px; padding: 16px 18px; color: #eee;
  box-shadow: 0 12px 40px rgba(0,0,0,.55); font-family: sans-serif; }
.md-pop-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #fff; }
.md-pop-msg { font-size: 12px; color: #ccc; white-space: pre-wrap; margin-bottom: 12px;
  max-height: 42vh; overflow-y: auto; line-height: 1.7; }
.md-pop-btns { display: flex; gap: 10px; justify-content: flex-end; }
.md-pop-input { width: 100%; box-sizing: border-box; margin-bottom: 12px; }
` });
    document.head.appendChild(style);
}

// ---------------------------------------------------------------- 面板框架

function buildDialog() {
    injectStyle();

    const tabBar = el("div", { id: "md-tabs" },
        [
            ["nodes", "🔎 缺失节点"],
            ["models", "📦 缺失模型"],
            ["aged", "🕰 老旧模型"],
            ["dedupe", "♻️ 查重"],
            ["mapper", "🗺 目录映射"],
            ["cleanup", "🧹 清理"],
            ["env", "🧪 环境"],
        ].map(([id, label]) =>
            el("div", { class: "md-tab", "data-tab": id, text: label,
                        onclick: () => switchTab(id) })));

    const body = el("div", { id: "md-body" });

    // 使用普通 div 遮罩而非原生 <dialog>，避免 top-layer 被其他扩展
    // （翻译/悬浮窗类插件）覆盖导致按钮无法点击的兼容问题
    MD.overlay = el("div", { id: "md-overlay" }, [
        MD.dialogEl = el("div", { id: "md-dialog" }, [
            el("div", { id: "md-head", title: "按住可拖动窗口" }, [
                el("h3", { text: "🩺 ComfyUI 体检中心" }),
                el("span", { id: "md-ver-badge", class: "md-pill info", text: "v…",
                             title: "MissingDoctor 版本号（环境标签页可检查更新）" }),
                el("span", { class: "md-sub", text: "MissingDoctor · 缺失检测 / 下载推荐 / 老旧模型 / 清理" }),
                el("button", { id: "md-close", text: "✕", title: "关闭（Esc / 点击空白处也可关闭）",
                    onclick: closeDialog }),
            ]),
            tabBar,
            body,
        ]),
    ]);

    // 关闭：X 按钮 / Esc / 点击空白处
    MD.overlay.addEventListener("click", (ev) => {
        if (ev.target === MD.overlay) closeDialog();
    });
    MD.escHandler = (ev) => {
        if (ev.key === "Escape" && MD.overlay && MD.overlay.style.display !== "none") {
            ev.stopPropagation();
            closeDialog();
        }
    };
    document.addEventListener("keydown", MD.escHandler, true);

    // 标题栏拖动 + 位置记忆
    const head = MD.overlay.querySelector("#md-head");
    const dialog = MD.dialogEl;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        const r = dialog.getBoundingClientRect();
        ox = r.left; oy = r.top;
        try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
    });
    head.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const w = dialog.offsetWidth, h = dialog.offsetHeight;
        let nx = ox + (e.clientX - sx);
        let ny = oy + (e.clientY - sy);
        // 限制窗口至少保留 120px 可见，避免拖丢
        nx = Math.max(120 - w, Math.min(nx, window.innerWidth - 120));
        ny = Math.max(0, Math.min(ny, window.innerHeight - 60));
        dialog.style.position = "fixed";
        dialog.style.left = nx + "px";
        dialog.style.top = ny + "px";
        dialog.style.margin = "0";
    });
    head.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        // 记住位置
        const r = dialog.getBoundingClientRect();
        try { localStorage.setItem("md_dialog_pos", JSON.stringify({ left: r.left, top: r.top })); } catch (err) { /* ignore */ }
    });
    head.addEventListener("pointercancel", () => { dragging = false; });

    document.body.appendChild(MD.overlay);
}

function switchTab(id) {
    MD.currentTab = id;
    try { localStorage.setItem("md_last_tab", id); } catch (err) { /* ignore */ }
    document.querySelectorAll(".md-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.tab === id));
    const body = document.getElementById("md-body");
    body.innerHTML = "";
    if (id === "nodes") renderNodesTab(body);
    else if (id === "models") renderModelsTab(body);
    else if (id === "aged") renderAgedTab(body);
    else if (id === "dedupe") renderDedupeTab(body);
    else if (id === "mapper") renderMapperTab(body);
    else if (id === "cleanup") renderCleanupTab(body);
    else if (id === "env") renderEnvTab(body);
}

function openDialog() {
    if (!MD.overlay || !document.body.contains(MD.overlay)) buildDialog();
    MD.overlay.style.display = "flex";
    // 恢复上次拖动位置
    const dialog = MD.dialogEl;
    try {
        const saved = JSON.parse(localStorage.getItem("md_dialog_pos") || "null");
        if (saved && typeof saved.left === "number") {
            const w = dialog.offsetWidth || 960;
            const h = dialog.offsetHeight || 600;
            const left = Math.max(120 - w, Math.min(saved.left, window.innerWidth - 120));
            const top = Math.max(0, Math.min(saved.top, window.innerHeight - 60));
            dialog.style.position = "fixed";
            dialog.style.left = left + "px";
            dialog.style.top = top + "px";
            dialog.style.margin = "0";
        } else {
            dialog.style.position = "";
            dialog.style.left = "";
            dialog.style.top = "";
            dialog.style.margin = "";
        }
    } catch (err) { /* ignore */ }

    // 记住上次停留的标签页，并自动检测当前工作流的缺失节点
    let tab = "nodes";
    try { tab = localStorage.getItem("md_last_tab") || "nodes"; } catch (err) { /* ignore */ }
    switchTab(tab);
    if (tab === "nodes") {
        const btn = document.querySelector("#md-body button");
        if (btn && btn.textContent.includes("检测当前工作流")) btn.click();
    }
    // 清除旧的过期提示 + 启动画布变化监测
    MD.staleBarShown = false;
    document.getElementById("md-stale-bar")?.remove();
    workflowSignature().then(s => { MD.wfSig = s.sig; });
    startStaleWatch();
    // 异步填充标题栏版本徽标
    loadAbout;
    (async () => {
        try {
            if (!MD_VER_CACHE) MD_VER_CACHE = await mdFetch("/md/version");
            const badge = document.getElementById("md-ver-badge");
            if (badge) badge.textContent = "v" + MD_VER_CACHE.version;
        } catch (e) { /* ignore */ }
    })();
}

function closeDialog() {
    try {
        if (MD.overlay) MD.overlay.style.display = "none";
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- Tab1: 缺失节点

async function startNodeInstall(items, hintEl) {
    const r = await mdFetch("/md/install_start", { method: "POST", body: { items } });
    if (!r.ok) throw new Error(r.error || "安装启动失败");

    const timer = setInterval(async () => {
        let s;
        try { s = await mdFetch("/md/install_status"); } catch (e) { return; }
        if (hintEl) {
            hintEl.innerHTML = "";
            const cur = s.jobs.find(j => j.status === "cloning");
            const head = el("div", { class: "md-row", style: "margin-bottom:6px" }, [
                el("span", { class: "md-pill info",
                    text: s.running
                        ? `⚡ 正在安装 ${s.done_count + (cur ? 1 : 0)}/${s.total}：${cur ? cur.name : "..."}` + (cur ? "（git clone 中，视网络可能需要几分钟）" : "")
                        : `安装结束：成功 ${s.jobs.filter(j => j.status === "done").length} · 已存在 ${s.jobs.filter(j => j.status === "exists").length} · 失败 ${s.jobs.filter(j => j.status === "failed").length}` }),
            ]);
            hintEl.appendChild(head);
            const list = el("div");
            for (const j of s.jobs) {
                const icon = { done: "✅", exists: "⏭", failed: "❌", cloning: "⏳", pending: "•" }[j.status] || "•";
                const statusText =
                    j.status === "done" ? "安装成功" :
                    j.status === "exists" ? "目录已存在，跳过" :
                    j.status === "failed" ? "失败：" + (j.error || "") :
                    j.status === "cloning" ? "克隆中…" : "等待中";
                const kids = [el("span", { text: `${icon} ${j.name} ` }),
                              el("span", { style: "color:#888;font-size:11px", text: statusText })];
                if (j.status === "done" && j.has_requirements) {
                    kids.push(el("button", { class: "md-btn ghost", text: "🧩 装依赖",
                        title: "该插件自带 requirements.txt，一键安装依赖（否则重启后插件可能加载失败）",
                        onclick: async () => {
                            try {
                                await mdFetch("/md/pip_install", { method: "POST",
                                    body: { requirements_file: j.target + "/requirements.txt" } });
                                watchPip();
                            } catch (e) { mdAlert("安装失败：" + e.message); }
                        } }));
                }
                list.appendChild(el("div", { style: "font-size:12px;margin-bottom:3px" }, kids));
            }
            hintEl.appendChild(list);
            if (s.done_count >= s.total) {
                clearInterval(timer);
                const failed = s.jobs.filter(j => j.status === "failed");
                const ok = s.jobs.filter(j => j.status === "done");
                if (ok.length) {
                    hintEl.appendChild(el("div", { class: "md-card", style: "border-color:#2f5c3a;margin-top:8px" }, [
                        el("div", { class: "md-title", style: "color:#7fdc9a",
                            text: `🎉 已安装 ${ok.length} 个节点包到 custom_nodes` }),
                        el("div", { class: "md-meta", style: "color:#ffb060",
                            text: "⚠️ 需要【重启 ComfyUI】才能加载新节点；若插件自带 requirements.txt，重启后仍缺依赖可手动 pip install" }),
                    ]));
                }
                if (failed.length) {
                    hintEl.appendChild(el("div", { class: "md-error",
                        text: "失败列表：\n" + failed.map(j => j.name + ": " + (j.error || "")).join("\n") }));
                }
            }
        }
        if (!s.running && s.done_count >= s.total) clearInterval(timer);
    }, 1000);
}

// 在画布上定位并高亮指定类型的节点
// - 递归搜索主图与子图（subgraph）
// - 同类型多个节点时循环定位（每点一次切到下一个）
// - 优先用 ComfyUI 官方居中 API，兜底自算偏移
const MD_LOCATE_IDX = {};   // ct -> 上次定位的节点序号（循环定位用）

function _collectNodesDeep(graph, ct, out, seen) {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const n of (graph._nodes || [])) {
        if (n && n.type === ct) out.push(n);
    }
    // 新版 ComfyUI 子图：节点可能挂在 .subgraph / 全局 _subgraphs
    for (const n of (graph._nodes || [])) {
        const sg = n && (n.subgraph || (n.properties && n.properties.subgraph));
        if (sg && sg._nodes && !seen.has(sg)) _collectNodesDeep(sg, ct, out, seen);
    }
    for (const sg of (graph._subgraphs || [])) {
        if (sg && sg._nodes && !seen.has(sg)) _collectNodesDeep(sg, ct, out, seen);
    }
}

function _flashNode(n) {
    const old = n.bgcolor;
    let i = 0;
    const tick = () => {
        n.bgcolor = (i % 2 === 0) ? "#6e2b0a" : old;
        i++;
        if (i < 6) setTimeout(tick, 450);
        else { n.bgcolor = old; n.selected = false; }
        if (n.graph && typeof n.graph.setDirtyCanvas === "function") n.graph.setDirtyCanvas(true, true);
    };
    n.selected = true;
    tick();
}

function locateNode(ct, ghost) {
    const app = window.app;
    const graph = app && app.graph;
    const c = app && app.canvas;
    if (!graph) return;
    const found = [];
    _collectNodesDeep(graph, ct, found, new Set());
    if (!found.length) {
        mdAlert("当前画布上没有找到「" + ct + "」节点（可能位于另一个标签页或尚未载入的工作流）");
        return;
    }
    // 多个同名节点循环定位：每次点击切到下一个
    const idx = (MD_LOCATE_IDX[ct] || 0) % found.length;
    MD_LOCATE_IDX[ct] = idx + 1;
    const node = found[idx];
    try {
        // 缩放保底：太小时先放大，保证能看到
        if (c && c.ds && (c.ds.scale || 1) < 0.6) c.ds.scale = 0.6;
        let centered = false;
        if (c && typeof c.centerOnNode === "function") {
            c.centerOnNode(node); centered = true;               // ComfyUI/litegraph 官方 API
        } else if (c && c.ds && typeof c.ds.focusNode === "function") {
            c.ds.focusNode(node); centered = true;
        } else if (c && c.ds) {
            // 兜底：自算偏移（节点中心 → 视口中心）
            const rel = (typeof graph.computeRelativePosition === "function")
                ? graph.computeRelativePosition(node) : [node.pos[0], node.pos[1]];
            const size = node.size || [220, 60];
            const s = c.ds.scale || 1;
            const w = (c.canvas && (c.canvas.width || c.canvas.clientWidth)) || window.innerWidth;
            const h = (c.canvas && (c.canvas.height || c.canvas.clientHeight)) || window.innerHeight;
            c.ds.offset = [w / 2 - (rel[0] + size[0] / 2) * s,
                           h / 2 - (rel[1] + size[1] / 2) * s];
            centered = true;
        }
        if (centered && typeof c.setDirty === "function") c.setDirty(true, true);
    } catch (e) { console.warn("[MissingDoctor] 定位失败", e); }
    if (typeof graph.setDirtyCanvas === "function") graph.setDirtyCanvas(true, true);
    _flashNode(node);
    // 自动关闭面板，让用户直接看到画布上的高亮节点
    closeDialog();
}

function renderNodesTab(body) {
    const resultBox = el("div");
    const installBox = el("div");
    const runBtn = el("button", { class: "md-btn", text: "🔍 检测当前工作流", onclick: () => run() });

    async function run() {
        resultBox.innerHTML = "";
        installBox.innerHTML = "";
        resultBox.appendChild(el("div", { class: "md-empty" },
            [el("span", { class: "md-spin" }), "正在对比工作流与已安装节点..."]));
        runBtn.disabled = true;
        try {
            const sig = await workflowSignature();
            MD.wfSig = sig.sig;
            MD.detectMeta = { time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), count: sig.count };
            const gp = await Promise.resolve(app.graphToPrompt());
            const data = await mdFetch("/md/check_nodes", {
                method: "POST", body: { workflow: { prompt: gp.output, ui: gp.workflow } } });
            renderResult(data);
        } catch (e) {
            resultBox.innerHTML = "";
            resultBox.appendChild(el("div", { class: "md-error", text: "检测失败：" + e.message }));
        } finally {
            runBtn.disabled = false;
        }
    }

    // 节点搜索不到时的可行行动指引（后端 node_advice；缺省时给静态幽灵提示）
    function renderNodeAdvice(advice, ct) {
        if (!advice) {
            return el("div", { class: "md-card", style: "border-color:#6e5a20;margin-top:6px" }, [
                el("div", { class: "md-title", style: "color:#ffd54a", text: "👻 疑似幽灵节点" }),
                el("div", { class: "md-meta", style: "color:#ccc",
                    text: "未找到提供该节点的插件或仓库。这类节点通常是：AI 编造的节点名 / 原作者私有插件 / 旧版已改名或删除的节点。" }),
                el("div", { style: "font-size:12px;color:#eee;line-height:1.8;margin-top:6px",
                    text: "处理建议：① 在画布上查看该节点连接了什么，用基础节点或真实等效节点替代；② 向工作流作者确认所需插件；③ ComfyUI 双击空白处搜节点名，仍找不到即为幽灵节点。" }),
            ]);
        }
        const ul = el("div", { style: "font-size:12px;line-height:1.9" });
        (advice.tips || []).forEach((t, i) => {
            ul.appendChild(el("div", {
                style: (i === 0 ? "color:#8ab4ff;font-weight:600" : "color:#ccc"),
                text: t }));
        });
        return el("div", { class: "md-card", style: "border-color:#6e5a20;margin-top:6px" }, [
            el("div", { class: "md-title", style: "color:#ffd54a", text: "🤔 没找到可信候选，试试这些办法：" }),
            el("div", { class: "md-meta", text: advice.reason || "" }),
            ul,
            el("div", { class: "md-row", style: "margin:6px 0 2px" }, [
                el("span", { text: "🔎 直接搜索：", style: "font-size:12px;color:#aaa" }),
                el("a", { class: "md-link", href: "https://github.com/search?q=" + encodeURIComponent('NODE_CLASS_MAPPINGS "' + ct + '"') + "&type=code", target: "_blank", text: "GitHub 代码搜索" }),
                el("a", { class: "md-link", href: "https://github.com/search?q=" + encodeURIComponent(ct) + "&type=repositories", target: "_blank", text: "GitHub 仓库搜索" }),
                el("a", { class: "md-link", href: "https://www.google.com/search?q=" + encodeURIComponent('ComfyUI ' + ct + ' custom node'), target: "_blank", text: "Google" }),
                el("a", { class: "md-link", href: "https://www.bing.com/search?q=" + encodeURIComponent('ComfyUI ' + ct + ' 节点'), target: "_blank", text: "Bing" }),
            ]),
        ]);
    }

    function renderResult(data) {
        resultBox.innerHTML = "";
        const summary = el("div", { class: "md-row" }, [
            el("span", { class: "md-pill info", text: `已安装节点 ${data.installed_count}` }),
            el("span", { class: "md-pill info", text: `工作流使用 ${data.used_count}` }),
            data.missing_count > 0
                ? el("span", { class: "md-pill bad", text: `缺失 ${data.missing_count}` })
                : el("span", { class: "md-pill ok", text: "无缺失节点 ✓" }),
        ]);
        resultBox.appendChild(summary);

        // 检测元信息：时间 + 画布节点数 + 可展开的使用节点清单（确认是当前流）
        if (MD.detectMeta) {
            const listOpen = el("details", { style: "margin:4px 0 8px" }, [
                el("summary", { style: "cursor:pointer;font-size:11px;color:#888",
                    text: `检测于 ${MD.detectMeta.time} · 基于当前画布 ${MD.detectMeta.count} 种节点（点击展开清单核对）` }),
                el("div", { style: "font-family:monospace;font-size:11px;color:#8ab4ff;margin-top:4px;word-break:break-all",
                    text: (data.used_nodes || []).join("、") }),
            ]);
            resultBox.appendChild(listOpen);
        }

        if (!data.missing_nodes || data.missing_nodes.length === 0) {
            resultBox.appendChild(el("div", { class: "md-empty", text: "当前工作流的所有节点均已安装，无需处理 🎉" }));
            return;
        }

        // 一键安装：每个缺失节点取第一个 manager-db / comfyicu 匹配的候选仓库
        const batch = [];
        const noMatch = [];
        for (const ct of data.missing_nodes) {
            const sug = (data.suggestions && data.suggestions[ct]) || [];
            const best = sug.find(s => (s.match === "manager-db" || s.match === "comfyicu") && s.repo);
            if (best) batch.push({ url: best.repo, title: ct });
            else noMatch.push(ct);
        }
        if (batch.length) {
            resultBox.appendChild(el("div", { class: "md-row" }, [
                el("button", { class: "md-btn", text: `⚡ 一键安装全部缺失节点（${batch.length} 个）`, title:
                    "用 git clone 自动安装到 custom_nodes，完成后需重启 ComfyUI 生效", onclick: async () => {
                    if (!(await mdConfirm(`确认用 git clone 自动安装 ${batch.length} 个节点包到 custom_nodes 吗？\n\n${batch.map(b => "· " + b.title).join("\n")}\n\n安装完成后需要重启 ComfyUI 生效。`))) return;
                    try {
                        await startNodeInstall(batch, installBox);
                    } catch (e) { mdAlert("安装启动失败：" + e.message); }
                } }),
                el("span", { class: "md-sub", style: "color:#888;font-size:12px", text: "git clone 浅克隆，自动跳过已安装的" }),
            ]));
        }
        if (noMatch.length) {
            resultBox.appendChild(el("div", { class: "md-meta", style: "color:#ffb060;font-size:12px",
                text: "⚠️ 以下节点在数据库中未找到对应仓库，请手动搜索安装：" + noMatch.join("、") }));
        }

        for (const ct of data.missing_nodes) {
            const sug = (data.suggestions && data.suggestions[ct]) || [];
            const links = sug.map(s => {
                const repo = s.repo || "";
                const badge = s.match === "manager-db"
                    ? el("span", { class: "md-pill ok", title: "来自 ComfyUI-Manager 数据库匹配", text: "📚 库匹配" })
                    : (s.match === "comfyicu"
                        ? el("span", { class: "md-pill ok", title: "来自 comfy.icu 节点目录（按节点类名精确收录，新热节点优先）", text: "🗂 comfy.icu" })
                        : (s.verify === true && s.verify_level === "code"
                            ? el("span", { class: "md-pill ok", title: "已在仓库源码中找到该节点的 NODE_CLASS_MAPPINGS 定义，可放心安装", text: "✓ 代码验证" })
                            : (s.verify === true
                                ? el("span", { class: "md-pill ok", title: "该仓库 README 中提及此节点名（建议点链接核对后安装）", text: "📖 README 提及" })
                                : (s.verify === false
                                    ? el("span", { class: "md-pill bad", title: "仓库源码/README 中未找到此节点名，请核对后再安装", text: "⚠️ 待核对" })
                                    : el("span", { class: "md-pill info", title: "GitHub 关键词搜索，未能验证源码", text: "🔍 搜索候选" })))));
                return el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px" }, [
                    el("a", { class: "md-link", href: repo, target: "_blank",
                              text: `${s.title || repo}` }),
                    badge,
                    el("button", { class: "md-btn", text: "⚡ 自动安装", title: "git clone 到 custom_nodes，重启 ComfyUI 后生效",
                        onclick: async (ev) => {
                            if (!(await mdConfirm(`确认安装 ${s.title || repo} 到 custom_nodes 吗？\n安装完成后需要重启 ComfyUI 生效。`))) return;
                            try {
                                await startNodeInstall([{ url: repo, title: ct }], installBox);
                            } catch (e) { mdAlert("安装启动失败：" + e.message); }
                        } }),
                    el("button", { class: "md-btn ghost", text: "复制 clone 命令", onclick: (ev) => {
                        navigator.clipboard.writeText(`git clone "${repo}"`).then(() => {
                            ev.target.textContent = "已复制 ✓";
                            setTimeout(() => (ev.target.textContent = "复制 clone 命令"), 1500);
                        });
                    } }),
                    el("button", { class: "md-btn ghost", text: "🚩 不对", title: "该候选不是提供此节点的仓库，标记后以后不再推荐",
                        onclick: async (ev) => {
                            const correct = await mdPrompt("如果知道正确的仓库地址请填写（不知道可直接确定）：", "");
                            if (correct === null) return;
                            try {
                                await mdFetch("/md/feedback", { method: "POST",
                                    body: { type: "node", key: ct, repo, correct: correct.trim() || undefined } });
                                ev.target.textContent = "已反馈 ✓";
                                ev.target.disabled = true;
                                setTimeout(() => (ev.target.textContent = "🚩 不对"), 2000);
                            } catch (e) { mdAlert("反馈失败：" + e.message); }
                        } }),
                ]);
            });
            resultBox.appendChild(el("div", { class: "md-card" }, [
                el("div", { class: "md-row", style: "margin-bottom:4px;align-items:center" }, [
                    el("div", { class: "md-title", style: "margin:0" }, [
                        "❌ " + ct,
                        !links.length ? el("span", { class: "md-pill bad", style: "margin-left:8px",
                            title: "未找到任何提供该节点的插件/仓库，疑似幽灵节点", text: "👻 疑似幽灵" }) : null,
                    ]),
                ]),
                el("div", { class: "md-row", style: "margin-bottom:6px" }, [
                    el("button", { class: "md-btn", text: "📍 在画布上定位",
                        title: "高亮并居中到该节点；画布上有多个同名节点时，每点一次切换定位到下一个（幽灵节点同样可定位）",
                        onclick: () => locateNode(ct) }),
                    el("span", { class: "md-sub", style: "color:#888;font-size:12px", text: "点击后自动跳到画布位置" }),
                ]),
                el("div", { class: "md-meta", text: "候选安装来源：" }),
                ...(links.length ? links : [
                    renderNodeAdvice((data.node_advice && data.node_advice[ct]) || null, ct),
                ]),
            ]));
        }
    }

    body.appendChild(installBox);
    body.appendChild(el("div", { class: "md-row" }, [
        runBtn,
        el("span", { class: "md-sub", style: "color:#888;font-size:12px", text: "分析当前画布工作流引用的节点是否已安装，缺失的可一键 git clone 自动安装" }),
    ]));
    body.appendChild(resultBox);
    resultBox.appendChild(el("div", { class: "md-empty", text: "点击「检测当前工作流」开始检查" }));
}

// ---------------------------------------------------------------- Tab2: 缺失模型

let MD_FOLDERS = null;

async function getFolders() {
    if (!MD_FOLDERS) {
        try {
            MD_FOLDERS = (await mdFetch("/md/model_folders")).folders || [];
        } catch (e) {
            MD_FOLDERS = [
                { name: "checkpoints", paths: [""] }, { name: "loras", paths: [""] },
                { name: "vae", paths: [""] }, { name: "controlnet", paths: [""] },
                { name: "diffusion_models", paths: [""] }, { name: "upscale_models", paths: [""] },
            ];
        }
    }
    return MD_FOLDERS;
}

function guessFolderName(filename, defaultFolder) {
    // 检测已有目录提示时直接采用；否则按文件名关键词智能推断
    if (defaultFolder) return defaultFolder;
    const n = (filename || "").toLowerCase();
    const rules = [
        ["vae", "vae"], ["lora", "loras"], ["clip", "text_encoders"],
        ["text_encoder", "text_encoders"], ["unet", "diffusion_models"],
        ["diffusion", "diffusion_models"], ["upscale", "upscale_models"],
        ["ultralytics", "ultralytics_bbox"], ["sam", "sams"],
        ["controlnet", "controlnet"], ["embed", "embeddings"],
        ["ipadapter", "ipadapter"], ["ckpt", "checkpoints"], ["checkpoint", "checkpoints"],
    ];
    for (const [kw, dir] of rules) {
        if (n.includes(kw)) return dir;
    }
    return "";
}

async function startModelDownload(url, filename, defaultFolder, hintEl) {
    const folders = await getFolders();
    // 每个注册路径一个选项（同一目录名可能有多路径）
    const options = [];
    folders.forEach(f => {
        (f.paths || []).forEach(p => {
            options.push({ name: f.name, path: p,
                           label: `${f.name} — ${p || "(默认路径)"}` });
        });
    });
    // 智能推断推荐目录：置顶 + 标记
    const guessed = guessFolderName(filename, defaultFolder);
    let defIdx = 0;
    if (guessed) {
        const gi = options.findIndex(o => o.name === guessed);
        if (gi >= 0) {
            const [rec] = options.splice(gi, 1);
            rec.label = "★ 推荐 " + rec.label;
            options.unshift(rec);
        } else {
            options[0].label = "★ 推荐（按文件名猜测） " + options[0].label;
        }
    }

    // 内联选择器：下拉选注册路径 + 自定义路径输入
    hintEl.innerHTML = "";
    const picker = el("div", { class: "md-card", style: "border-color:#4a6fa5" }, [
        el("div", { class: "md-title", text: "📂 选择下载目标目录" }),
        el("div", { class: "md-row" }, [
            el("span", { text: "文件: ", style: "font-size:12px;color:#aaa" }),
            el("span", { style: "font-size:12px;color:#ddd", text: filename }),
        ]),
    ]);
    const sel = el("select", { class: "md-input", style: "width:100%;max-width:640px" },
        options.map((o, i) => el("option", { value: String(i), text: o.label })));
    sel.value = String(defIdx);

    const customCheck = el("input", { type: "checkbox", class: "md-check", id: "md-custom-dl" });
    const customInput = el("input", { class: "md-input", style: "flex:1;min-width:300px;display:none",
        placeholder: "输入完整文件夹路径，如 H:\\ComfyUI\\ComfyUI\\models\\checkpoints" });
    customCheck.addEventListener("change", () => {
        customInput.style.display = customCheck.checked ? "block" : "none";
        sel.style.display = customCheck.checked ? "none" : "block";
    });

    const startBtn = el("button", { class: "md-btn", text: "⬇ 开始下载", onclick: async () => {
        let dest = null, folderName = "";
        if (customCheck.checked) {
            dest = customInput.value.trim();
            if (!dest) { mdAlert("请输入自定义路径"); return; }
            folderName = dest.split("\\").pop() || dest;
        } else {
            const o = options[parseInt(sel.value, 10)] || options[0];
            dest = o.path;
            folderName = o.name;
        }
        try {
            const start = await mdFetch("/md/download_start", {
                method: "POST", body: { url, filename, folder_type: folderName, dest_dir: dest } });
            if (!start.ok) { mdAlert("下载启动失败：" + (start.error || "未知错误")); return; }
            picker.remove();
            // 轮询进度
            const timer = setInterval(async () => {
                let s;
                try { s = await mdFetch("/md/download_status"); } catch (e) { return; }
                if (hintEl) {
                    if (s.running) {
                        hintEl.innerHTML = "";
                        const bar = el("div", { class: "md-progress" }, [
                            el("div", { style: `width:${s.percent}%` }),
                            el("span", { class: "md-progress-text",
                                text: `⬇ ${s.filename} ${fmtBytes(s.downloaded)} / ${fmtBytes(s.total)} · ${fmtBytes(s.speed)}/s · ${s.percent}%` }),
                        ]);
                        hintEl.appendChild(bar);
                    } else if (s.done) {
                        clearInterval(timer);
                        hintEl.innerHTML = "";
                        if (s.error) {
                            hintEl.appendChild(el("div", { class: "md-error", text: "下载失败：" + s.error }));
                        } else {
                            hintEl.appendChild(el("div", { class: "md-card", style: "border-color:#2f5c3a" }, [
                                el("div", { class: "md-title", style: "color:#7fdc9a", text: "✅ 下载完成: " + s.filename }),
                                el("div", { class: "md-meta", style: "color:#8ab4ff;word-break:break-all",
                                    text: "已保存到: " + s.target }),
                                el("div", { class: "md-meta", text: "重新打开工作流即可使用" }),
                            ]));
                        }
                    }
                }
                if (!s.running && s.done) clearInterval(timer);
            }, 1000);
        } catch (e) { mdAlert("下载启动失败：" + e.message); }
    } });

    picker.appendChild(el("div", { class: "md-row", style: "align-items:flex-start" }, [
        el("div", { style: "flex:1;min-width:280px" }, [
            el("div", { style: "font-size:11px;color:#888;margin-bottom:4px", text: "注册的模型目录：" }),
            sel,
        ]),
    ]));
    picker.appendChild(el("div", { class: "md-row", style: "align-items:center" }, [
        customCheck,
        el("label", { for: "md-custom-dl", text: "自定义路径（任意文件夹）", style: "font-size:12px;color:#aaa;cursor:pointer" }),
    ]));
    picker.appendChild(customInput);
    picker.appendChild(el("div", { class: "md-row" }, [startBtn]));
    hintEl.appendChild(picker);
}

// 判断候选是否为"仓库页"（而非文件直链）
// 优先用后端 kind 字段；无 kind 时按 URL 形状推断：
//  - 含 /resolve/ → 文件直链
//  - HF 域且路径仅 owner/repo 两段 → 仓库页（仓库名可能恰好带扩展名）
//  - 其余按扩展名判断
function isRepoCandidate(d) {
    if (d.kind === "file") return false;
    if (d.kind === "repo") return true;
    const url = d.url || "";
    if (/\/api\/download\//.test(url)) return false;   // Civitai 稳定下载直链
    if (/\/resolve\//.test(url)) return false;          // HF resolve 直链
    if (/hf-mirror\.com|huggingface\.co/i.test(url)) {
        const path = url.replace(/^https?:\/\/[^/]+\//, "").split("?")[0];
        if (path.split("/").filter(Boolean).length <= 2) return true;
    }
    return !/\.(safetensors|sft|gguf|ckpt|pth|pt2|bin|onnx|zip|tar\.gz)(\?|$)/i.test(url);
}

function renderAdvice(advice, container) {
    if (!advice) return;
    const kw = (advice.query || "").trim();
    const enc = encodeURIComponent(kw || "");
    const sites = [
        ["🇨🇳 ModelScope 魔搭", "https://modelscope.cn/search?searchContent=" + enc],
        ["🇨🇳 LiblibAI 哩布哩布", "https://www.liblib.art/search?keyword=" + enc],
        ["🌍 Civitai", "https://civitai.com/search/" + enc],
        ["🌍 HF 镜像", "https://hf-mirror.com/search?fulltext=1&q=" + enc],
    ];
    // 站点按钮组始终显示（有候选时也可去其他站点找更合适的版本）
    const siteRow = el("div", { class: "md-row", style: "margin:4px 0 10px" }, [
        el("span", { text: "🔎 去这些站点搜索「" + kw + "」：", style: "font-size:12px;color:#aaa" }),
    ]);
    sites.forEach(([label, url]) => {
        siteRow.appendChild(el("a", { class: "md-link", href: url, target: "_blank", text: label }));
    });
    if (advice.found) {
        container.appendChild(el("div", { class: "md-card", style: "border-color:#2f5c3a" }, [
            el("div", { class: "md-title", style: "color:#7fdc9a", text: "💡 候选可信度说明" }),
            el("div", { style: "font-size:12px;color:#aaa", text: advice.tips.join("  ") }),
        ]));
        container.appendChild(siteRow);
        return;
    }
    const card = el("div", { class: "md-card", style: "border-color:#6e5a20" }, [
        el("div", { class: "md-title", style: "color:#ffd54a", text: "🤔 没有找到现成候选，但还有这些办法：" }),
        el("div", { class: "md-meta", text: advice.reason || "" }),
    ]);
    const ul = el("div", { style: "font-size:12px;line-height:1.9" });
    (advice.tips || []).forEach((t, i) => {
        ul.appendChild(el("div", {
            style: (i === 0 ? "color:#8ab4ff;font-weight:600" : "color:#ccc"),
            text: t }));
    });
    card.appendChild(ul);
    container.appendChild(card);
    container.appendChild(siteRow);
}

function renderModelsTab(body) {
    const resultBox = el("div");
    const dlStatus = el("div");
    const runBtn = el("button", { class: "md-btn", text: "🔍 检测当前工作流", onclick: () => run() });
    const searchInput = el("input", { class: "md-input", style: "min-width:260px",
        placeholder: "搜索模型名（自动查魔搭/Civitai/HF；粘贴魔搭模型页链接可直接解析直链）",
        onkeydown: (e) => { if (e.key === "Enter") doSearch(); } });
    const searchResult = el("div");

    async function doSearch() {
        const q = searchInput.value.trim();
        if (!q) { mdAlert("请输入要搜索的模型名或关键词"); return; }
        searchResult.innerHTML = "";
        searchResult.appendChild(el("div", { class: "md-empty" },
            [el("span", { class: "md-spin" }), "正在搜索 " + q + " ..."]));
        try {
            const r = await mdFetch("/md/remote_search", { method: "POST", body: { query: q } });
            searchResult.innerHTML = "";
            const results = r.results || [];
            if (!results.length) {
                searchResult.appendChild(el("div", { class: "md-empty", text: "没搜到候选" }));
                renderAdvice(r.advice, searchResult);
                return;
            }
            renderAdvice(r.advice, searchResult);
            for (const d of results) {
                const isRepo = isRepoCandidate(d);
                const matchBadge = isRepo ? null :
                    (d.match === "exact"
                        ? el("span", { class: "md-pill ok", text: "✓ 文件匹配" })
                        : el("span", { class: "md-pill info", text: d.match === "near" ? "~ 近似文件" : "🔍 搜索候选" }));
                searchResult.appendChild(el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px" }, [
                    el("a", { class: "md-link", href: d.url, target: "_blank",
                        text: `[${d.source}] ${d.title || d.filename || d.url}` }),
                    matchBadge,
                    isRepo
                        ? el("span", { class: "md-pill info", title: "这是仓库页而非文件直链，请进仓库找对应文件手动下载", text: "📁 仓库参考" })
                        : el("button", { class: "md-btn", text: "⬇ 下载到模型库", onclick: () =>
                            startModelDownload(d.url, d.filename, null, searchResult) }),
                    !isRepo ? el("button", { class: "md-btn ghost", text: "复制链接", onclick: (ev) => {
                        navigator.clipboard.writeText(d.url).then(() => {
                            ev.target.textContent = "已复制 ✓";
                            setTimeout(() => (ev.target.textContent = "复制链接"), 1500);
                        });
                    } }) : null,
                ]));
            }
        } catch (e) {
            searchResult.innerHTML = "";
            searchResult.appendChild(el("div", { class: "md-error", text: "搜索失败：" + e.message }));
        }
    }

    async function run() {
        resultBox.innerHTML = "";
        resultBox.appendChild(el("div", { class: "md-empty" },
            [el("span", { class: "md-spin" }), "正在检查工作流引用的模型文件..."]));
        runBtn.disabled = true;
        try {
            const sig = await workflowSignature();
            MD.wfSig = sig.sig;
            MD.detectMetaModels = { time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), count: sig.count };
            const gp = await Promise.resolve(app.graphToPrompt());
            const data = await mdFetch("/md/check_models", {
                method: "POST", body: { workflow: { prompt: gp.output, ui: gp.workflow } } });
            renderResult(data);
        } catch (e) {
            resultBox.innerHTML = "";
            resultBox.appendChild(el("div", { class: "md-error", text: "检测失败：" + e.message }));
        } finally {
            runBtn.disabled = false;
        }
    }

    function renderResult(data) {
        resultBox.innerHTML = "";
        resultBox.appendChild(el("div", { class: "md-row" }, [
            el("span", { class: "md-pill info", text: `引用模型文件 ${data.checked_values}` }),
            el("span", { class: "md-pill ok", text: `已就绪 ${data.found_count}` }),
            data.missing_count > 0
                ? el("span", { class: "md-pill bad", text: `缺失 ${data.missing_count}` })
                : el("span", { class: "md-pill ok", text: "模型齐全 ✓" }),
        ]));
        if (MD.detectMetaModels) {
            resultBox.appendChild(el("details", { style: "margin:4px 0 8px" }, [
                el("summary", { style: "cursor:pointer;font-size:11px;color:#888",
                    text: `检测于 ${MD.detectMetaModels.time} · 基于当前画布 ${MD.detectMetaModels.count} 种节点` }),
            ]));
        }

        if (!data.missing_models || data.missing_models.length === 0) {
            resultBox.appendChild(el("div", { class: "md-empty", text: "工作流引用的模型文件全部就位，无需处理 🎉" }));
            return;
        }

        for (const m of data.missing_models) {
            const hintEl = el("div");
            const dlLinks = (m.downloads || []).map(d => {
                const isRepo = isRepoCandidate(d);
                const matchBadge = isRepo
                    ? null
                    : (d.dead
                        ? el("span", { class: "md-pill bad", title: "链接已失效（404），换其他候选或手动下载", text: "❌ 已失效" })
                        : (d.auth
                            ? el("span", { class: "md-pill info", title: "该下载需要登录 Civitai，请在浏览器登录后使用「复制链接」手动下载", text: "🔒 需登录" })
                            : (d.match === "exact"
                                ? el("span", { class: "md-pill ok", title: "与缺失文件名精确匹配且已确认存活", text: "✓ 文件匹配" })
                                : (d.match === "near"
                                    ? el("span", { class: "md-pill info", title: "近似文件名，请核对是否为目标模型", text: "~ 近似文件" })
                                    : el("span", { class: "md-pill info", title: "关键词搜索候选，可能不是同一个模型，请核对", text: "🔍 搜索候选" })))));
                const row = el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px" }, [
                    el("a", { class: "md-link", href: d.url, target: "_blank",
                        text: `[${d.source}] ${d.title || d.filename || d.url}` }),
                    matchBadge,
                    isRepo
                        ? el("span", { class: "md-pill info", title: "这是仓库页而非文件直链，请进仓库找对应文件手动下载", text: "📁 仓库参考" })
                        : (d.dead
                            ? el("span", { class: "md-pill bad", text: "链接失效" })
                            : el("button", { class: "md-btn", text: d.auth ? "🌐 浏览器下载" : "⬇ 下载到模型库",
                                title: d.auth ? "登录 Civitai 后在浏览器中下载" : "直接下载到 ComfyUI 对应模型目录",
                                onclick: () => startModelDownload(d.url, d.filename || m.value, m.folders_hint && m.folders_hint[0], hintEl) })),
                    !isRepo && !d.dead ? el("button", { class: "md-btn ghost", text: "复制链接", onclick: (ev) => {
                        navigator.clipboard.writeText(d.url).then(() => {
                            ev.target.textContent = "已复制 ✓";
                            setTimeout(() => (ev.target.textContent = "复制链接"), 1500);
                        });
                    } }) : null,
                    el("button", { class: "md-btn ghost", text: "🚩 不对", title: "该候选不是这个模型/链接不可用，标记后以后不再推荐",
                        onclick: async (ev) => {
                            const correct = await mdPrompt("如果知道正确的下载地址请填写（不知道可直接确定）：", "");
                            if (correct === null) return;
                            try {
                                await mdFetch("/md/feedback", { method: "POST",
                                    body: { type: "model", key: m.value, repo: d.url, correct: correct.trim() || undefined } });
                                ev.target.textContent = "已反馈 ✓";
                                ev.target.disabled = true;
                                setTimeout(() => (ev.target.textContent = "🚩 不对"), 2000);
                            } catch (e) { mdAlert("反馈失败：" + e.message); }
                        } }),
                ]);
                return row;
            });
            resultBox.appendChild(el("div", { class: "md-card" }, [
                el("div", { class: "md-title", text: "❌ " + m.value }),
                el("div", { class: "md-meta", text:
                    `节点 ${[...new Set(m.node_ids)].join(", ")} · 输入 ${[...new Set(m.inputs)].join(", ")}` +
                    (m.folders_hint && m.folders_hint.length ? ` · 应存放于 models/${m.folders_hint.join(" 或 models/")}` : "") }),
                el("div", { class: "md-meta", text: "候选下载（⬇ 可直接下载到模型库）：" }),
                ...(dlLinks.length ? dlLinks : [el("div", { class: "md-meta", text: "自动搜索未找到，可尝试 Civitai / HuggingFace（国内可用 hf-mirror）手动搜索文件名" })]),
                hintEl,
            ]));
        }
        renderAdvice(data.advice, resultBox);
    }

    body.appendChild(dlStatus);
    body.appendChild(el("div", { class: "md-row" }, [
        runBtn,
        el("span", { class: "md-sub", style: "color:#888;font-size:12px", text: "检查工作流引用的 ckpt/lora/vae/controlnet 等，缺失时给出下载地址并可直接下载补全" }),
    ]));
    body.appendChild(el("div", { class: "md-card" }, [
        el("div", { class: "md-row", style: "margin-bottom:6px" }, [
            el("div", { class: "md-title", text: "🔎 手动搜索模型下载" }),
        ]),
        el("div", { class: "md-row" }, [
            searchInput,
            el("button", { class: "md-btn", text: "搜索", onclick: doSearch }),
            el("span", { class: "md-sub", style: "color:#888;font-size:12px", text: "来源：Manager 模型库 / Civitai / HuggingFace（国内镜像）" }),
        ]),
        searchResult,
    ]));
    body.appendChild(resultBox);
    resultBox.appendChild(el("div", { class: "md-empty", text: "点击「检测当前工作流」开始检查" }));
}

// ---------------------------------------------------------------- Tab3: 老旧模型

function renderAgedTab(body) {
    try { MD.agedDays = Math.max(1, parseInt(localStorage.getItem("md_aged_days") || "90", 10) || 90); } catch (e) { /* ignore */ }
    const daysInput = el("input", { class: "md-input", type: "number", min: "1", max: "3650", value: String(MD.agedDays), title: "多少天未修改视为老旧" });
    const sortSel = el("select", { class: "md-input" }, [
        el("option", { value: "oldest", text: "最旧优先" }),
        el("option", { value: "size", text: "最大优先" }),
    ]);
    sortSel.value = MD.agedSort;
    const resultBox = el("div");
    const scanBtn = el("button", { class: "md-btn", text: "🕰 扫描老旧模型", onclick: () => scan() });

    async function scan() {
        MD.agedDays = Math.max(1, parseInt(daysInput.value || "90", 10));
        MD.agedSort = sortSel.value;
        try { localStorage.setItem("md_aged_days", String(MD.agedDays)); } catch (err) { /* ignore */ }
        resultBox.innerHTML = "";
        resultBox.appendChild(el("div", { class: "md-empty" },
            [el("span", { class: "md-spin" }), "正在遍历 models 目录..."]));
        scanBtn.disabled = true;
        try {
            MD.agedData = await mdFetch(`/md/aged_models?days=${MD.agedDays}&sort=${MD.agedSort}`);
            renderList();
        } catch (e) {
            resultBox.innerHTML = "";
            resultBox.appendChild(el("div", { class: "md-error", text: "扫描失败：" + e.message }));
        } finally {
            scanBtn.disabled = false;
        }
    }

    function selectedPaths() {
        return [...resultBox.querySelectorAll("input.md-check:checked")].map(c => c.dataset.path);
    }

    function recentUseLabel(it) {
        if (it.last_used_src === "record") {
            return `${fmtDate(it.last_used)}（${it.last_used_days} 天前）`;
        }
        if (it.last_used_src === "atime") {
            return `≈${fmtDate(it.last_used)}（访问时间）`;
        }
        return "暂无记录";
    }

    function renderList() {
        const data = MD.agedData;
        resultBox.innerHTML = "";
        if (!data || !data.items || data.items.length === 0) {
            resultBox.appendChild(el("div", { class: "md-empty",
                text: `${MD.agedDays} 天内没有"沉睡"的模型，或者扫描结果为空 🎉` }));
            return;
        }

        const RECENT = data.recent_use_days || 7;
        const catOptions = [...new Set(data.items.map(i => i.folder_type))].sort();

        const catSel = el("select", { class: "md-input", title: "按模型类别批量选择" },
            catOptions.map(t => el("option", { value: t, text: t })));
        const sizeSel = el("select", { class: "md-input", title: "按大小批量选择" }, [
            el("option", { value: "0", text: "不限大小" }),
            el("option", { value: "100", text: "> 100 MB" }),
            el("option", { value: "1024", text: "> 1 GB" }),
            el("option", { value: "5120", text: "> 5 GB" }),
        ]);

        function applySelect({ cat = "", minMB = 0, skipRecent = false, invert = false } = {}) {
            const minBytes = minMB * 1024 * 1024;
            resultBox.querySelectorAll("input.md-check").forEach(c => {
                const it = data.items.find(i => i.path === c.dataset.path);
                if (!it) return;
                let on = (!cat || it.folder_type === cat) && it.size >= minBytes;
                if (skipRecent && it.recently_used) on = false;
                c.checked = invert ? (!on && !c.checked ? false : !c.checked) : on;
            });
        }

        resultBox.appendChild(el("div", { class: "md-row" }, [
            el("span", { class: "md-pill bad", text: `${data.count} 个老旧模型` }),
            el("span", { class: "md-pill info", text: `共占用 ${fmtBytes(data.total_size)}` }),
            data.recently_used_count > 0
                ? el("span", { class: "md-pill bad", text: `⚠️ ${data.recently_used_count} 个近期仍在调用` })
                : el("span", { class: "md-pill ok", text: "近期无调用记录" }),
        ]));

        resultBox.appendChild(el("div", { class: "md-row" }, [
            el("button", { class: "md-btn ghost", text: "全选/反选", onclick: () => {
                const boxes = [...resultBox.querySelectorAll("input.md-check")];
                const allChecked = boxes.every(b => b.checked);
                boxes.forEach(b => (b.checked = !allChecked));
            } }),
            el("button", { class: "md-btn", text: "✅ 全选（自动跳过 ⚠️ 在用）", title:
                `一键选中全部老旧模型，自动排除近 ${RECENT} 天内有调用记录的文件，防止误删`, onclick: () => applySelect({ skipRecent: true }) }),
            el("span", { text: "📂 类别", style: "font-size:12px;color:#aaa" }),
            catSel,
            el("button", { class: "md-btn ghost", text: "仅选该类", onclick: () => applySelect({ cat: catSel.value }) }),
            el("span", { text: "📦 大小", style: "font-size:12px;color:#aaa" }),
            sizeSel,
            el("button", { class: "md-btn ghost", text: "应用筛选", onclick: () => applySelect({ minMB: parseFloat(sizeSel.value || "0") }) }),
            el("button", { class: "md-btn ghost", text: "清空选择", onclick: () => {
                resultBox.querySelectorAll("input.md-check").forEach(c => (c.checked = false));
            } }),
        ]));

        resultBox.appendChild(el("div", { class: "md-row" }, [
            el("button", { class: "md-btn danger", text: "🗑 删除选中（移入回收站）", onclick: async () => {
                const paths = selectedPaths();
                if (!paths.length) { mdAlert("请先勾选要删除的模型文件"); return; }
                // 防误删：优先警告近期有真实调用记录的文件
                const recent = data.items.filter(i => paths.includes(i.path) &&
                    i.last_used && (Date.now() / 1000 - i.last_used) < RECENT * 86400);
                if (recent.length) {
                    const preview = recent.slice(0, 8).map(i => "· " + i.rel_path).join("\n");
                    if (!(await mdConfirm(`⚠️ 防误删提醒\n\n选中的文件里有 ${recent.length} 个在近 ${RECENT} 天内被调用过：\n${preview}${recent.length > 8 ? "\n..." : ""}\n\n这些模型可能仍在使用中，确定仍要删除吗？`))) return;
                }
                if (!(await mdConfirm(`确认删除选中的 ${paths.length} 个文件吗？\n将移入回收站（已安装 send2trash），释放约 ${fmtBytes(
                    MD.agedData.items.filter(i => paths.includes(i.path)).reduce((s, i) => s + i.size, 0)
                )}`))) return;
                try {
                    const r = await mdFetch("/md/cleanup", { method: "POST",
                        body: { category: "models", paths, confirm: true } });
                    let msg = `已删除 ${r.deleted_count} 个文件，释放 ${fmtBytes(r.freed)}`;
                    if (!r.trash_used) msg += "（直接删除，未使用回收站）";
                    if (r.errors && r.errors.length) msg += `\n失败 ${r.errors.length} 个：\n` + r.errors.map(e => e.path + ": " + e.error).join("\n");
                    mdAlert(msg);
                    scan();
                } catch (e) { mdAlert("删除失败：" + e.message); }
            } }),
        ]));

        const tbody = el("tbody");
        for (const it of data.items) {
            const nameTd = el("td", { class: "wrap", text: it.rel_path, title: it.rel_path });
            const recentBadge = it.recently_used
                ? el("span", { class: "md-recent-badge", text: `⚠️ ${RECENT} 天内在用` }) : null;
            const usedTd = el("td", { style: "color:" + (it.last_used_src === "record" ? "#ddd" : "#888") },
                el("span", { text: recentUseLabel(it) }), recentBadge);
            tbody.appendChild(el("tr", { class: it.recently_used ? "md-recent" : "" }, [
                el("td", { style: "width:30px" }, el("input", { class: "md-check", type: "checkbox", "data-path": it.path })),
                nameTd,
                el("td", { text: it.folder_type, title: it.folder_type }),
                el("td", { text: fmtBytes(it.size) }),
                el("td", { text: `${it.age_days} 天`, style: "color:#888" }),
                usedTd,
                el("td", { text: fmtDate(it.mtime), style: "color:#888" }),
                el("td", { class: "path", text: it.path, title: "点击复制完整路径", onclick: () => {
                    navigator.clipboard.writeText(it.path).then(() => {
                        nameTd.style.color = "#7fdc9a";
                        setTimeout(() => (nameTd.style.color = ""), 800);
                    });
                } }),
            ]));
        }
        resultBox.appendChild(el("div", { class: "md-table-wrap" },
            el("table", { class: "md-table" }, [
                el("colgroup", {}, [
                    el("col", { style: "width:34px" }),
                    el("col", { style: "width:24%" }),
                    el("col", { style: "width:108px" }),
                    el("col", { style: "width:72px" }),
                    el("col", { style: "width:76px" }),
                    el("col", { style: "width:170px" }),
                    el("col", { style: "width:118px" }),
                ]),
                el("thead", {}, el("tr", {}, [
                    el("th"),
                    el("th", { text: "文件" }), el("th", { text: "类别" }),
                    el("th", { text: "大小" }), el("th", { text: "未修改" }),
                    el("th", { text: "最近调用（防止误删）" }),
                    el("th", { text: "最后修改" }), el("th", { text: "完整路径（点击复制）" }),
                ])),
                tbody,
            ])));
        resultBox.appendChild(el("div", { class: "md-meta", style: "color:#777;font-size:11px;margin-top:8px",
            text: "「未修改」= 文件最后修改距今的天数；「最近调用」= 插件记录的真实加载时间（自安装起记录）+ 文件访问时间兜底（≈ 号开头，仅供参考）。近期有调用的行会标红并带 ⚠️，删除前会二次提醒。" }));
    }

    body.appendChild(el("div", { class: "md-row" }, [
        el("span", { text: "超过", style: "font-size:12px;color:#aaa" }),
        daysInput,
        el("span", { text: "天未修改的模型：", style: "font-size:12px;color:#aaa" }),
        sortSel,
        scanBtn,
    ]));
    body.appendChild(resultBox);
}

// ---------------------------------------------------------------- Tab5: 环境

function renderEnvTab(body) {
    const envBox = el("div");
    const reqBox = el("div");
    const heavyBox = el("div");
    const pipBox = el("div");

    // ---------- pip 状态轮询 ----------
    let pipTimer = null;
    function watchPip(onDone) {
        if (pipTimer) clearInterval(pipTimer);
        pipTimer = setInterval(async () => {
            let s;
            try { s = await mdFetch("/md/pip_status"); } catch (e) { return; }
            pipBox.innerHTML = "";
            if (s.running) {
                pipBox.appendChild(el("div", { class: "md-empty" }, [
                    el("span", { class: "md-spin" }),
                    el("span", { text: "pip 执行中: " + s.cmd }),
                ]));
                if (s.output_tail && s.output_tail.length) {
                    pipBox.appendChild(el("div", { class: "md-card", style: "font-family:monospace;font-size:11px;color:#9cdc9c;max-height:140px;overflow-y:auto" },
                        el("div", { text: s.output_tail.slice(-12).join("\n") })));
                }
            } else if (s.done) {
                clearInterval(pipTimer);
                pipBox.innerHTML = "";
                pipBox.appendChild(el("div", { class: s.error ? "md-error" : "md-card", style: s.error ? "" : "border-color:#2f5c3a" }, [
                    el("div", { class: "md-title", style: s.error ? "color:#ff9c9c" : "color:#7fdc9a",
                        text: s.error ? "❌ pip 失败: " + s.error : "✅ pip 执行成功" }),
                    el("div", { style: "font-family:monospace;font-size:11px;color:#aaa;max-height:140px;overflow-y:auto;white-space:pre-wrap",
                        text: (s.output_tail || []).slice(-14).join("\n") }),
                ]));
                if (onDone) onDone();
            }
        }, 1200);
    }

    // ---------- 环境总览 ----------
    function loadEnv() {
        envBox.innerHTML = "";
        envBox.appendChild(el("div", { class: "md-empty" }, [el("span", { class: "md-spin" }), "读取环境信息..."]));
        mdFetch("/md/env_summary").then(d => {
            envBox.innerHTML = "";
            const row = (k, v, extra) => el("div", { style: "display:flex;gap:8px;font-size:12px;margin-bottom:5px" }, [
                el("span", { style: "color:#888;min-width:96px", text: k }),
                el("span", { style: "color:#ddd;word-break:break-all", text: String(v) }),
                extra || null,
            ]);
            envBox.appendChild(el("div", { class: "md-card" }, [
                el("div", { class: "md-title", text: "🖥 运行环境" }),
                row("Python", d.python),
                row("ComfyUI", d.comfyui),
                row("PyTorch", d.torch),
                d.cuda_available ? row("CUDA", d.cuda) : null,
                d.gpu ? row("GPU", d.gpu, d.vram_total_gb ? el("span", { class: "md-pill info", text: d.vram_total_gb + " GB" }) : null) : null,
                d.mem_total_gb ? row("内存", `${d.mem_avail_gb} GB 可用 / ${d.mem_total_gb} GB（负载 ${d.mem_load}%）`) : null,
                row("已装包数量", d.package_count || "-"),
                el("div", { style: "font-size:12px;margin-top:6px" }, [
                    el("span", { style: "color:#888", text: "Python 路径: " }),
                    el("span", { style: "color:#8ab4ff;font-family:monospace;font-size:11px", text: d.python_path }),
                ]),
            ]));
            const diskCard = el("div", { class: "md-card" }, [el("div", { class: "md-title", text: "💾 磁盘空间（模型所在盘）" })]);
            for (const [drive, info] of Object.entries(d.disks || {})) {
                const pct = Math.round((1 - info.free_gb / info.total_gb) * 100);
                diskCard.appendChild(el("div", { style: "display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px" }, [
                    el("span", { style: "min-width:70px;font-weight:600", text: drive }),
                    el("div", { class: "md-progress", style: "flex:1" }, [
                        el("div", { style: `width:${pct}%;background:${pct > 90 ? "#8f3a3a" : "#4a6fa5"}` }),
                        el("span", { class: "md-progress-text", text: `${info.free_gb} GB 可用 / ${info.total_gb} GB` }),
                    ]),
                ]));
            }
            envBox.appendChild(diskCard);
        }).catch(e => {
            envBox.innerHTML = "";
            envBox.appendChild(el("div", { class: "md-error", text: "环境读取失败：" + e.message }));
        });
    }

    // ---------- 依赖体检 ----------
    function loadReq(force) {
        reqBox.innerHTML = "";
        reqBox.appendChild(el("div", { class: "md-empty" }, [el("span", { class: "md-spin" }), "扫描插件 requirements.txt..."]));
        mdFetch("/md/env_requirements" + (force ? "?force=1" : "")).then(d => {
            reqBox.innerHTML = "";
            reqBox.appendChild(el("div", { class: "md-row" }, [
                el("span", { class: "md-pill info", text: `扫描了 ${d.plugin_count} 个插件的依赖声明` }),
                d.missing_count > 0
                    ? el("span", { class: "md-pill bad", text: `缺失 ${d.missing_count}` })
                    : el("span", { class: "md-pill ok", text: "依赖齐全 ✓" }),
                d.warn_count > 0 ? el("span", { class: "md-pill info", text: `版本差异 ${d.warn_count}` }) : null,
            ]));
            if (!d.items || !d.items.length) {
                reqBox.appendChild(el("div", { class: "md-empty", text: "插件目录里没有带 requirements.txt 的插件" }));
                return;
            }
            // 只展示缺失 + 版本不符的（齐全的折叠统计）
            const bad = d.items.filter(i => i.missing || i.version_ok === false || i.kind === "url");
            if (bad.length) {
                // 一键安装：仅普通 PyPI 包（URL/git 依赖需逐个装，避免一个失败拖垮全部）
                const missingPkgs = [...new Set(bad.filter(i => i.missing && i.kind === "pypi").map(i => i.name))];
                if (missingPkgs.length) {
                    reqBox.appendChild(el("div", { class: "md-row" }, [
                        el("button", { class: "md-btn", text: `⬇ 一键安装缺失依赖（${missingPkgs.length} 个包）`, onclick: async () => {
                            if (!(await mdConfirm(`确认用 pip 安装以下依赖吗？\n\n${missingPkgs.join("、")}\n\n将安装到 ComfyUI 的 Python 环境。`))) return;
                            try {
                                await mdFetch("/md/pip_install", { method: "POST", body: { packages: missingPkgs } });
                                watchPip(() => loadReq(true));
                            } catch (e) { mdAlert("安装失败：" + e.message); }
                        } }),
                        el("span", { class: "md-sub", style: "color:#888;font-size:12px", text: "git/直链类依赖在下方单独安装" }),
                    ]));
                }
                const tbody = el("tbody");
                for (const i of bad.slice(0, 120)) {
                    if (i.kind === "url") {
                        // git+https / 直链依赖：逐个安装
                        tbody.appendChild(el("tr", {}, [
                            el("td", { text: i.plugin }),
                            el("td", { class: "wrap", text: i.requirement, title: i.requirement }),
                            el("td", {}, el("div", { style: "display:flex;gap:6px;align-items:center" }, [
                                el("button", { class: "md-btn", text: "⬇ 单独安装", title: "URL/git 依赖单独执行 pip，失败不影响其他包", onclick: async () => {
                                    if (!(await mdConfirm(`单独安装 ${i.requirement} 吗？\n（git 依赖需要本机 git 可用，安装耗时视仓库而定）`))) return;
                                    try {
                                        await mdFetch("/md/pip_install", { method: "POST", body: { packages: [i.requirement] } });
                                        watchPip(() => loadReq(true));
                                    } catch (e) { mdAlert("安装失败：" + e.message); }
                                } }),
                            ])),
                        ]));
                        continue;
                    }
                    const statusPill = i.missing
                        ? el("span", { class: "md-pill bad", text: "❌ 未安装" })
                        : el("span", { class: "md-pill info", text: "⚠️ 版本 " + i.installed });
                    tbody.appendChild(el("tr", {}, [
                        el("td", { text: i.plugin }),
                        el("td", { class: "wrap", text: i.requirement }),
                        el("td", {}, el("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" }, [
                            statusPill,
                            i.hint ? el("span", { class: "md-pill info", title: i.hint, style: "cursor:help", text: "💡 有提示" }) : null,
                        ])),
                    ]));
                    if (i.hint) {
                        tbody.appendChild(el("tr", {}, [
                            el("td"),
                            el("td", { colspan: "2", style: "color:#ffb060;font-size:11px", text: "💡 " + i.hint }),
                        ]));
                    }
                }
                reqBox.appendChild(el("div", { class: "md-table-wrap" }, el("table", { class: "md-table" }, [
                    el("colgroup", {}, [el("col", { style: "width:28%" }), el("col", { style: "width:40%" }), el("col", { style: "width:auto" })]),
                    el("thead", {}, el("tr", {}, [el("th", { text: "插件" }), el("th", { text: "声明的依赖" }), el("th", { text: "状态 / 操作" })])),
                    tbody,
                ])));
            } else {
                reqBox.appendChild(el("div", { class: "md-empty", text: "所有插件依赖均已安装 🎉" }));
            }
        }).catch(e => {
            reqBox.innerHTML = "";
            reqBox.appendChild(el("div", { class: "md-error", text: "扫描失败：" + e.message }));
        });
    }

    // ---------- 重量级包 ----------
    function renderHeavy(notice) {
        const items = MD.heavyItems || [];
        heavyBox.innerHTML = "";
        if (notice) heavyBox.appendChild(notice);
        heavyBox.appendChild(el("div", { class: "md-row" }, [
            el("span", { class: "md-pill info", text: `展示占用 Top ${items.length}` }),
            el("button", { class: "md-btn ghost", text: "🔄 重新统计（精确大小）", title: "全量扫描 site-packages，需几秒到几十秒",
                onclick: () => loadHeavy(true) }),
            el("button", { class: "md-btn ghost", text: "全选/反选（可卸载项）", onclick: () => {
                const boxes = [...heavyBox.querySelectorAll("input.md-check")];
                const all = boxes.length && boxes.every(b => b.checked);
                boxes.forEach(b => (b.checked = !all));
            } }),
            el("button", { class: "md-btn danger", text: "🗑 卸载选中", onclick: async () => {
                const names = [...heavyBox.querySelectorAll("input.md-check:checked")].map(c => c.dataset.name);
                if (!names.length) { mdAlert("请先勾选要卸载的包"); return; }
                const total = names.reduce((s, n) => s + ((MD.heavyItems || []).find(p => p.name === n) || {}).size, 0);
                if (!(await mdConfirm(`确认卸选中的 ${names.length} 个包吗？\n\n${names.join("、")}\n\n一次性 pip uninstall，完成后列表即时更新。`))) return;
                try {
                    await mdFetch("/md/pip_uninstall", { method: "POST", body: { packages: names } });
                    watchPip(() => {
                        // 本地即时移除，不触发全量重扫
                        MD.heavyItems = (MD.heavyItems || []).filter(p => !names.includes(p.name));
                        renderHeavy(el("div", { class: "md-card", style: "border-color:#2f5c3a" }, [
                            el("div", { class: "md-title", style: "color:#7fdc9a", text: `✅ 已卸载 ${names.length} 个包（约 ${fmtBytes(total)}）` }),
                            el("div", { class: "md-meta", text: "列表已按卸载结果即时更新；如需精确的剩余占用统计，请点「🔄 重新统计」" }),
                        ]));
                    });
                } catch (e) { mdAlert("卸载失败：" + e.message); }
            } }),
        ]));
        if (!items.length) {
            heavyBox.appendChild(el("div", { class: "md-empty", text: "点击「重新统计」开始扫描" }));
            return;
        }
        const tbody = el("tbody");
        for (const p of items) {
            const unBtn = p.core
                ? el("span", { class: "md-pill ok", style: "opacity:.75", title: "ComfyUI 核心依赖，卸载会导致无法启动", text: "核心·禁卸" })
                : el("button", { class: "md-btn danger", text: "卸载", onclick: async () => {
                    if (!(await mdConfirm(`确认卸载 ${p.name} ${p.version}（${p.size_str}）吗？\n\n卸载后如插件报 ImportError，重新 pip install 即可恢复。`))) return;
                    try {
                        await mdFetch("/md/pip_uninstall", { method: "POST", body: { packages: [p.name] } });
                        watchPip(() => {
                            MD.heavyItems = (MD.heavyItems || []).filter(x => x.name !== p.name);
                            renderHeavy(el("div", { class: "md-card", style: "border-color:#2f5c3a" }, [
                                el("div", { class: "md-title", style: "color:#7fdc9a", text: `✅ 已卸载 ${p.name}（${p.size_str}）` }),
                                el("div", { class: "md-meta", text: "列表已即时更新；如需精确统计请点「🔄 重新统计」" }),
                            ]));
                        });
                    } catch (e) { mdAlert("卸载失败：" + e.message); }
                } });
            tbody.appendChild(el("tr", {}, [
                el("td", { style: "width:30px" }, p.core ? null :
                    el("input", { class: "md-check", type: "checkbox", "data-name": p.name })),
                el("td", { text: p.name, style: "font-weight:600" }),
                el("td", { text: p.version, style: "color:#888" }),
                el("td", { text: p.size_str, style: "white-space:nowrap" }),
                el("td", {}, unBtn),
            ]));
        }
        heavyBox.appendChild(el("div", { class: "md-table-wrap" }, el("table", { class: "md-table" }, [
            el("colgroup", {}, [el("col", { style: "width:34px" }), el("col", { style: "width:32%" }), el("col", { style: "width:20%" }), el("col", { style: "width:18%" }), el("col", { style: "width:auto" })]),
            el("thead", {}, el("tr", {}, [el("th"), el("th", { text: "包名" }), el("th", { text: "版本" }), el("th", { text: "占用" }), el("th", { text: "操作" })])),
            tbody,
        ])));
        heavyBox.appendChild(el("div", { class: "md-meta", style: "color:#777;font-size:11px",
            text: "「核心·禁卸」= ComfyUI 或其 requirements 声明的依赖，卸载会导致启动失败；其余包卸载前请确认没有插件正在使用。卸载结果会即时更新列表，无需等待重新扫描。" }));
    }

    function loadHeavy(force) {
        heavyBox.innerHTML = "";
        heavyBox.appendChild(el("div", { class: "md-empty" }, [el("span", { class: "md-spin" }), "统计 site-packages 占用（首次需几秒到几十秒）..."]));
        mdFetch("/md/env_heavy?top=25" + (force ? "&force=1" : "")).then(d => {
            MD.heavyItems = d.items || [];
            renderHeavy(el("div", { class: "md-row" }, [
                el("span", { class: "md-pill info", text: `共 ${d.total_packages} 个包` }),
                el("span", { class: "md-meta", style: "color:#777;font-size:11px", text: `统计耗时 ${d.scan_seconds}s` }),
            ]));
        }).catch(e => {
            heavyBox.innerHTML = "";
            heavyBox.appendChild(el("div", { class: "md-error", text: "统计失败：" + e.message }));
        });
    }

    body.appendChild(envBox);
    loadEnv();

    body.appendChild(el("div", { class: "md-card" }, [
        el("div", { class: "md-row", style: "margin-bottom:6px" }, [
            el("div", { class: "md-title", text: "🧩 插件依赖体检" }),
            el("button", { class: "md-btn ghost", text: "扫描", onclick: () => loadReq(true) }),
        ]),
        el("div", { class: "md-meta", text: "检查每个插件的 requirements.txt 声明是否已安装——装完插件不工作多半是缺依赖" }),
    ]));
    body.appendChild(reqBox);

    body.appendChild(el("div", { class: "md-card" }, [
        el("div", { class: "md-row", style: "margin-bottom:6px" }, [
            el("div", { class: "md-title", text: "🐘 重量级包管理" }),
            el("button", { class: "md-btn ghost", text: "统计占用", onclick: () => loadHeavy(true) }),
        ]),
        el("div", { class: "md-meta", text: "按磁盘占用排序，找出像 wandb / tensorboard 这类装了没用的大包，核心依赖自动禁卸" }),
    ]));
    body.appendChild(heavyBox);
    body.appendChild(pipBox);

    // ---------- 关于 / 检查更新 ----------
    const aboutBox = el("div");
    body.appendChild(el("div", { class: "md-card" }, [
        el("div", { class: "md-row", style: "margin-bottom:6px" }, [
            el("div", { class: "md-title", text: "ℹ️ 关于 / 检查更新" }),
            el("button", { class: "md-btn ghost", text: "🔄 检查更新", onclick: () => checkUpdate(aboutBox) }),
        ]),
    ]));
    body.appendChild(aboutBox);
    loadAbout(aboutBox);
}

let MD_VER_CACHE = null;

async function loadAbout(box) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "md-empty" }, [el("span", { class: "md-spin" }), "读取版本信息..."]));
    try {
        if (!MD_VER_CACHE) MD_VER_CACHE = await mdFetch("/md/version");
        const d = MD_VER_CACHE;
        box.innerHTML = "";
        const verCard = el("div", { class: "md-card" }, [
            el("div", { class: "md-row" }, [
                el("span", { class: "md-pill info", text: "MissingDoctor v" + d.version }),
                d.comfyui ? el("span", { class: "md-pill info", text: "ComfyUI " + d.comfyui }) : null,
            ]),
            el("div", { style: "font-size:12px;margin-top:4px" }, [
                el("span", { style: "color:#888", text: "插件位置: " }),
                el("span", { style: "color:#8ab4ff;font-family:monospace;font-size:11px;word-break:break-all", text: d.plugin_path }),
            ]),
            el("div", { class: "md-row", style: "margin-top:6px" }, [
                el("a", { class: "md-link", href: d.repo_url, target: "_blank", text: "GitHub 仓库（求 Star ⭐）" }),
            ]),
            el("div", { id: "md-update-result" }),
        ]);
        // 前端脚本版本自检：浏览器可能缓存旧 JS，导致新功能不生效/点击无反应
        if (MD_JS_VER && d.version && MD_JS_VER !== d.version) {
            verCard.prepend(el("div", { class: "md-error", style: "margin-bottom:6px",
                text: "⚠️ 前端脚本版本 v" + MD_JS_VER + " ≠ 后端 v" + d.version + "，浏览器可能缓存了旧版 JS。"
                    + "请按 Ctrl+F5 强制刷新 ComfyUI 页面后重新打开面板。" }));
        }
        box.appendChild(verCard);
    } catch (e) {
        box.innerHTML = "";
        box.appendChild(el("div", { class: "md-error", text: "版本读取失败：" + e.message }));
    }
}

function versionGt(remote, local) {
    // 语义化版本比较：remote > local 返回 true（兼容 v 前缀与位数不同的段）
    const p = (s) => String(s || "").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
    const a = p(remote), b = p(local);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0, y = b[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

async function runSelfUpdate(out) {
    // 一键更新：启动 -> 轮询进度 -> 完成提示重启
    // 点击后立即给出反馈（避免"点了没反应"的观感），任何异常都显示明确信息
    out.innerHTML = "";
    out.appendChild(el("div", { class: "md-empty" }, [el("span", { class: "md-spin" }), "正在启动更新..."]));
    let started = false;
    try {
        await mdFetch("/md/self_update", { method: "POST" });
        started = true;
    } catch (e) {
        out.innerHTML = "";
        out.appendChild(el("div", { class: "md-card", style: "border-color:#7a3030" }, [
            el("div", { class: "md-title", style: "color:#e06c6c", text: "❌ 更新启动失败：" + (e.message || e) }),
            el("div", { class: "md-meta", style: "color:#ffb060",
                text: "常见原因：插件为手动解压安装（非 git 仓库）、未安装 Git、或后端接口未注册（请先 Ctrl+F5 刷新页面）。" }),
            el("div", { class: "md-meta", style: "color:#888",
                text: "也可手动更新：在 custom_nodes/ComfyUI-MissingDoctor 目录执行 git pull 后重启 ComfyUI。" }),
        ]));
        return;
    }
    if (!started) return;
    let failCount = 0;
    const poll = setInterval(async () => {
        let s;
        try { s = await mdFetch("/md/self_update_status"); } catch (e) {
            if (++failCount >= 3) {
                clearInterval(poll);
                out.innerHTML = "";
                out.appendChild(el("div", { class: "md-card", style: "border-color:#7a3030" }, [
                    el("div", { class: "md-title", style: "color:#e06c6c", text: "❌ 无法读取更新进度：" + e.message }),
                    el("div", { class: "md-meta", style: "color:#888",
                        text: "可手动在 custom_nodes/ComfyUI-MissingDoctor 执行 git pull 后重启。" }),
                ]));
            }
            return;
        }
        failCount = 0;
        if (s.status === "pulling") {
            out.innerHTML = "";
            const tail = (s.log || "").split("\n").filter(Boolean).slice(-1)[0] || "";
            out.appendChild(el("div", { class: "md-empty" }, [
                el("span", { class: "md-spin" }),
                "正在更新插件..." + (tail ? tail.slice(0, 60) : ""),
            ]));
            return;
        }
        clearInterval(poll);
        out.innerHTML = "";
        if (s.status === "done") {
            out.appendChild(el("div", { class: "md-card", style: "border-color:#2f5c3a" }, [
                el("div", { class: "md-title", style: "color:#7fdc9a",
                    text: "✅ 更新完成（当前代码版本 v" + (s.new_version || "?") + "）" }),
                el("div", { class: "md-meta", style: "color:#ffb060",
                    text: "⚠️ 请重启 ComfyUI 使新版本生效" }),
                el("details", { style: "margin-top:4px" }, [
                    el("summary", { style: "cursor:pointer;font-size:11px;color:#888", text: "查看 git 输出" }),
                    el("div", { style: "font-family:monospace;font-size:11px;color:#aaa;white-space:pre-wrap;word-break:break-all", text: s.log || "" }),
                ]),
            ]));
        } else {
            out.appendChild(el("div", { class: "md-card", style: "border-color:#7a3030" }, [
                el("div", { class: "md-title", style: "color:#e06c6c", text: "❌ 更新失败：" + (s.error || "未知错误") }),
                el("details", { style: "margin-top:4px" }, [
                    el("summary", { style: "cursor:pointer;font-size:11px;color:#888", text: "查看 git 输出" }),
                    el("div", { style: "font-family:monospace;font-size:11px;color:#aaa;white-space:pre-wrap;word-break:break-all", text: s.log || "" }),
                ]),
            ]));
        }
    }, 1200);
}

async function checkUpdate(box) {
    const out = box.querySelector("#md-update-result");
    if (!out) return;
    out.innerHTML = "";
    out.appendChild(el("div", { class: "md-empty" }, [el("span", { class: "md-spin" }), "正在连接 GitHub..."]));
    let local = MD_VER_CACHE ? MD_VER_CACHE.version : "?";
    // GitHub API 加 10s 超时：网络不通时快速报错而不是一直转圈（浏览器 fetch 默认无超时）
    const ac = new AbortController();
    const gTimer = setTimeout(() => ac.abort(), 10000);
    try {
        // 并行请求最新提交与最新 Release
        const [rCommits, rRel] = await Promise.all([
            fetch("https://api.github.com/repos/leeymxz/ComfyUI-MissingDoctor/commits?per_page=1",
                  { signal: ac.signal }),
            fetch("https://api.github.com/repos/leeymxz/ComfyUI-MissingDoctor/releases/latest",
                  { signal: ac.signal }).catch(() => null),
        ]);
        clearTimeout(gTimer);
        if (!rCommits.ok) throw new Error("HTTP " + rCommits.status);
        const j = await rCommits.json();
        const sha = j[0].sha.slice(0, 7);
        const date = (j[0].commit.committer.date || "").replace("T", " ").slice(0, 16);
        const msg = (j[0].commit.message || "").split("\n")[0].slice(0, 80);
        let relTag = "";
        if (rRel && rRel.ok) {
            const rj = await rRel.json();
            relTag = (rj.tag_name || "").replace(/^v/i, "");
        }
        const hasNew = relTag && versionGt(relTag, local);
        const row = el("div", { class: "md-row" }, [
            el("span", { class: "md-pill info", text: "本地版本 v" + local }),
            relTag ? el("span", { class: "md-pill " + (hasNew ? "bad" : "ok"),
                text: "远端 Release v" + relTag + (hasNew ? "（有更新）" : "（已是最新）") }) : null,
            el("span", { class: "md-pill info", text: "远端提交 " + sha + "（" + date + "）" }),
        ]);
        const card = el("div", { class: "md-card" }, [row, el("div", { class: "md-meta", text: msg })]);
        if (hasNew) {
            // 一键更新能力检测：非 git 仓库 / 未装 git 时给出明确提示（而不是点击后无反应）
            let capTip = null;
            try {
                const cap = await mdFetch("/md/self_update_capable");
                if (cap && !cap.is_git_repo) {
                    capTip = el("div", { class: "md-error", style: "margin-top:4px",
                        text: "⚠️ 当前插件为手动解压安装（非 git 仓库），不支持一键更新。"
                            + "请删除 custom_nodes/ComfyUI-MissingDoctor 后重新 git clone 安装。" });
                } else if (cap && !cap.git_installed) {
                    capTip = el("div", { class: "md-error", style: "margin-top:4px",
                        text: "⚠️ 系统未找到 git 命令，请先安装 Git（git-scm.com）后重试。" });
                }
            } catch (e) { /* 后端无此接口时忽略，点击时也会给出错误提示 */ }
            card.appendChild(el("div", { class: "md-row", style: "margin-top:6px" }, [
                el("button", { class: "md-btn", text: "⚡ 一键更新到 v" + relTag,
                    title: "在插件目录执行 git pull（不覆盖本地修改），完成后需重启 ComfyUI",
                    onclick: () => runSelfUpdate(out) }),
                el("span", { class: "md-sub", style: "color:#888;font-size:12px", text: "自动 git pull，完成后提示重启" }),
            ]));
            if (capTip) card.appendChild(capTip);
        } else if (relTag) {
            card.appendChild(el("div", { class: "md-meta", style: "color:#7fdc9a", text: "✓ 已是最新版本" }));
        } else {
            card.appendChild(el("div", { class: "md-meta", style: "color:#ffb060",
                text: "如远端有更新：在 custom_nodes/ComfyUI-MissingDoctor 目录执行 git pull，然后重启 ComfyUI" }));
        }
        out.innerHTML = "";
        out.appendChild(card);
    } catch (e) {
        clearTimeout(gTimer);
        out.innerHTML = "";
        const msg = (e && e.name === "AbortError")
            ? "连接 GitHub 超时（10s），请检查网络/代理后重试"
            : "无法连接 GitHub（" + (e && e.message ? e.message : e) + "）";
        out.appendChild(el("div", { class: "md-error",
            text: msg + "。也可手动到仓库主页查看更新：github.com/leeymxz/ComfyUI-MissingDoctor" }));
    }
}

// ---------------------------------------------------------------- Tab: 查重

function renderDedupeTab(body) {
    const resultBox = el("div");
    const scanBtn = el("button", { class: "md-btn", text: "🔍 扫描重复模型", onclick: () => scan() });

    async function scan() {
        resultBox.innerHTML = "";
        resultBox.appendChild(el("div", { class: "md-empty" },
            [el("span", { class: "md-spin" }), "正在比对模型文件指纹（头/中/尾采样，首次约 1-2 分钟）..."]));
        scanBtn.disabled = true;
        try {
            const d = await mdFetch("/md/duplicates");
            render(d);
        } catch (e) {
            resultBox.innerHTML = "";
            resultBox.appendChild(el("div", { class: "md-error", text: "扫描失败：" + e.message }));
        } finally {
            scanBtn.disabled = false;
        }
    }

    function checkedPaths(g) {
        const keep = g.keep;
        const checked = new Set();
        g.files.forEach(f => {
            const cb = resultBox.querySelector('input[data-path="' + CSS.escape(f.path) + '"]');
            if (cb && cb.checked && f.path !== keep) checked.add(f.path);
        });
        return checked;
    }

    function render(d) {
        resultBox.innerHTML = "";
        if (!d.groups || !d.groups.length) {
            resultBox.appendChild(el("div", { class: "md-empty", text: "没有发现重复模型 🎉 模型库很干净" }));
            return;
        }
        resultBox.appendChild(el("div", { class: "md-row" }, [
            el("span", { class: "md-pill bad", text: `${d.group_count} 组重复` }),
            el("span", { class: "md-pill info", text: `${d.duplicate_count} 个冗余文件 · 可释放 ${fmtBytes(d.waste_total)}` }),
            el("button", { class: "md-btn danger", text: "🗑 清理全部重复（保留每组主文件）", onclick: async () => {
                const paths = [];
                d.groups.forEach(g => g.files.forEach(f => { if (f.path !== g.keep) paths.push(f.path); }));
                if (!paths.length) return;
                if (!(await mdConfirm(`确认删除全部 ${paths.length} 个重复文件（约 ${fmtBytes(d.waste_total)}）吗？\n每组保留一个（优先最近调用的）。删除进入回收站，可恢复。`))) return;
                try {
                    const r = await mdFetch("/md/cleanup", { method: "POST",
                        body: { category: "models", paths, confirm: true } });
                    mdAlert(`已删除 ${r.deleted_count} 个，释放 ${fmtBytes(r.freed)}` +
                          (r.errors && r.errors.length ? "，失败 " + r.errors.length + " 个" : ""));
                    scan();
                } catch (e) { mdAlert("清理失败：" + e.message); }
            } }),
        ]));

        for (const g of d.groups) {
            const card = el("div", { class: "md-card" }, [
                el("div", { class: "md-row", style: "margin-bottom:4px" }, [
                    el("div", { class: "md-title", style: "margin:0",
                        text: `⚡ ${g.files.length} 个重复文件 · 各 ${fmtBytes(g.size)} · 可释放 ${fmtBytes(g.waste)}` }),
                ]),
                el("div", { class: "md-meta", text: "🟢 保留 = 主文件（推荐最近调用的）；其余为重复副本，可在勾选后删除或另外设为保留" }),
            ]);
            const lst = el("div");
            g.files.forEach(f => {
                const isKeep = f.path === g.keep;
                const row = el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap" }, [
                    isKeep
                        ? el("span", { class: "md-pill ok", text: "🟢 保留" })
                        : el("input", { class: "md-check", type: "checkbox", "data-path": f.path, checked: true }),
                    el("span", { style: "font-size:12px;color:#ddd;word-break:break-all", text: f.rel }),
                    el("span", { style: "font-size:11px;color:#888",
                        text: `(${f.folder_type} · 改于 ${fmtDate(f.mtime)}${f.last_used ? " · 📞 最近调用" : ""})` }),
                    isKeep ? null : el("button", { class: "md-btn ghost", text: "设为保留",
                        onclick: () => { g.keep = f.path; render(d); } }),
                ]);
                lst.appendChild(row);
            });
            card.appendChild(lst);
            card.appendChild(el("div", { class: "md-row", style: "margin-top:6px" }, [
                el("button", { class: "md-btn", text: "🗑 删除勾选的重复副本", onclick: async () => {
                    const paths = [...checkedPaths(g)];
                    if (!paths.length) { mdAlert("本组所有副本都已被勾掉（或没有可选副本）"); return; }
                    if (!(await mdConfirm(`删除本组 ${paths.length} 个重复文件（约 ${fmtBytes(paths.length * g.size)}）？删除进入回收站。`))) return;
                    try {
                        const r = await mdFetch("/md/cleanup", { method: "POST",
                            body: { category: "models", paths, confirm: true } });
                        mdAlert(`已删除 ${r.deleted_count} 个，释放 ${fmtBytes(r.freed)}`);
                        scan();
                    } catch (e) { mdAlert("清理失败：" + e.message); }
                } }),
            ]));
            resultBox.appendChild(card);
        }
    }

    body.appendChild(el("div", { class: "md-row" }, [
        scanBtn,
        el("span", { class: "md-sub", style: "color:#888;font-size:12px",
            text: "按文件大小分组 → 同大小组做头/中/尾采样指纹精确比对（非全量哈希，快且几乎不误判）" }),
    ]));
    body.appendChild(resultBox);
    resultBox.appendChild(el("div", { class: "md-empty", text: "点击「扫描重复模型」开始查重" }));
}

// ---------------------------------------------------------------- Tab: 目录映射

function renderMapperTab(body) {
    const box = el("div");
    const sourceSel = el("select", { class: "md-input", style: "min-width:340px" });
    const listBox = el("div");
    let installs = [];
    let sourcePaths = [];

    function fmtStatus(s) {
        if (s === "linked") return el("span", { class: "md-pill info", text: "✔ 已映射" });
        if (s === "real") return el("span", { class: "md-pill ok", text: "● 真实目录" });
        return el("span", { class: "md-pill bad", text: "— 不存在" });
    }

    function refreshSourceSel() {
        sourcePaths = installs.filter(i => i.status === "real").map(i => i.models);
        if (!sourcePaths.length) sourcePaths = [installs[0] && installs[0].models || ""].filter(Boolean);
        sourceSel.innerHTML = "";
        sourcePaths.forEach((p, i) => {
            sourceSel.appendChild(el("option", { value: p, text: "📦 " + p }));
        });
    }

    async function scan() {
        box.innerHTML = "";
        box.appendChild(el("div", { class: "md-empty" }, [el("span", { class: "md-spin" }), "扫描本机 ComfyUI 安装与 models 状态..."]));
        try {
            const d = await mdFetch("/md/mapper_scan");
            installs = d.installs || [];
            render();
        } catch (e) {
            box.innerHTML = "";
            box.appendChild(el("div", { class: "md-error", text: "扫描失败：" + e.message }));
        }
    }

    function checkedTargets() {
        return [...listBox.querySelectorAll("input.md-check:checked")].map(c => c.dataset.path);
    }

    function render() {
        box.innerHTML = "";
        refreshSourceSel();
        box.appendChild(el("div", { class: "md-card" }, [
            el("div", { class: "md-title", text: "🗺 models 目录映射（Junction 共享一份模型库，避免多整合包重复占用几百 GB）" }),
            el("div", { class: "md-meta", text: "安全：只创建/删除目录联接本身，绝不移动/删除模型文件；目标非空先备份（models_backup_*）；源为链接或自映射会拦截" }),
        ]));
        if (!installs.length) {
            box.appendChild(el("div", { class: "md-empty", text: "未扫描到安装（点击扫描按钮）" }));
            return;
        }
        // 源选择
        box.appendChild(el("div", { class: "md-row" }, [
            el("span", { text: "① 模型仓库目录（真实存放，作为映射源）：", style: "font-size:12px;color:#aaa" }),
            sourceSel,
        ]));
        // 目标列表
        box.appendChild(el("div", { class: "md-card" }, [
            el("div", { class: "md-title", text: "② 本机 ComfyUI 安装（勾选要映射的目标）" }),
        ]));
        listBox.innerHTML = "";
        for (const it of installs) {
            listBox.appendChild(el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px" }, [
                el("input", { class: "md-check", type: "checkbox", "data-path": it.path, checked: it.status === "linked" ? false : (it.status !== "missing") }),
                el("span", { style: "font-size:12px;color:#ddd;word-break:break-all", text: it.path }),
                fmtStatus(it.status),
                it.status === "linked" && it.target
                    ? el("span", { style: "font-size:11px;color:#8ab4ff", text: "→ 指向 " + it.target })
                    : null,
            ]));
        }
        box.appendChild(listBox);
        // 操作按钮
        box.appendChild(el("div", { class: "md-row" }, [
            el("button", { class: "md-btn", text: "▶ 开始映射", onclick: async () => {
                const src = sourceSel.value;
                const targets = checkedTargets();
                if (!src || !targets.length) { mdAlert("请先选源目录并勾选目标安装"); return; }
                const bakInfo = targets.map(t => "· " + t).join("\n");
                if (!(await mdConfirm(`确认将以下安装的 models 映射到\n${src}\n？\n\n${bakInfo}\n\n若目标 models 非空会自动改名备份（models_backup_*），模型文件不会被删除。完成后需重启对应 ComfyUI 生效。`))) return;
                try {
                    const r = await mdFetch("/md/mapper_apply", { method: "POST",
                        body: { source: src, targets } });
                    let msg = "";
                    (r.results || []).forEach(x => {
                        msg += "【" + x.target + "】\n" +
                            (x.ok ? "✓ " + (x.done || []).join("\n") : "✗ " + (x.errors || []).join("\n")) + "\n\n";
                    });
                    mdAlert(msg || "无结果");
                    scan();
                } catch (e) { mdAlert("失败：" + e.message); }
            } }),
            el("button", { class: "md-btn", text: "■ 解除映射", onclick: async () => {
                const targets = checkedTargets();
                if (!targets.length) { mdAlert("请勾选要解除的安装（勾选所有项再点也行）"); return; }
                if (!(await mdConfirm("解除映射只删除目录联接本身，目标模型文件不受影响。继续？"))) return;
                try {
                    const r = await mdFetch("/md/mapper_unmap", { method: "POST", body: { targets } });
                    mdAlert((r.results || []).map(x => "【" + x.target + "】" + (x.ok ? "✓ " + (x.done || []).join("") : "✗ " + (x.errors || []).join(""))).join("\n"));
                    scan();
                } catch (e) { mdAlert("失败：" + e.message); }
            } }),
            el("button", { class: "md-btn ghost", text: "↩ 还原备份", onclick: async () => {
                const targets = checkedTargets();
                if (!targets.length) { mdAlert("请先勾选要还原的安装"); return; }
                try {
                    const r = await mdFetch("/md/mapper_restore", { method: "POST", body: { targets } });
                    mdAlert((r.results || []).map(x => "【" + x.target + "】" + (x.ok ? "✓ " + (x.done || []).join("") : "✗ " + (x.errors || []).join(""))).join("\n"));
                    scan();
                } catch (e) { mdAlert("失败：" + e.message); }
            } }),
            el("button", { class: "md-btn ghost", text: "🔄 重新扫描", onclick: scan }),
        ]));
    }

    body.appendChild(el("div", { class: "md-row" }, [
        el("button", { class: "md-btn", text: "🔍 扫描本机 ComfyUI", onclick: scan }),
        el("span", { class: "md-sub", style: "color:#888;font-size:12px", text: "基于 comfy-models-mapper 思路：多整合包共享一份模型仓库，立省几百 GB" }),
    ]));
    body.appendChild(box);
    scan();
}

// ---------------------------------------------------------------- Tab4: 清理

function renderCleanupTab(body) {
    const resultBox = el("div");
    const catInfo = {
        temp:   { label: "临时文件 temp",   desc: "预览图缓存等运行时临时文件，可安全清理" },
        output: { label: "输出图片 output", desc: "ComfyUI 生成的输出结果，可设置保留最近几天的新图" },
        pycache:{ label: "Python 缓存 __pycache__", desc: "插件编译缓存，删除后首次启动会稍慢" },
        logs:   { label: "日志文件 *.log",  desc: "ComfyUI user 目录下的历史日志" },
    };

    const outputDaysSel = el("select", { class: "md-input", title: "只清理修改时间早于该天数的输出", onchange: () => {
        MD.outputDays = parseFloat(outputDaysSel.value || "0");
        load();
    } }, [
        el("option", { value: "0", text: "全部输出" }),
        el("option", { value: "1", text: "保留最近 1 天" }),
        el("option", { value: "7", text: "保留最近 7 天" }),
        el("option", { value: "30", text: "保留最近 30 天" }),
    ]);
    outputDaysSel.value = String(MD.outputDays || 0);

    async function load() {
        resultBox.innerHTML = "";
        resultBox.appendChild(el("div", { class: "md-empty" },
            [el("span", { class: "md-spin" }), "正在统计可清理项..."]));
        try {
            MD.cleanupPreview = await mdFetch("/md/cleanup_preview?output_days=" + (MD.outputDays || 0));
            render();
        } catch (e) {
            resultBox.innerHTML = "";
            resultBox.appendChild(el("div", { class: "md-error", text: "加载失败：" + e.message }));
        }
    }

    function render() {
        resultBox.innerHTML = "";
        const data = MD.cleanupPreview;
        if (!data) return;
        let any = false;
        for (const [cat, info] of Object.entries(catInfo)) {
            const d = data[cat] || { count: 0, size: 0 };
            if (d.count > 0) any = true;
            resultBox.appendChild(el("div", { class: "md-card" }, [
                el("div", { class: "md-row", style: "margin-bottom:4px" }, [
                    el("div", { class: "md-title", text: info.label }),
                    el("span", { class: d.count ? "md-pill info" : "md-pill ok",
                                 text: d.count ? `${d.count} 项 · ${fmtBytes(d.size)}` : "无待清理项 ✓" }),
                ]),
                el("div", { class: "md-meta", text: info.desc }),
                cat === "output" ? el("div", { class: "md-row", style: "margin:6px 0" }, [
                    el("span", { text: "清理范围：", style: "font-size:12px;color:#aaa" }),
                    outputDaysSel,
                ]) : null,
                d.count ? el("div", { class: "md-row", style: "margin:8px 0 0" },
                    el("button", { class: cat === "output" ? "md-btn danger" : "md-btn", text: "清理此类",
                        onclick: async () => {
                            const scope = cat === "output" && MD.outputDays > 0
                                ? `\n（仅清理 ${MD.outputDays} 天前的输出，最近的新图会保留）` : "";
                            const extra = cat === "output" && !MD.outputDays ? "\n⚠️ 这将删除 output 目录下的全部输出文件！" : "";
                            if (!(await mdConfirm(`确认清理「${info.label}」吗？共 ${d.count} 项，约 ${fmtBytes(d.size)}。${scope}${extra}`))) return;
                            try {
                                const r = await mdFetch("/md/cleanup", { method: "POST",
                                    body: { category: cat, confirm: true, keep_days: cat === "output" ? (MD.outputDays || 0) : 0 } });
                                mdAlert(`已清理 ${r.deleted_count} 项，释放 ${fmtBytes(r.freed)}` +
                                      (r.errors && r.errors.length ? `\n失败 ${r.errors.length} 项` : ""));
                                load();
                            } catch (e) { mdAlert("清理失败：" + e.message); }
                        } })) : null,
            ]));
        }
        if (!any) resultBox.appendChild(el("div", { class: "md-empty", text: "所有类别都是干净的，太棒了 🎉" }));
        resultBox.appendChild(el("div", { class: "md-meta", style: "color:#777;font-size:11px",
            text: "删除操作默认移入回收站（需要插件 requirements 中的 send2trash）；模型文件删除请使用「老旧模型」标签页。" }));
    }

    body.appendChild(el("div", { class: "md-row" }, [
        el("button", { class: "md-btn ghost", text: "🔄 刷新统计", onclick: load }),
        el("span", { class: "md-sub", style: "color:#888;font-size:12px",
            text: "temp / output / __pycache__ / 日志，先预览再清理，删除可进回收站" }),
    ]));
    body.appendChild(resultBox);
    load();
}

// ---------------------------------------------------------------- 菜单按钮

function mountMenuButton(btn) {
    // 优先尝试常见菜单容器（原版 ComfyUI / 旧版界面）
    const candidates = [".comfyui-menu", ".comfy-menu"];
    for (const sel of candidates) {
        const c = document.querySelector(sel);
        if (c && c.offsetParent !== null) {
            if (sel === ".comfyui-menu") btn.classList.add("comfyui-button");
            else btn.style.cssText = "font-size:14px;cursor:pointer;margin-top:2px;width:100%;";
            c.appendChild(btn);
            return true;
        }
    }
    return false;
}

function createFloatBall() {
    if (document.getElementById("md-float-ball")) return;
    injectStyle();
    const ball = el("div", { id: "md-float-ball", title: "MissingDoctor 体检清理" }, [
        el("span", { text: "🩺" }),
        el("span", { class: "md-ball-tip", text: "体检清理 · 缺失检查 / 老旧模型 / 清理" }),
    ]);

    // 可拖动 + 区分点击
    let dragging = false, moved = false, sx = 0, sy = 0, bx = 0, by = 0;
    ball.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        dragging = true; moved = false;
        sx = e.clientX; sy = e.clientY;
        const r = ball.getBoundingClientRect();
        bx = r.left; by = r.top;
        ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 6) {
            moved = true;
            ball.style.right = "auto";
            ball.style.bottom = "auto";
            ball.style.left = Math.max(4, bx + dx) + "px";
            ball.style.top = Math.max(4, by + dy) + "px";
        }
    });
    ball.addEventListener("pointerup", () => { dragging = false; });
    ball.addEventListener("click", () => { if (!moved) openDialog(); });

    document.body.appendChild(ball);
}

function addMenuButton(btn) {
    // 立即尝试挂菜单；定制界面（无标准菜单容器）直接用悬浮球，不再等待
    if (!mountMenuButton(btn)) {
        createFloatBall();
        return;
    }
    // 菜单挂载后若容器随后被移除（部分前端会重建顶栏），兜底悬浮球
    setTimeout(() => {
        if (!document.body.contains(btn) || btn.offsetParent === null) {
            if (!document.getElementById("md-float-ball")) createFloatBall();
        }
    }, 5000);
}

// ---------------------------------------------------------------- 注册入口

app.registerExtension({
    name: "MissingDoctor.Panel",
    setup() {
        const btn = el("button", {
            text: "🩺 体检清理",
            title: "MissingDoctor：缺失节点/模型检查、下载推荐、老旧模型、清理",
            onclick: openDialog,
        });
        addMenuButton(btn);

        try {
            if (typeof app.registerCommand === "function") {
                app.registerCommand({
                    id: "MissingDoctor.OpenPanel",
                    label: "Open Missing Doctor Panel",
                    function: openDialog,
                });
            }
        } catch (e) { /* ignore */ }

        console.log("[MissingDoctor] 前端面板已就绪");
    },
});
