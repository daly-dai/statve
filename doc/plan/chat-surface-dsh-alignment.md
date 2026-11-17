# 聊天面重构（转录稿 / 输入台 / 思维链）—— 对齐 DSH

> 池子：**C57**（转录稿与输入台）、**C58**（思维链）—— 两项共用本文件
> 状态：**详细设计已写、验收已写；3 个决定 + 红线那一步待拍板**（见第六节）
> 参考（一手源码，本地）：`E:\agents-read\deepseek-harness\packages\client\{ui-chat, ui-conversation, ui-primitives}`
> 触发：用户 2026-11-17「我们聊天框和聊天链表渲染那 现在的有点太粗糙了 也很丑 思维链也不展示」

---

## 一、需求（池子行原文）

> **C57｜转录稿与输入台重排（对齐 DSH）**：去掉每条消息左侧「你 / AGENT / 时间」发言栏；用户消息改**右对齐气泡**、助手改整宽；一次工具调用的「CALL 行 + 结果卡」**合并成一条 24px 流程行**（点开看输出）；回合尾加一行「用时 · N 步」并可折叠整回合；间距改成 4 / 12 / 16 三档；输入台收成「卡 + 工具栏（模式 chips / 模型 / 34px 发送圆）」

> **C58｜思维链展示**：模型流式返回的 `reasoning_content` 现在**逐字丢弃**（`lib/deepseekModel/index.ts:328-332` 只读 `delta.content`）—— 改成收进消息、渲染成一条可展开的「思考」行（折叠态 24px，摘要取最近一段首行）

---

## 二、依据

### 2.1 DSH 的转录稿：不是"排版好看"，是**一套可命名的间距层级 + 一种可复用的行**

| 事实 | 位置 |
|---|---|
| 三个间距常量：**流程行之间 4px**、**助手回答前后 12px**、**回合头之后 16px** | `ui-chat/src/client/chat/ChatView.module.css:86`（`--dsh-chat-flow-gap: 4px`）、`:91-98`（`response` 覆盖为 12px）、`:140-144`（`turn-process` 之后 16px） |
| 版心 748px 居中，滚动区两侧 `clearance + 16px`；消息列与输入卡同轴 | `ChatView.module.css:32,69-76` |
| 用户消息 = **右对齐气泡**：`--dsw-specific-bubble` 底、`border-radius: xl`、`padding: 10px 16px`、14/22、`pre-wrap`；气泡之间 8px、到动作行 6px；宽度上限 = 版心 × 0.702（或 82%） | `ui-primitives/src/UserMessageBubble.module.css:1-11`；`ui-chat/src/client/chat/MessageItem.module.css:3-21` |
| 助手消息 = **整宽 markdown**，14/24，块间距 16px；**没有任何"发言人栏"**（身份由回合结构承担） | `AssistantMarkdown.module.css:9-22` |
| 工具调用 / 思考 / 压缩 = **同一种 24px 折叠行**：16px 图标盒 + 6px gap + 13px 标题；三级墨色，hover 变二级；hover 时图标换成 chevron | `ui-primitives/src/DisclosureRow.module.css:30-40,46-50,52-74,80-102,104-109` |
| 回合结束 = 一行 **「用时 12 秒」**（`height: 33px`、`padding-bottom: 8px`、0.5px 底分隔线），点它**折叠整回合的过程**；`aria-expanded` 齐全 | `ui-chat/src/client/chat/TurnProcessNodeView.tsx:37-59`、`.module.css:1-18` |
| 运行中 = 蓝色 28px 行（鲸鱼图标 + 会走光的文本「Deep diving for 12s」），与回合尾行同槽位 | `ChatView.module.css:218-279`、`RunningStatus.tsx:33-45` |

### 2.2 DSH 的思维链：24px 折叠行 + 一行会走的摘要

| 事实 | 位置 |
|---|---|
| 折叠态**固定 24px**（`contain: size layout` + `height`），展开后才长高 | `ReasoningRow.module.css:6-9` |
| 折叠内容 = `[思考图标 14px] 思考 · 一行摘要`；摘要 13px 单行省略；2×2px 分隔点 | `ReasoningRow.module.css:32-57`；`ReasoningRow.tsx:10,95-107` |
| 摘要取法：**结束时取首行；流式中取"最近一个已完成段落的首行"**；去掉 `**` 标记 | `ReasoningRow.tsx:12-33,64-67` |
| 流式中摘要右端 mask 渐隐（48px）；文字用 shimmer（高光扫过） | `ReasoningRow.module.css:59-66`；`ui-primitives/src/TextShimmer.tsx` |
| 展开后：二级字号 markdown，缩进 22px，**头部 sticky**（长思考滚动时开关还在） | `ReasoningRow.module.css:15-22,73-77` |
| 只有 `<signature>…</signature>` 的思考**整行不渲染** | `ui-chat/src/client/reasoning-text.ts:8-24` |

