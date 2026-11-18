# 智能编辑与 AI 辅助功能方案

> 基于当前代码现状（2026-11-18）制定，回应落地页的两句产品承诺：**「AI 驱动 —— 智能编辑与 AI 辅助」**、**「智能特效 —— 一键自动增强」**。
> 与既有约定保持一致：模型接入沿用**协议族策略模式**（`src/services/ai/protocols/`）、密钥只在服务端、计费走冻结/结算/退款三段式、**浏览器能做的事不上服务端**。

---

## 一、现状盘点（可复用的底座）

### 1.1 服务端 AI 模型（`services/admin/models.ts` DEFAULT_MODELS）

| 模型 | kind | 能力 | 计费 | 状态 |
|---|---|---|---|---|
| Seedance 2.0 | video | 文生视频 + 图生视频（起始帧任意）、带音频、≤15s | 10 点/s(720p)、25 点/s(1080p) | ✅ 启用 |
| Seedance 2.0 Turbo | video | 文生视频、≤10s | 5 点/s(720p) | ✅ 启用 |
| AI 抠像（remove-bg） | tool | 视频抠像 | 30 点/次 | ✅ 启用 |
| AI 擦除（inpaint） | tool | 物体擦除 | 50 点/次 | ✅ 启用 |
| MusicGen 音频 | audio | 配乐生成 ≤30s | 20 点/次 | ⛔ 已禁用（启用路径现成） |
| Whisper 转写 | **local** | 语音转文字，**纯浏览器运行、免费**，永不路由到渠道 | 免费 | ✅ 启用 |

- 视频任务走**服务端托管队列**：`generation_tasks` 落库 → 惰性同步（advisory lock）→ 多渠道自动回退 → 积分冻结/结算/退款（`services/ai/tasks.ts`、`services/billing/ledger.ts`）。
- 工具/音频类走**轻流程**：提交返回 jobId、客户端轮询 `/api/ai/poll`。
- 渠道 = 协议实例（`ark.ts`、`fal.ts`、`declarative.ts` 声明式工厂），admin 面板配置即上下线模型。
- 任务抽屉（`components/editor/task-queue/provider.tsx`）5s 轮询、批量分镜（batchId/batchIndex → `insertBatchIntoTimeline` 一键上轨）、取帧性能埋点（`NEXT_PUBLIC_DEBUG_FRAMES`）。

### 1.2 浏览器侧（智能编辑的算力来源）

- **取帧/解码**：`services/media/mediabunny.ts`（frameAt / framesAt，decode_ms/encode_ms 埋点）、AI 帧选择器（`ai-video-frame-picker.tsx`，缓存已做）。
- **本地模型先例**：`kind: "local"`（whisper-local）——浏览器跑模型、零点数、零流量。
- **转写**：`src/transcription/`（supported-languages 已具备多语言清单）。
- **编辑器内核**：opencut-wasm（时间轴/轨道/关键帧）、场景视图（`scenes-view.tsx`）、素材库（OPFS/IndexedDB，客户端零上传）。

### 1.3 已知技术债（本方案的前置项）

- `/api/ai/poll` 的 jobId 无归属校验（见 `route.ts` 头注释）——工具/音频类模型放量前应补 jobId→用户映射（写入提交时的任务行或轻映射表）。
- 素材 100% 在浏览器，AI 生成物走厂商 URL + 下载代理（已加会话+归属校验）——云端素材化见 `docs/plans/后续开发规划.md`，与本方案正交。

---

## 二、设计原则

1. **本地优先**：分析类、检测类智能（静音检测、镜头切分、封面评分、节拍检测）全部浏览器内完成——免费、即时、可撤销，不占渠道配额。`kind: "local"` 是现成先例。
2. **生成类 AI 走既有四件套**：模型目录（admin 配置）→ 渠道路由 → 冻结/结算 → 任务队列。**新增一个 AI 能力 = 一条模型配置 + 一份协议实现**，计费、队列、审计零改动。
3. **AI 只产生"可撤销的普通元素"**：所有结果（片段切割、字幕轨、配乐、生成的视频）落进时间轴/素材库后与手工操作无差别，复用现有 undo/快照体系，AI 永不直接改渲染管线。
4. **建议制而非独裁制**：智能编辑先给"建议卡片"（预览 + 影响 range），用户确认才应用；一键操作也要能看到将发生什么。
5. **所有新 UI 文案走 t 字典**（zh 源 + en），工具类模型用 `labelKey/descriptionKey`（seedance 有先例）。

---

## 三、分期实施

### P0 — 智能编辑（纯本地，零点数，兑现"智能编辑"）

| # | 功能 | 做法 | 复用 |
|---|---|---|---|
| 1 | **智能粗剪**（去静音/口头禅） | 解码音频 → RMS/VAD 静音段检测 → 可选结合本地 Whisper 转写定位口水词 → 生成"建议删除区间"列表 → 用户勾选后一次性切割+删除 | mediabunny 解码、transcription、时间轴 split/delete |
| 2 | **镜头切分**（场景检测） | 抽帧 → HSV 直方图/帧差比较（阈值可调）→ 自动按镜头切割片段并按序命名，一键入场景视图 | framesAt 批量取帧（已有缓存与埋点）、scenes-view |
| 3 | **智能封面** | 对候选帧打分（清晰度/曝光/构图）→ 推荐封面帧，写入项目缩略图 | frameAt、frame-picker 的预览缓存 |
| 4 | **文本化剪辑** | 转写时间戳 ↔ 时间轴双向映射：删一句话=删对应片段；搜索定位 | whisper-local 转写结果、时间轴选区 |

