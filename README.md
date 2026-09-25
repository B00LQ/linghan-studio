# Studio

自托管的 AI 创作台：**一块自己的无限画布**，模型层可接本地 ComfyUI 与云端 API，作品与服务端同源保存。
定位是**本地算力优先、作品归自己、可自行部署**——算力和数据都留在你自己的机器上。

---

## 现在能做什么（P0）

| 能力 | 状态 |
|---|---|
| 无限画布：平移缩放、框选、连线、节点增删、小地图 | ✅ 基于 `@xyflow/react`（MIT），产品与数据模型自研 |
| 节点：**只有 文本 / 图片** | ✅ 图片节点自带提示词、自己出图；镜头与版本宫格概念已删除 |
| **提示词窗口：选中节点才出现**，浮在卡片下方 | ✅ 含该节点生成过的全部画面（点一张即切换并标记选用）+ 输入框 + 参数条 + ↑ 生成 |
| 布局：空位放置 + 一键整理 + 新内容自动进视野 | ✅ 节点不再互相覆盖，按「文本 → 图片」两列重排 |
| 画布手势：**双击加节点 / 拉线生成下游 / 右键菜单** | ✅ 全部创建动作都在画布上，顶部已无按钮 |
| 端口与类型校验 | ✅ 文本(text) → 图片(prompt)；拉线菜单按类型筛选可接的节点 |
| 底部居中浮动条 | ✅ 缩放（−/百分比/＋/适应）+ 整理布局，居中不占画布空间 |
| 资产页签 | ✅ 侧栏「画布 / 资产」，缩略图 + 体积；`GET /api/assets` |
| 素材上传 | ✅ `POST /api/assets`（正文即文件），内容寻址自动去重；上传的素材与生成结果同一种节点 |
| 撤销 / 重做 | ✅ 快照式，上限 50 步；`Ctrl+Z` / `Ctrl+Shift+Z` |
| 生成：画布 → 服务端网关 → 出图 → 回填节点 | ✅ 已端到端实测 |
| 作品持久化：画布文档存服务端，换设备打开一致 | ✅ 防抖自动保存 |
| 访问密码 + 会话 Cookie + 登录限流 | ✅ 对外发布所需 |
| 内容寻址素材库（同字节去重） | ✅ |
| OpenAI 兼容网关（`/v1/images/generations` 等） | ✅ 画布零改造即可换后端 |
| Agent 双入口 | ✅ **外部 Agent 可用 HTTP 独立完成创作**（7 个工具，无人值守）；人在场时画布自动同步 |
| 生成历史（原 Shot / Take） | ✅ 每个图片节点持有自己的版本历史：提示词/种子/耗时/失败留痕，点开节点即可见 |
| 本地算力后端（ComfyUI / Z-Image Turbo） | ✅ 已端到端实测：本机 4070 出图，热态 **~6 s / 张**（1024×1024） |
| Docker 一键部署 | ✅ `docker compose up -d --build` 已实测：容器内登录、建项目、出图、素材落盘到宿主机卷 |

## 图片后端（`STUDIO_IMAGE_DRIVER`）

| 值 | 行为 |
|---|---|
| `stub`（默认） | 返回**真实尺寸**的渐变占位图，用来验证整条链路；无需任何外部依赖 |
| `ark` | 火山方舟即梦图像生成，需要 `ARK_API_KEY` |
| `comfyui` | ✅ 本地 ComfyUI（Z-Image Turbo）。开箱即用的本机出图 |

> 占位图不是拿一张 1×1 像素糊弄：服务端自己编码 PNG，尺寸跟随请求，所以能验证分辨率、素材落盘与画布渲染。

`GET /api/image-backend` 会真去探一次后端，回答「服务活着吗 / 节点齐吗 / 模型文件在吗」：

```json
{ "driver": "comfyui", "ok": true, "detail": "本地 ComfyUI 0.36.0 就绪",
  "comfyui": { "reachable": true, "missingNodes": [], "missingModels": [], "version": "0.36.0" } }
```

---

## 快速开始

### Docker（推荐）

```bash
cp .env.example .env      # 至少改 STUDIO_PASSWORD
docker compose up -d --build
# 打开 http://服务器IP:8080
```

生产环境请通过 Nginx/Caddy 套 TLS 并设 `STUDIO_SECURE_COOKIES=1`，否则会出现「密码正确却登录不上」——登录其实成功了，但浏览器丢弃了带 `Secure` 的 Cookie。