### 2.3 DSH 的输入台：卡 → 文本区 → 工具栏

| 事实 | 位置 |
|---|---|
| 卡：`border-radius: panel`、上内边距 8px、卡内 `gap: 12px`、`box-shadow: soft` + 0.5px 描边、字号 14/24 | `ui-conversation/src/client/skeleton/InputBar.module.css:54-86` |
| 文本区：`min-height: 36px`、`padding: 4px 8px 0 14px`、最多 14 行后内部滚动；占位符**绝对定位**、单行省略 | `:145-202,235-244` |
| 工具栏：左＝`＋` 28px 圆 + 模式 chips（12px gap）；右＝模型 select + **34px 蓝色圆形发送**（空文本 0.4 透明度） | `:273-434` |
| 无工作空间时：**整张卡变成"选工作空间"触发器**（内嵌 1px 虚线描边、整卡可点、控件点击穿透） | `:97-125`；`InputBar.tsx:169,458-463` |

### 2.4 我们的现状（数字）

| 位置 | 现状 |
|---|---|
| `app/components/message-row/index.tsx:112-134` | 每行 = `grid-template-columns: var(--gutter) 1fr`，左栏塞 `你 / AGENT / 时间`（`--gutter: 84px`） |
| `app/components/message-row/message-row.module.css:15-23` | 行间距 **26px**；工具结果 10px |
| 同 `:74-79` | 用户消息 = **左对齐**浅蓝块 + 2px 左边线（不是右气泡） |
| 同 `:178-207` | 工具调用单独一行 `CALL bash {"command":…}`（等宽标签 + JSON 原文） |
| 同 `:234-...` | 工具结果又是另一张卡（`✓ 成功` / `N 行` / `展开`）⇒ **一次调用占两块** |
| `app/page.tsx:404-409` | 审批模式 switch 在输入卡**外面**，独占一行 |
| `app/page.tsx:481-534` | 输入台 = textarea + 圆环 + 文字「发送」按钮 + 两行底栏 |

### 2.5 实测：思考文本确实在流，我们在扔（2026-11-17）

方法（可复现）：拿 `.env.local` 的 key 直连 `https://api.deepseek.com/chat/completions`，`model=deepseek-v4-flash`、`stream=true`，问「9.11 和 9.9 哪个大？先想清楚再答，只答结论。」

结果：
- `delta` 里出现的字段：`content`、`role`、**`reasoning_content`**；
- 同一问题攒出 **242 个字符**的 `reasoning_content`（开头 `We need answer Chinese. Need determine 9.11 vs 9.9…`）；
- 最终 `content` = `9.9 大。`

⇒ 数据在门口就有，缺的是三处接线（类型 / 适配器 / 渲染）。

---

## 三、目标形态（一轮对话长什么样）

```
                                        快照：把侧栏改成单行            14:02
                                        └ 右对齐气泡（max 70% 版心，radius 16）
  [✳] 思考 · 先确认这段代码在哪…                                     ← 24px 流程行
  [⌘] bash · echo hi                                    ✓            ← 24px 流程行（点开看输出）
  [⌘] read_file · agent-notes.md                        ✓
  ─────────────────────────────────────────────────────────────
  助手正文（整宽 markdown，14/24，块间距 16px）
  ……

  ─────────────────────────────────────────────────────────────
  本回合用时 12 秒 · 3 步                                        ⌄   ← 33px 行 + 0.5px 线
```

要点（每条都能对上第二节的证据）：

1. **取消"每条消息一个发言栏"**：身份由位置承担（右＝你、左＝助手/工具）。时间只留在**回合尾**与侧栏；
2. **一次工具调用 = 一行**：图标 + 工具名 + 参数摘要 + 状态（✓/✗/进行中），点开才是输出；
3. **思考 = 同样的行**（第三种内容，不是新样式）；
4. **回合尾**一行说清"这一轮花了多久、跑了几步"，点它折叠整回合过程；
5. 三层间距（4 / 12 / 16）落在 CSS 变量上，不在每个组件里各写魔法数字。