- 全部跑 Web Worker，避免主线程卡顿；帧分析量用已埋点的 decode_ms 观测。
- 验收：1 分钟素材粗剪 < 3s；所有操作一键整体撤销。

### P1 — AI 辅助（服务端模型，走点数，兑现"一键自动增强"）

| # | 功能 | 做法 | 计费/路由 |
|---|---|---|---|
| 1 | **一键增强**（画质/降噪/色彩） | 新增 `kind:"tool"` 模型（如 enhance），输入当前片段 → 生成增强版 → 替换或并列预览对比 | pricePerCall 走轻流程；放量前补 poll 归属映射 |
| 2 | **AI 字幕成品化** | 本地 Whisper 转写 → （可选）服务端翻译/润色模型 → 直接生成字幕轨元素 + 样式预设（字体/描边/位置） | 本地免费 + 可选 tool 模型 |
| 3 | **智能配乐对齐** | 启用 MusicGen（开关已具备）→ 按时长/情绪标签生成 → 本地做尾部淡出与**自动闪避**（人声段压低 BGM，纯本地增益计算） | 20 点/次既有配置 |
| 4 | **文案 → 分镜 → 批量生成** | 大纲/脚本文本 → LLM 出分镜 prompt 列表（每镜：prompt/时长/宽高比）→ 逐镜创建视频任务（batchId 串联）→ 抽屉里批量查看、`insertBatchIntoTimeline` 一键上轨按序排列 | Seedance 既有链路；LLM 走新 chat/tool 模型 |
| 5 | **AI 生图进素材库** | 补文生图模型（JobFamily "image" 已定义）→ 生成图进素材库 → 一键作为 i2v 起始帧（闭环：生图 → 生视频） | 轻流程 + pricePerCall |
| 6 | **抠像/擦除产品化** | 参数面板（预览首帧、画笔选区）、生成历史、失败一键重试 | 既有 30/50 点模型，无新模型 |

- 验收：每个功能 = 模型目录一条配置 + 一份协议实现 + 一个面板入口；点数流水在 `/api/billing/me` 可查。

### P2 — 进阶（对话式与自动化）

| # | 功能 | 说明 |
|---|---|---|
| 1 | **剪辑助手面板** | 对话式：上下文 = 时间轴结构 + 转写 + 任务状态 → 输出**建议卡片**（"删除 00:12-00:15 的口误？" 应用/忽略），点击才生效 |
| 2 | **音乐卡点** | 本地节拍检测（onset detection）→ 按节拍自动生成切点，配乐换片 |
| 3 | **TTS 旁白** | 新 `kind:"audio"` 模型，文本 → 旁白进音频轨，与自动闪避联动 |
| 4 | **风格模板** | 滤镜/转场/字幕样式/配乐情绪的预设参数包，一键套用全片 |

---

## 四、技术落点（改哪里）

```
新增服务端 AI 能力（P1-1/3/4/5、P2-3）
  services/admin/models.ts     → DEFAULT_MODELS 加一条（id/label/kind/价格/labelKey）
  services/ai/protocols/       → 新协议实现或 declarative.ts 声明式注册
  admin 渠道面板               → 渠道挂模型（即刻生效）
  计费/任务/队列               → 零改动

本地智能（P0 全部、P1-3 闪避、P2-2）
  services/media/mediabunny.ts → 取帧已有；音频解码按同模式补
  src/transcription/           → 转写结果复用
  新 services/smart/           → 建议引擎（静音/镜头/封面/节拍），Web Worker
  editor 面板                  → "智能增强"入口（建议卡片列表）

UI
  components/editor/panels/    → AI 面板扩展；任务抽屉复用 task-queue/provider
  locale/zh.ts + en.ts         → 全部新文案（含 labelKey/descriptionKey）
```

**风险与对策**

| 风险 | 对策 |
|---|---|
| 浏览器算力不足（长视频抽帧卡顿） | Web Worker + 分批调度；`NEXT_PUBLIC_DEBUG_FRAMES` 埋点持续观测 decode_ms |
| 工具类模型被滥用刷点 | 前置补 poll 归属校验；dailyLimit/requiresPro 字段已就绪 |
| 模型/渠道上下线波动 | enabled 开关 + 多渠道回退已有；前端对 502 all_channels_failed 有重试路径 |
| AI 误操作破坏作品 | 原则 3：建议制 + 一键撤销 + 快照 |

---

## 五、里程碑建议

1. **P0（1~2 周）**：智能粗剪 + 镜头切分先行（感知最强、零成本），智能封面、文本化剪辑随后。
2. **P1（2~4 周）**：一键增强 + AI 字幕先上（均复用现有骨架）；分镜批量、生图闭环跟进；启动前先还 poll 归属债。
3. **P2（按数据决定）**：剪辑助手视 P1 使用率排期。

---

> **最后更新**：2026-11-18 —— 初版：本地智能编辑（P0）、服务端 AI 辅助（P1）、对话式助手（P2）三期规划，全部映射到现有模型目录/计费/任务队列设施。