### 本地开发

```bash
pnpm install
pnpm dev:server           # 服务端 :8080（需要 STUDIO_PASSWORD）
pnpm dev:web              # 画布 :5173，API 自动代理到 :8080
```

首次进入会提示输入访问密码；没有项目时会自动创建第一个。

### 用本机显卡出图（ComfyUI）

```bash
# 1. 起本地算力（--listen 0.0.0.0 必需，否则容器连不上）
#    Windows 上一般是 ComfyUI 目录里的 run_nvidia_gpu.bat 或自备的启动脚本
<你的 ComfyUI 启动方式>

# 2. studio/.env
STUDIO_IMAGE_DRIVER=comfyui
COMFYUI_URL=http://host.docker.internal:8188

# 3. 重启
docker compose up -d --build
```

模型三件套（Z-Image Turbo 的 UNet / 文本编码器 / VAE）放在 ComfyUI 的 `models/` 下对应子目录；
文件名必须与 `apps/server/src/comfyui/z-image-turbo.json` 里的 `models` 一致，否则
`/api/image-backend` 会直接点名缺哪个文件。

出图耗时（RTX 4070，1024×1024）：**冷启动首张 ~70–90 s**（搬运权重进显存），**之后 ~6 s / 张**。
6 s 这个数字依赖 torch 的 **cu130** 构建——ComfyUI 的融合算子要求 cu130，
用 cu128 会退回 eager 后端、慢到 ~18 s。

### 用本机显卡出视频（MiniMax H3 · 带声音）

视频走**同一套 ComfyUI**，但模型重得多（几十 GB 权重，靠 `DynamicVRAM` 分片搬进 12 GB 显存），
一条片是分钟级。画布上的「视频」节点可以**逐节点**选工作流，内置三份：

| 工作流 | 说明 |
|---|---|
| `minimax-h3-video` | 社区 turbo 蒸馏，**8 步**。新节点的默认值 |
| `minimax-h3-video-fast` | 同一张图，换成 **4 步** turbo 蒸馏（这份按 768p 训练） |
| `minimax-h3-video-pdd` | **官方 PDD 加速**（alibaba-pai），4 步；需要自定义节点包，见下 |

实测（RTX 4070，1344×768）：3 秒片 8 步 **485 s**、4 步 **400 s**；5 秒片 8 步 **666 s**。
**注意固定开销占大头**——装载约 139 s、解码几十到上百秒，都不随步数变，
所以「步数减半」在 3 秒片上只快不到两成；片越长，采样占比越高，省得越多。

模型文件名必须与 `apps/server/src/comfyui/minimax-h3-video*.json` 里的 `models` 一致。
官方 PDD 那条额外需要（缺任何一样，它**不会出现在下拉里**，工作流页会写明缺什么）：

```bash
# 1. 插件：装完必须重启 ComfyUI 才会加载
git clone https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc \
    <ComfyUI>/custom_nodes/ComfyUI-MiniMax-H3-PDD-Acc

# 2. 权重（约 1.4 GB）放进 <ComfyUI>/models/pdd_acc/
#    huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs
#      → MiniMax-H3-FL2VA-Acc-8Step.safetensors
```

它和 turbo LoRA 不是同一种东西：文件里除主干 LoRA 还带一套「每区间最后一层投影」的头库，
**普通 LoRA 加载器读不了**，所以必须走那个插件节点。配方是死的（euler、CFG 1.0、
shift 正好 12/3、不能叠别的蒸馏 LoRA），写错它会直接报错，不会悄悄出坏图。

---

## 架构

```
apps/web                画布前端：React + @xyflow/react，构建产物由服务端托管
apps/server             单进程服务端
  ├── auth.ts           访问密码 → 签名 Cookie，含登录限流
  ├── gateway.ts        OpenAI 兼容网关；stub / ark / comfyui 驱动
  ├── comfyui.ts        本地算力驱动：模板替换 → /prompt → 轮询 → 取字节
  ├── comfyui/*.json    API 格式工作流模板（换模型只改这里）
  ├── bridge.ts         通知通道：文档变了就广播给开着的画布（不遥控浏览器）
  ├── ops.ts            服务端 op 执行器：直接改画布文档（人机共用同一份 schema）
  ├── agent.ts          Agent 工具面：7 个工具 + JSON Schema，含自动建镜头与记账
  ├── store.ts          SQLite：项目 / 画布 / 镜头 / take / 素材
  └── png.ts            零依赖 PNG 编码（占位驱动用）
```