---

## 四、详细设计

### 4.1 间距与字号的映射（DSH 值 → 我们的 token）

不新造色值、不新造字号体系；只新增**三个间距变量**：

| 变量 | 值 | 用在哪 | 依据 |
|---|---|---|---|
| `--gap-flow` | `4px` | 同一回合内相邻流程行（思考 / 工具）之间 | DSH `ChatView.module.css:86` |
| `--gap-response` | `12px` | 助手正文块的前后 | 同上 `:91-98` |
| `--gap-turn` | `16px` | 回合与回合之间；回合尾行的上边距 | 同上 `:140-144` |

字号（沿用现有 `globals.css`，一个都不新增）：

| 元素 | 字号/行高 | 用现有值 |
|---|---|---|
| 助手正文 | 14.5 / 1.7（`markdown-body` 现状） | ✅ |
| 流程行标题 | 13px | 等于今天的 `.callName` |
| 流程行摘要 | 12.5px 单行省略 | 等于今天的 `.sessionPreview` 那档 |
| 用户气泡内文字 | 14.5 | 等于今天 `.said` 里的 `markdown-body` |
| 回合尾 | 12px 等宽（数字用 `tabular-nums`） | 等于今天的 `.rowTime` |

颜色：流程行默认 `--ink-mid`，hover `--ink`；状态点 `--pen-model`（成功）/ `--pen-error`（失败）/ `--pen-signal`（进行中）。
**不新增色相** —— DSH 的灰色阶梯在我们这里就是 `--ink / --ink-mid / --ink-faint` 三档。

### 4.2 数据层：先折叠成"回合"，再渲染（纯函数，node 可测）

今天 `page.tsx` 直接把 `messages` 逐条丢给 `<MessageRow>`，所以"回合"这个概念在前端**不存在**。先补一层纯函数：

```ts
// app/lib/transcript/index.ts —— 纯函数（不碰 React、不碰 fetch）
export type TranscriptBlock =
  | { kind: "reasoning"; text: string; streaming: boolean }     // C58；P1 阶段先不产出
  | { kind: "tool"; call: ToolCallContent; result?: ToolResultMessage; liveOutput?: string }
  | { kind: "narration"; text: string; streaming: boolean }
  | { kind: "compaction"; message: CompactionSummaryMessage }
  | { kind: "injection"; name: string; payload: string };        // 技能注入（有 source 的 user 消息）

export type TranscriptTurn = {
  id: string;                    // 回合起点那条消息的 timestamp
  user: UserMessage | null;      // 注入回合为 null
  blocks: TranscriptBlock[];
  durationMs?: number;           // 只有"本次 run 里跑出来的回合"才有
  running: boolean;
};

export function buildTranscript(input: {
  messages: AgentMessage[];
  observed: ObservedEvent[];     // { seq, at, event }（app/lib/sse.ts:56）
}): TranscriptTurn[];
```

规则（每条都要有单测）：

| 规则 | 为什么 |
|---|---|
| `user` 消息（含 `source.kind === "skill-invocation"` 的注入件）**开启新回合** | 回合是"用户视角的一轮"；注入件是宿主造成的一轮，也要独立成段 |
| `assistant` 的 `text` 块 → `narration`（同一回合内多个 assistant 消息 ⇒ 多个 narration 块，按顺序） | 一轮里模型可能说两段话（中间夹工具） |
| `assistant` 的 `toolCall` 块 → `tool` 块；`toolResult` 按 `toolCallId` **配对**进同一个块 | 这就是"一次调用 = 一行"的数据前提 |
| 找不到发起者的 `toolResult` → 仍然出一个 `tool` 块（`call` 用最小信息补） | 会话文件被截断/手工改过时不至于整行消失 |
| `stopReason === "error"` 的助手消息 → 回合内补一条错误块 | 今天错误只在页面横幅，翻历史时看不到 |
| `durationMs` = 该回合所有 `turn_start.at` 到最后一个 `turn_end.at` 的**墙钟差**（含工具等待） | 文案写「用时」，就得是墙钟，不是模型耗时 |
| `observed` 为空（刷新后读历史）⇒ `durationMs` 为 `undefined` | 时间戳没落盘；不许编一个数字出来 |

