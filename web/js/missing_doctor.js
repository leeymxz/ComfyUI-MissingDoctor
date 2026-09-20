// ComfyUI-MissingDoctor - 前端面板
// 菜单「🩺 体检清理」按钮 + 四标签面板：
// 缺失节点 / 缺失模型 / 老旧模型 / 清理
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

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
                list.appendChild(el("div", { style: "font-size:12px;margin-bottom:3px" }, [
                    el("span", { text: `${icon} ${j.name} ` }),
                    el("span", { style: "color:#888;font-size:11px", text:
                        j.status === "done" ? "安装成功" :
                        j.status === "exists" ? "目录已存在，跳过" :
                        j.status === "failed" ? "失败：" + (j.error || "") :
                        j.status === "cloning" ? "克隆中…" : "等待中" }),
                ]));
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

        // 一键安装：每个缺失节点取第一个 manager-db 匹配的候选仓库
        const batch = [];
        const noMatch = [];
        for (const ct of data.missing_nodes) {
            const sug = (data.suggestions && data.suggestions[ct]) || [];
            const best = sug.find(s => s.match === "manager-db" && s.repo);
            if (best) batch.push({ url: best.repo, title: ct });
            else noMatch.push(ct);
        }
        if (batch.length) {
            resultBox.appendChild(el("div", { class: "md-row" }, [
                el("button", { class: "md-btn", text: `⚡ 一键安装全部缺失节点（${batch.length} 个）`, title:
                    "用 git clone 自动安装到 custom_nodes，完成后需重启 ComfyUI 生效", onclick: async () => {
                    if (!confirm(`确认用 git clone 自动安装 ${batch.length} 个节点包到 custom_nodes 吗？\n\n${batch.map(b => "· " + b.title).join("\n")}\n\n安装完成后需要重启 ComfyUI 生效。`)) return;
                    try {
                        await startNodeInstall(batch, installBox);
                    } catch (e) { alert("安装启动失败：" + e.message); }
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
                return el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px" }, [
                    el("a", { class: "md-link", href: repo, target: "_blank",
                              text: `${s.title || repo} ${s.match === "github-search" ? "（GitHub 搜索）" : ""}` }),
                    el("button", { class: "md-btn", text: "⚡ 自动安装", title: "git clone 到 custom_nodes，重启 ComfyUI 后生效",
                        onclick: async (ev) => {
                            if (!confirm(`确认安装 ${s.title || repo} 到 custom_nodes 吗？\n安装完成后需要重启 ComfyUI 生效。`)) return;
                            try {
                                await startNodeInstall([{ url: repo, title: ct }], installBox);
                            } catch (e) { alert("安装启动失败：" + e.message); }
                        } }),
                    el("button", { class: "md-btn ghost", text: "复制 clone 命令", onclick: () => {
                        navigator.clipboard.writeText(`git clone "${repo}"`).then(() => {
                            const b = event.target; b.textContent = "已复制 ✓";
                            setTimeout(() => (b.textContent = "复制 clone 命令"), 1500);
                        });
                    } }),
                ]);
            });
            resultBox.appendChild(el("div", { class: "md-card" }, [
                el("div", { class: "md-title", text: "❌ " + ct }),
                el("div", { class: "md-meta", text: "候选安装来源：" }),
                ...(links.length ? links : [el("div", { class: "md-meta", text: "未在 ComfyUI-Manager 数据库中找到，可在 ComfyUI Manager 的 Install via Git URL 中搜索该节点名" })]),
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
            MD_FOLDERS = ["checkpoints", "loras", "vae", "controlnet", "diffusion_models", "upscale_models"];
        }
    }
    return MD_FOLDERS;
}

async function startModelDownload(url, filename, defaultFolder, hintEl) {
    const folders = await getFolders();
    const def = (defaultFolder && folders.includes(defaultFolder)) ? defaultFolder : folders[0];
    const folder = prompt(
        "选择要下载到的模型目录（可修改）：\n" + folders.join(" / "),
        def || "checkpoints");
    if (!folder) return;
    if (!folders.includes(folder)) { alert("目录不在模型库列表中: " + folder); return; }

    const start = await mdFetch("/md/download_start", {
        method: "POST", body: { url, folder_type: folder, filename } });
    if (!start.ok) { alert("下载启动失败：" + (start.error || "未知错误")); return; }

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
                        el("div", { class: "md-meta", text: "已保存到 models/" + s.folder_type + " ，重新打开工作流即可使用" }),
                    ]));
                }
            }
        }
        if (!s.running && s.done) clearInterval(timer);
    }, 1000);
}