## 两段式与双入口

**两个入口，一份文档。** 人的入口是画布点击；Agent 的入口是 HTTP 工具面：

```bash
GET  /api/agent/tools                    # 工具清单（含 JSON Schema）
POST /api/agent/call  {"name":"canvas_generate","input":{"nodeId":"image-…"}}
```

Agent 的生成走**和点击完全相同的那条路**——同样的素材库、同样的镜头、同样的 take 记账，
所以「Agent 画的」和「人画的」在数据上无法区分，也不该被区分。
Agent 不需要浏览器开着（无人值守路径）；
若画布有人开着，改动会自动出现。

**两个设计决定值得记住：**

1. **画布只认 OpenAI 形状的接口**。前端从不关心背后是本地还是云端，换后端不动一行前端代码。
2. **画布文档整份存服务端**。文档很小，整份读写让服务端契约保持极简，也让作品天然可迁移。

## 数据

`STUDIO_DATA_DIR`（容器内 `/data`）下是 `studio.sqlite` 与 `assets/`。备份这一个目录即可。

---

## 路线

| 阶段 | 目标 |
|---|---|
| **P0** 可发布 | Docker + 密码 + 画布出图 ✅ |
| **P1** 有自己的东西 | 本地 ComfyUI 驱动 ✅；Shot/Take 进画布 UI ✅；视频节点 ✅（MiniMax H3，含音频）；Agent 工具面接通 ✅ |
| **P2** 专业化 | 导演台（3D 摆位）、逐帧拉片、片段重拍、时间线与智能剪辑；图生视频（首帧） |
| **P3** 可安装 | 桌面安装包 / 单文件可执行 |

## 已知限制

- **未做多租户**：一个部署一份密码，项目对所有登录者可见。要做团队/计费需要加账号体系。
- **take 尚无重拍动作**：版本会记录、能比较、能选用，但还不能「用这个 take 的参数再跑一次」（种子已经存下来了，缺的是触发入口）。
- **失败 take 会留痕但无法重试**：历史里能看到失败与原因，重试要手动再点一次生成。
- **画布文档是全量覆盖写**：两人同时编辑同一项目会互相覆盖。
- **本地生成是串行的**：一张卡一次跑一条，`n > 1` 会排队。渲染走**作业队列**：
  提交立刻返回、每步进度经 WebSocket 回传、可以取消、刷新页面能接上还在跑的那条
  （服务端把结果写回画布文档，所以关掉浏览器也算数）。
- **没有音频节点**：视频自带声音，独立的音频生成节点尚未接入。
- **视频只有两档画幅**（1344×768 / 768×448）与三档时长实测过，菜单里只放这两档。
- **图生视频（首帧）尚未接入**：`MiniMaxH3ImageToVideo` 本身支持首帧/尾帧，
  缺的是本产品这条链路（上传首帧到 ComfyUI 再接线），所以视频节点上**没有**那个端口。
- **画布是整份覆盖写**：两人同时编辑同一项目会互相覆盖（Agent 与人的并发也是同一问题）。
- **粘贴未实现**：右键菜单里因此没有「粘贴」条目（不放点了没反应的项）。
- **文本节点不能生成**：需要 LLM 供应商，按钮禁用并写明原因。
- **图片节点只有提示词输入**：图生图（参考图）尚未接入——生成链路还不认参考图，所以没有加这个端口。
- **框选不会打开提示词窗口**：窗口只认「点某个节点」。
- **画面节点的输出端口暂无下游**：拖出来会如实显示「暂时没有可接的节点类型」。
- **右键菜单只在空白处**：节点上的右键菜单（复制 / 删除 / 禁用）尚未做。

## 许可与致谢

**专有软件，不是开源项目。** 版权所有，保留所有权利；公开可见不等于可以自由使用、
修改或再分发。完整条款见 [LICENSE](LICENSE)。

交互引擎 [@xyflow/react](https://github.com/xyflow/xyflow)（MIT，按其许可保留版权声明）。
画布的实现为本仓库自研。模型权重不随本仓库分发，其许可归各自的发布方。