> `ObservedEvent = { seq; at; event }`（`app/lib/sse.ts:56`）—— 每个事件都带到达时间，所以墙钟差可以算。

### 4.3 组件树与契约

```
page.tsx
└─ <Transcript turns={buildTranscript(...)} liveOutputs={toolOutputs} />   ← 新
   ├─ <Turn>                       app/components/transcript/
   │  ├─ <UserBubble>              app/components/user-bubble/            ← 新
   │  ├─ <ProcessRow …>            app/components/process-row/            ← 新（通用 24px 行）
   │  ├─ <Markdown>                （复用）
   │  └─ <TurnTail>                app/components/turn-tail/              ← 新（用时 · 步数 · 折叠）
```

`ProcessRow` 的契约（一份实现，三处用：思考 / 工具 / 未来别的步骤）：

```ts
type ProcessRowProps = {
  icon: ReactNode;          // 14px 图标
  label: string;            // 「思考」/「bash」/「read_file」
  summary?: string;         // 一行摘要（单行省略）
  status?: "ok" | "error" | "running";  // 右侧状态点；toolless（思考）没有
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;     // 展开内容
};
```

- 折叠态**固定 24px**（`height: 24px` + `overflow: hidden`），行内 `gap: 6px`、图标盒 16px —— 与 DSH 同构；
- hover 时图标换成 chevron（`aria-expanded` 在行上）；
- 展开内容缩进 22px（对齐 DSH `ReasoningRow.module.css:74`）。

### 4.4 工具行：把"两块钱"合成"一块"

| 今天 | 改后 |
|---|---|
| `CALL bash {"command":"echo hi"}`（`message-row.module.css:178-207`） | 头部一行：`bash` + 参数摘要（`command` 单行截断；其他 tool 用紧凑 JSON）+ 状态点 |
| `apparatus` 结果卡（`✓ 成功` / `N 行` / `展开`） | 展开区里的 `<pre>`；头部右侧显示 `N 行`；失败时头部状态点变红、展开默认打开 |
| bash 实时输出（`toolOutputLive`） | 运行中自动展开、追加输出；结束后收起但保留"曾展开"状态 |

参数摘要规则（纯函数，可测）：`bash` → `command`；`*_file` → `path`；`grep`/`find` → `path` + `pattern`；其它 → `JSON.stringify` 截 80 字。

### 4.5 回合尾：用时 + 步数 + 折叠整回合

- 文案：`本回合用时 12 秒 · 3 步`；运行中不显示（运行态由底部一条 28px 行「思考中 · 12s」承担，抄 DSH `ChatView.module.css:218-279`）；
- 点击折叠/展开**该回合的所有流程行**（思考行与工具行一起收），但不折叠助手正文 —— DSH 的 `.foldable` 是同一语义；
- 折叠状态放在 `app/lib/transcript` 的派生视图里（`useState<Set<turnId>>`），不落盘。

### 4.6 输入台：卡 / 文本区 / 工具栏

| 层 | 改后 | 与今天的差别 |
|---|---|---|
| 卡 | 保留 `--plate` 底 + `--line` 边 + `--r-lg` 圆角（**不改成 DSH 的 elevation+大圆角**，见 4.7） | 视觉主体不变 |
| 文本区 | textarea 保留；`min-height` 36px、`padding: 6px 8px 0 14px`；仍然自动长高 | 微调 |
| 工具栏 | **新**: 左＝审批模式 chips（把 `ApprovalModeSwitch` 从卡外移进来）+ 上下文圆环；右＝发送/停止（**34px 圆 + 图标**） | 今天是"圆环 + 文字按钮"，且模式在卡外 |
| 底栏 | 收成**一行**（左：`N 轮 · N 工具 · N token`；右：Enter 提示） | 今天是两行 |

> 目的：把"模式 / 上下文 / 发送"三个操作收进同一张卡的工具栏，视觉上变成"一台控制台"而不是"一个输入框旁边挂了三样东西"。

### 4.7 明确不抄的（防止范围失控）