function renderModelsTab(body) {
    const resultBox = el("div");
    const dlStatus = el("div");
    const runBtn = el("button", { class: "md-btn", text: "🔍 检测当前工作流", onclick: () => run() });
    const searchInput = el("input", { class: "md-input", style: "min-width:260px",
        placeholder: "手动搜索下载地址（输入模型文件名或关键词）",
        onkeydown: (e) => { if (e.key === "Enter") doSearch(); } });
    const searchResult = el("div");

    async function doSearch() {
        const q = searchInput.value.trim();
        if (!q) { alert("请输入要搜索的模型名或关键词"); return; }
        searchResult.innerHTML = "";
        searchResult.appendChild(el("div", { class: "md-empty" },
            [el("span", { class: "md-spin" }), "正在搜索 " + q + " ..."]));
        try {
            const r = await mdFetch("/md/remote_search", { method: "POST", body: { query: q } });
            searchResult.innerHTML = "";
            const results = r.results || [];
            if (!results.length) {
                searchResult.appendChild(el("div", { class: "md-empty", text: "没搜到候选，试试更短的关键词（去掉版本号/精度后缀）" }));
                return;
            }
            for (const d of results) {
                searchResult.appendChild(el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px" }, [
                    el("a", { class: "md-link", href: d.url, target: "_blank",
                        text: `[${d.source}] ${d.title || d.filename || d.url}` }),
                    el("button", { class: "md-btn", text: "⬇ 下载到模型库", onclick: () =>
                        startModelDownload(d.url, d.filename, null, searchResult) }),
                    el("button", { class: "md-btn ghost", text: "复制链接", onclick: (ev) => {
                        navigator.clipboard.writeText(d.url).then(() => {
                            ev.target.textContent = "已复制 ✓";
                            setTimeout(() => (ev.target.textContent = "复制链接"), 1500);
                        });
                    } }),
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
                const row = el("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px" }, [
                    el("a", { class: "md-link", href: d.url, target: "_blank",
                        text: `[${d.source}] ${d.title || d.filename || d.url}` }),
                    el("button", { class: "md-btn", text: "⬇ 下载到模型库", title: "直接下载到 ComfyUI 对应模型目录",
                        onclick: () => startModelDownload(d.url, d.filename || m.value, m.folders_hint && m.folders_hint[0], hintEl) }),
                    el("button", { class: "md-btn ghost", text: "复制链接", onclick: (ev) => {
                        navigator.clipboard.writeText(d.url).then(() => {
                            ev.target.textContent = "已复制 ✓";
                            setTimeout(() => (ev.target.textContent = "复制链接"), 1500);
                        });
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
                if (!paths.length) { alert("请先勾选要删除的模型文件"); return; }
                // 防误删：优先警告近期有真实调用记录的文件
                const recent = data.items.filter(i => paths.includes(i.path) &&
                    i.last_used && (Date.now() / 1000 - i.last_used) < RECENT * 86400);
                if (recent.length) {
                    const preview = recent.slice(0, 8).map(i => "· " + i.rel_path).join("\n");
                    if (!confirm(`⚠️ 防误删提醒\n\n选中的文件里有 ${recent.length} 个在近 ${RECENT} 天内被调用过：\n${preview}${recent.length > 8 ? "\n..." : ""}\n\n这些模型可能仍在使用中，确定仍要删除吗？`)) return;
                }
                if (!confirm(`确认删除选中的 ${paths.length} 个文件吗？\n将移入回收站（已安装 send2trash），释放约 ${fmtBytes(
                    MD.agedData.items.filter(i => paths.includes(i.path)).reduce((s, i) => s + i.size, 0)
                )}`)) return;
                try {
                    const r = await mdFetch("/md/cleanup", { method: "POST",
                        body: { category: "models", paths, confirm: true } });
                    let msg = `已删除 ${r.deleted_count} 个文件，释放 ${fmtBytes(r.freed)}`;
                    if (!r.trash_used) msg += "（直接删除，未使用回收站）";
                    if (r.errors && r.errors.length) msg += `\n失败 ${r.errors.length} 个：\n` + r.errors.map(e => e.path + ": " + e.error).join("\n");
                    alert(msg);
                    scan();
                } catch (e) { alert("删除失败：" + e.message); }
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
                            if (!confirm(`确认用 pip 安装以下依赖吗？\n\n${missingPkgs.join("、")}\n\n将安装到 ComfyUI 的 Python 环境。`)) return;
                            try {
                                await mdFetch("/md/pip_install", { method: "POST", body: { packages: missingPkgs } });
                                watchPip(() => loadReq(true));
                            } catch (e) { alert("安装失败：" + e.message); }
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
                                    if (!confirm(`单独安装 ${i.requirement} 吗？\n（git 依赖需要本机 git 可用，安装耗时视仓库而定）`)) return;
                                    try {
                                        await mdFetch("/md/pip_install", { method: "POST", body: { packages: [i.requirement] } });
                                        watchPip(() => loadReq(true));
                                    } catch (e) { alert("安装失败：" + e.message); }
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
                if (!names.length) { alert("请先勾选要卸载的包"); return; }
                const total = names.reduce((s, n) => s + ((MD.heavyItems || []).find(p => p.name === n) || {}).size, 0);
                if (!confirm(`确认卸选中的 ${names.length} 个包吗？\n\n${names.join("、")}\n\n一次性 pip uninstall，完成后列表即时更新。`)) return;
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
                } catch (e) { alert("卸载失败：" + e.message); }
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
                    if (!confirm(`确认卸载 ${p.name} ${p.version}（${p.size_str}）吗？\n\n卸载后如插件报 ImportError，重新 pip install 即可恢复。`)) return;
                    try {
                        await mdFetch("/md/pip_uninstall", { method: "POST", body: { packages: [p.name] } });
                        watchPip(() => {
                            MD.heavyItems = (MD.heavyItems || []).filter(x => x.name !== p.name);
                            renderHeavy(el("div", { class: "md-card", style: "border-color:#2f5c3a" }, [
                                el("div", { class: "md-title", style: "color:#7fdc9a", text: `✅ 已卸载 ${p.name}（${p.size_str}）` }),
                                el("div", { class: "md-meta", text: "列表已即时更新；如需精确统计请点「🔄 重新统计」" }),
                            ]));
                        });
                    } catch (e) { alert("卸载失败：" + e.message); }
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
                            if (!confirm(`确认清理「${info.label}」吗？共 ${d.count} 项，约 ${fmtBytes(d.size)}。${scope}${extra}`)) return;
                            try {
                                const r = await mdFetch("/md/cleanup", { method: "POST",
                                    body: { category: cat, confirm: true, keep_days: cat === "output" ? (MD.outputDays || 0) : 0 } });
                                alert(`已清理 ${r.deleted_count} 项，释放 ${fmtBytes(r.freed)}` +
                                      (r.errors && r.errors.length ? `\n失败 ${r.errors.length} 项` : ""));
                                load();
                            } catch (e) { alert("清理失败：" + e.message); }
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
