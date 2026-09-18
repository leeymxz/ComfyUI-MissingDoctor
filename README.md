# ComfyUI-MissingDoctor 🩺

ComfyUI 体检中心：**缺失节点/模型检测 + 一键自动安装 + 模型下载到模型库 + 使用记录防误删 + 安全清理**。

## 功能

| 功能 | 说明 |
|------|------|
| 🔎 缺失节点检测 | 对比当前工作流引用的节点与已安装节点，在 ComfyUI-Manager 数据库中反查安装仓库 |
| ⚡ 节点一键安装 | 每个缺失节点带「自动安装」按钮，支持一键批量 git clone 到 custom_nodes（浅克隆、重名跳过、域名白名单） |
| 📦 缺失模型检测 | 检查 ckpt / lora / vae / controlnet / unet / clip 等引用是否存在，缺失时从 Manager 模型库、Civitai、HuggingFace（国内自动走 hf-mirror 镜像）搜索下载地址 |
| ⬇ 模型直接下载 | 检测到缺失模型后可一键下载到对应的 models 目录，带实时进度；支持手动关键词搜索 |
| 🕰 老旧模型检索 | 按"最后修改时间"扫描超过 N 天（默认 90，可调）未变动的模型 |
| 🛡 调用记录防误删 | 自动记录每个模型的真实加载时间（挂钩 folder_paths.get_full_path），近期仍在使用的模型标红警告，批量删除自动跳过 |
| 🧹 安全清理 | temp / output（支持保留最近 N 天）/ `__pycache__` / 历史日志，先预览再清理，删除进回收站 |
| 🖱 体验细节 | 面板可拖动并记忆位置、打开自动检测、标签页与天数偏好记忆、四重关闭方式（✕/Esc/点空白/自动） |

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/leeymxz/ComfyUI-MissingDoctor.git
```

安装依赖（可选，推荐）：

```bash
pip install -r ComfyUI-MissingDoctor/requirements.txt
```

> `send2trash` 让删除操作优先进入回收站更安全；`requests` 用于联网查询下载地址（未安装时会退回 urllib）。

重启 ComfyUI 后，点击右下角 **🩺 悬浮球** 打开面板。

## 使用

1. **缺失节点**：打开工作流后自动检测 → 缺失的节点可单个「⚡ 自动安装」或「⚡ 一键安装全部」，完成后重启 ComfyUI 生效
2. **缺失模型**：检测缺失 → 每条候选带「⬇ 下载到模型库」（自动选对目录）；搜不到时用手动搜索框
3. **老旧模型**：输入天数 → 扫描 → 用「全选（自动跳过 ⚠️ 在用）」/ 按类别 / 按大小批量勾选 → 删除（进回收站）
4. **清理**：预览 temp / output / `__pycache__` / 日志的大小与数量，确认后逐类清理

## HTTP API（供脚本/二次开发）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/md/check_nodes` | body: `{"workflow": {"prompt": ..., "ui": ...}}`，检测缺失节点 |
| POST | `/md/check_models` | 同上，检测缺失模型 |
| POST | `/md/remote_search` | body: `{"query": "文件名", "type": "checkpoints"}`，搜索下载地址 |
| GET | `/md/aged_models?days=90&sort=oldest` | 扫描老旧模型（sort 可选 `oldest`/`size`） |
| GET | `/md/cleanup_preview?output_days=7` | 清理目标预览（output 支持 keep_days） |
| POST | `/md/cleanup` | body: `{"category": "...", "paths": [...], "confirm": true, "keep_days": 0}` |
| POST | `/md/download_start` | body: `{"url", "folder_type", "filename"}`，下载模型到模型目录 |
| GET | `/md/download_status` | 下载进度查询 |
| POST | `/md/install_start` | body: `{"items": [{"url", "title"}]}`，批量 git clone 安装节点 |
| GET | `/md/install_status` | 安装进度查询 |
| GET | `/md/model_folders` | 可用模型目录列表 |

## 安全设计

- 所有删除/安装/下载路径逐个校验**白名单**（仅 ComfyUI 注册的模型目录、temp/output/user/custom_nodes），拒绝路径穿越
- 删除接口必须显式携带 `confirm: true`；安装仅允许 https + 常见托管平台域名
- 优先使用 `send2trash` 移入回收站，可随时从回收站恢复
- 远程查询带本地缓存与超时容错，**并行查询 + 总预算控制**，弱网不卡死；检测功能离线可用

## 目录结构

```
ComfyUI-MissingDoctor/
├── __init__.py          # 插件入口
├── api.py               # /md/* HTTP 路由
├── checker.py           # 缺失节点/模型检测核心
├── workflow_parser.py   # 工作流解析（API 格式 + UI 格式）
├── remote_lookup.py     # 下载地址查询（Manager db / Civitai / HF 镜像 / GitHub）
├── aged.py              # 老旧模型扫描（合并调用记录）
├── usage_tracker.py     # 模型调用时间记录（挂钩 get_full_path）
├── downloader.py        # 模型下载器（进度/断点保护/白名单）
├── installer.py         # 缺失节点安装器（git clone 队列）
├── cleaner.py           # 安全清理（白名单 + 回收站）
├── requirements.txt
└── web/js/missing_doctor.js   # 前端面板
```

## FAQ

- **Q: 检测提示节点缺失，但 Manager 显示已安装？**
  A: 大概率是插件加载失败，查看 ComfyUI 启动日志里该插件是否报错。

- **Q: 下载链接打不开？**
  A: Civitai 部分模型下载需要登录；HuggingFace 部分仓库需要同意协议（gated）。国内网络已自动切换 hf-mirror 镜像。

- **Q: 老旧模型会误删吗？**
  A: 三重保护——只列出由你勾选、近期有调用记录的整行标红 ⚠️ 并在删除前二次警告、「全选（自动跳过 ⚠️ 在用）」一键排除，且删除走回收站。

- **Q: 节点安装后没生效？**
  A: 需要**重启 ComfyUI**；若插件自带 requirements.txt，重启后仍缺依赖时手动 `pip install -r` 对应文件。