| DSH 有 | 我们不做 | 理由 |
|---|---|---|
| Lexical contenteditable 编辑器（chips / @ 引用 / 命令高亮） | 继续用 `<textarea>` | 我们已经有命令面板（C13）覆盖同类需求；换编辑器是重写输入层，风险与收益不成比例 |
| 附件 / 图片 / 文件卡 | 不做 | 不在本次需求里 |
| 模型下拉选择 | 不做 | 我们的模型来自 `lib/config`（`DEEPSEEK_MODEL`），运行时切换是另一项 |
| 分支 / 引导 / 排队（branch / steer / queue） | 不做 | 需要后端会话树与队列，C18 已明确砍树 |
| 字号偏好、拖宽、虚拟滚动 | 不做 | 没有需求支撑；虚拟滚动在几百条消息内无必要 |
| "无工作空间时整卡变选择器" | 不做（先做禁用，见 `session-sidebar-ux.md` 4.5） | 要把目录浏览器搬进输入框，是独立的结构改动 |

### 4.8 思维链（C58）：三层接线（P2 = 不碰红线）

**① 类型**（`lib/types.ts`）

```ts
export type ReasoningContent = { type: "reasoning"; text: string };
// AssistantMessage.content: Array<TextContent | ToolCallContent | ReasoningContent>
```

⚠️ 这会让所有按 `type` 过滤 `content` 的地方**在编译期报错** —— 这是好事，它逼我们把"哪些地方必须忽略思考"逐个表态。已知要处理的：

| 地方 | 要求 |
|---|---|
| `lib/deepseekModel/index.ts` 的 `toOpenAiMessages` | **跳过** reasoning 块（不能把思考当 `content` 回传） |
| `lib/message/index.ts` 的 `messageText` | 只拼 `text` 块（否则摘要/标题预览会掺进思考） |
| 压缩摘要的输入（`lib/summarize` / `_pipeline` 里取上下文的地方） | 同上 |
| `lib/session/store` 落盘 | 见第六节第 3 个决定（写不写会话） |

**② 适配器**（`lib/deepseekModel/index.ts`）

- 流式：`StreamAccumulator` 增加 `reasoningBuffer`；在 `appendTextDelta` 旁边加 `appendReasoningDelta(delta.reasoning_content, acc)`（`delta.reasoning_content` 是字符串才收）；
- 非流式：读 `message.reasoning_content`；
- 组装：`content.push({ type: "reasoning", text: reasoningBuffer })` **放在 text 之前**（事实顺序：先想后答）；
- 清洗：只有 `<signature>…</signature>` 的思考 → 不产出块（抄 `reasoning-text.ts:8-24` 的判据）。

**③ 渲染**（`app/lib/transcript` + `ProcessRow`）

- `buildTranscript` 把 reasoning 块 → `{ kind: "reasoning", text, streaming: false }`；
- 摘要纯函数 `reasoningSummary(text, running)`：`running` 时取"最近一个已完成段落的首行"，否则取首行；去掉 `**`；空文本返回 `""`（返回空串时**整行不渲染**）；
- 展开区用现有 `<Markdown>`，但套 `.thinkBody` 的二级字号（13px）与 22px 缩进。

### 4.9 思维链流式（P3，**红线**）

P2 的代价：**流式期间看不到思考**，思考行要等该条助手消息 `message_end` 才出现。

要实时，只能让引擎把 reasoning 增量发出来 —— 这动 `lib/agent/index.ts`（红线文件），按 `AGENTS.md` 第 0 条必须：

1. 先精读 pi 的对应实现（pi 的 `complete` 回调形态 / 事件命名）；
2. 写对比结论（pi 怎么区分 text 与 reasoning 增量、事件怎么进 store）；
3. 展示给用户；
4. 用户确认后**单独一个 commit**（禁止与 P1/P2 混）。

技术路径（待红线流程确认）：`onDelta` 扩成 `onDelta(kind, text)` 或新增 `onReasoningDelta`；引擎 emit 一个新事件（或在 `message_update` 上加字段）；`run-store` 收到后更新"当前 streaming 的 reasoning 块"；`buildTranscript` 的 `streaming: true` 走 shimmer + 渐隐。

### 4.10 分期、提交切分与先后

| 期 | 内容 | 触碰文件 | 红线 |
|---|---|---|---|
| **P1** | 数据层 `app/lib/transcript`（`buildTranscript` + 参数摘要）+ 组件（`Transcript` / `UserBubble` / `ProcessRow` / `TurnTail`）+ `page.tsx` 接线 + 删 `message-row` | `app/lib/transcript/`、`app/components/{transcript,user-bubble,process-row,turn-tail}/`、`app/page.tsx` | 否 |
| **P2** | 类型 + 适配器 + 渲染思考行（非流式）+ 三处过滤 | `lib/types.ts`、`lib/deepseekModel/`、`lib/message/`、`app/lib/transcript/`、`app/components/process-row/` | 否 |
| **P3** | 实时思考增量 | `lib/agent/index.ts` + `run-store` | **是** |

建议顺序：**P1 → P2 →（单独评审）P3**。每一期都能独立跑、独立验收、独立提交。

### 4.11 已知边界与代价（写着，别假装没有）

1. **P2 期间思考不是实时的**：一条助手消息结束后才出现。工具循环里会"一跳一跳"地出现，不是逐字长出来。
2. **历史回合没有「用时」**：时间戳没落盘（`seconds` 只在本次 run 的 `observed` 里），刷新后只有步数与折叠。
3. **行高 24px 是固定值**：内容（摘要）超长只靠省略号；完整内容在展开区。
4. **折叠"整回合"只折叠流程行**，不折叠正文 —— 与 DSH 同语义（正文是读者要看的东西）。
5. **`message-row` 目录会被删掉**：`SkillCard` / `CompactionCard` 的逻辑要搬进 `Transcript` 的块渲染（`skill-card` 组件本身保留）。
6. **思考块进 `AssistantMessage.content` 后，会话文件会变大**：一条助手消息多一段思考文本。这是第六节第 3 个决定。

---

### 4.12 草稿与会话绑定（**C59**，2026-11-17 用户定：这是新功能，不是修 bug）

#### 现状（为什么它不是 bug 而是一个功能）

输入内容是**页面级的一份状态**，跟"当前是哪个会话"无关：

- `app/lib/use-command-menu.ts:67-92` 换会话时只重取命令清单，**没有**清空或按会话存取输入；
- 于是：在 A 会话打了一半字 → 切到 B → 那段字**还在框里**，按发送就带着 **B 的 sessionId** 发出去。

#### 目标行为

| 场景 | 期望 |
|---|---|
| A 里打了字没发，切到 B | A 的草稿留着；B 的输入框显示 **B 自己的**草稿（通常是空的） |
| 切回 A | 那段字**原样回来**（光标位置不强求） |
| 发送成功 / 命令执行完 | 该会话草稿清空 |
| 新建会话 | 草稿是空的（不继承上一个会话的字） |
| 会话被删（含"空会话切换即删"） | 它的草稿**一起作废** —— 用户已定：没发出去就该删，草稿不给会话保命 |
| 刷新页面 | ⚠️ 待拍板（见下） |

#### 实现方案（推荐 A）

**A. 输入 = 派生值**（内存版，改动最小、最容易测）

```ts
// app/lib/draft-store/index.ts —— 纯数据层，node 可测
export function setDraft(state: Drafts, id: string, text: string): Drafts;
export function clearDraft(state: Drafts, id: string): Drafts;
export function dropDraft(state: Drafts, id: string): Drafts; // 会话被删
// 取：state[id] ?? ""
```

`useCommandMenu` 里把 `const [input, setInput]` 换成 `drafts` + `sessionId` 派生：

- `handleInputChange(v)` → `setDrafts(setDraft(_, sessionId, v))`
- `submit()` / 命令执行完 → `setDrafts(clearDraft(_, sessionId))`
- 页面删会话时 → `setDrafts(dropDraft(_, id))`

好处：**换会话不用写任何"清空/恢复"的 effect**（现在的 `input` 是单值，才需要在切换点手动清——这正是上一轮我差点加的那一行，改成派生后连那一行都不需要）。

**B. localStorage 持久化**：刷新后草稿还在。代价：要处理序列化、上限、以及"会话已删但键还留着"的孤儿键清理。

#### 已知取舍

1. **推荐先做 A**：一次页面生命周期内切来切去不丢字；刷新丢草稿。等真有人抱怨"刷新丢字"再上 B。
2. **命令文本（`/skill xxx`）算不算草稿**：建议**算**（保持"输入框里的一切"这一个语义），否则会出现"文字留下了、命令前缀没了"的怪状态。
3. **删会话时要不要提示"草稿一起没了"**：建议**不提示**（删会话本身已有确认条，再加一句是噪音）。

#### 验收

1. A 打「你好」不发 → 切 B（框空）→ 切回 A（「你好」还在）；
2. A 打「你好」→ 发送 → 切走再切回 → 框是空的；
3. 新会话里打「abc」→ 切走（空会话被删）→ 侧栏没有这条、`drafts` 里也没有它的键（内存版：随组件卸载一起没了）；
4. 若抽成纯函数 `draft-store`：补单测（set / clear / drop / 取空）4 条。

#### 依赖与顺序

- 建议排在 **C57-P1（转录稿）之后**、C58 之前 —— 它改的是 `useCommandMenu`，与转录稿重构不冲突；
- 与 **C56** 的关系：C56 那三条"离开当前会话"的入口（切会话 / 新建会话 / 新增工作空间）将来只调 `setCurrentId`，草稿自然按会话分开 —— **C59 落地后，那三处不需要再手动清输入框**。

## 五、验收

### 5.1 单测（新增的都是纯函数，node 环境）

| 文件 | 用例 |
|---|---|
| `app/lib/transcript/index.test.ts` | ① 用户消息切回合 ② 注入件独立成段 ③ toolCall 与 toolResult 配对成一个块 ④ 孤儿 toolResult 不丢 ⑤ 空助手（只有 toolCall）不出空 narration ⑥ `stopReason=error` 补错误块 ⑦ `observed` 为空时 `durationMs === undefined` ⑧ 运行中的回合 `running === true` |
| `app/lib/transcript/index.test.ts` | 参数摘要：bash 取 `command`、文件工具取 `path`、JSON 回退并截 80 字（3 条） |
| `app/lib/transcript/index.test.ts` | `reasoningSummary`：首行 / 流式取最近段落首行 / 去 `**` / 空文本返回 `""`（4 条） |
| `lib/message/index.test.ts` | **`messageText` 跳过 reasoning 块**（P2；1 条，钉住"思考不进摘要/预览"） |

> 夹具规则（`AGENTS.md` 11.5 ②）：消息夹具由**真实装配器**产出（`createUserMessage` / 现有 `lib/testing` 的 fake-model 产物），不手拼"看起来像"的对象。

### 5.2 静态检查

`tsc --noEmit` = 0；`eslint lib app` = 0；`prettier --check` 改到的文件。

### 5.3 视觉与真机（必须自己看）

1. 同一条会话（含 ≥1 次工具调用）**改造前 / 改造后**各一张截图：版面宽、行距、有无发言栏；
2. **流程行**：折叠态量出来是 24px；点开看输出；失败的那次工具调用默认展开、状态点红；
3. **回合尾**：显示「用时」与步数；点击后流程行全部收起、正文不受影响；
4. **思考行（P2）**：跑一条会思考的提问（例如「9.11 和 9.9 哪个大？先想清楚再答」）→ 一条 24px「思考」行出现、摘要是一行、点开是完整思考；
5. **窄窗口**（900px）：版面不横向溢出、气泡不撑破（这个坑踩过：侧栏 `minmax(0,1fr)`）；
6. **刷新后**：历史回合结构正确、没有"用时"、思考行是否还在（取决于第六节第 3 个决定）。

### 5.4 出口判据

- 三项 0（tsc / eslint / prettier）；
- 5.3 六条全过（截图留档）；
- 全量单测绿（当前基线 **818 / 60 文件**，本项预计 +15 左右）；
- **P1 / P2 的阶段：`git diff --name-only` 不含 `lib/agent/index.ts`**；P3 单独走红线流程。

---

## 六、⚠️ 缺什么才能开工（需要你拍板）

1. **间距是否照抄 4 / 12 / 16**？（建议：是。这三个数是 DSH 的，但也是"流程行 / 回答 / 回合"三种关系的自然刻度，且我们今天的 26px 明显偏松）
2. **是否接受删掉 `message-row` 这套"发言栏"**？（建议：接受。身份靠位置；时间只留回合尾与侧栏）
3. **思考要不要落进会话文件**？
   - A. **落**（刷新后还在，与 DSH 一致；代价：会话 JSONL 变大、导出/复盘时思考会一起出现）；
   - B. **不落**（只活在本轮内存与轨迹里；刷新后消失）。
   建议：**A**，但**只落思考文本、不落 signature**，且回传模型时过滤（4.8 已列）。
4. **P3（实时思考）现在做还是等 P1/P2 落地后单独做**？（建议：等。它要动红线文件，值得单独一轮评审）
5. **输入台的发送按钮改成 34px 圆形图标按钮**（抄 DSH）还是保留文字「发送」？（建议：圆形 + `aria-label`，与 DSH 同构；文字按钮在没有图标体系时更稳，但我们已经有图标先例——审批卡的 Y/N 徽标）
