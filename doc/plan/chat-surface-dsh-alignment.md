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

### 4.13 定案补记（2026-11-17，看完原型后拍板）

**原型**：`workspace/prototype-right-pane-v5.html`（A 同一回合两种排法 / B 四种状态 / C 空态三版 / D 工具行展开）

**两家的一手依据**（判据，不是印象）：

| | DSH | pi-web |
|---|---|---|
| 回合边界 | 有 turn 概念（status open/closed + end reason） | `isMessageGroupAnchor`：**用户消息**、`compaction`、子代理通知 |
| 过程怎么收 | 过程组 + 头部**类别摘要**（read/search/write/commands/context…） | 「Process details」折叠块 + **N 条 · N 次工具 · 用时** |
| 折叠判据 | live / aborted / error ⇒ 不可折叠；已结束 ⇒ 可折 | `defaultExpanded = !answered`（**有最终回答就折**） |
| 最终回答 | `answerAnchorSeq` + `messageCount`（回答之前的消息数） | `splitFinalAssistantBlocks`：**最后一个非文本块之后**的文本 |
| 组体限高 | `max-height: min(400px, 50vh)` + 内部滚动 | 每张工具卡逐个折叠（记住展开过的） |
| 空态 | `EmptyHero`：居中品牌标记 + 一句话；**输入框不许重挂** | fresh composer（会位移）+ `NewSessionContextBar` |

**拍板**：

| 问题 | 结论 |
|---|---|
| 顶层单位 | **回合**：`[用户气泡] → [过程组] → [最终回答] → [回合尾]` |
| 回合边界 | **用户消息** 或 **`compactionSummary`** 开新回合；`source.kind === "skill-invocation"` 的 user 消息**不开**新回合（它是宿主注入的，算过程里的一条 note） |
| 过程怎么给 | 一个可折叠组：头一行 = **类别摘要 + 用时 + 步数**；组体里每个工具**一行 24px** |
| 折叠判据 | **有最终回答 ⇒ 折；进行中 / 被打断 / 失败 / 只有工具没回答 ⇒ 展开** |
| 最终回答 | 取回合内**最后一条助手消息**，**最后一个非文本块之后**的全部文本；中途叙述算过程（组内按正文字号渲染，不压 24px 行） |
| 工具行展开 | 用户定 **1+3**：行上「工具名 + 参数摘要」；点开 = 摘要键值对 + **「原始 JSON」**（可展开）+ 出参（**220px 限高滚动**）+ 复制全文 |
| 空态 | **居中**：品牌 + 输入框；工作空间名字放在**输入框卡片内部、顶部左侧**（纯文本 —— 位置占住，先不做切换） |

**实测数字**（在 `localhost:3000` 上量 `jj4l4l` 这一条会话，17 行）：

| 现在 | 高度 |
|---|---|
| 用户行 | 53px |
| CALL 行 ×9 | 408px |
| **结果卡 ×9** | **1763px**（173px/张；`web_fetch` 那张 379） |
| 正文 | 2811px |
| **合计** | **5035px**（其中过程 2171px = 43%） |

提案：过程 ≈ **250px**（头 33 + 9×24）⇒ **过程 −88%**，整段 ≈ 3114px（**−38%**）。
**注意**：过程里 81% 是"结果卡默认展开"，所以就算不做回合分组，**只把结果卡收起来**也能拿到大部分收益；回合分组是把这些收口成"一件东西"的框架。

**新增令牌**：`--surface-bubble`（≈ 墨 6%）—— 用户气泡是**面**，不许借 `--feed-*`（那是反馈/选中，见 `session-sidebar-ux.md` 的读前须知第 ② 条）。

**三条硬约束**：

1. **输入框不能重挂**：空态 ↔ 会话态切换时，`wsRow` 必须是卡片内的**同级行 + 条件渲染**，不许换组件（否则 textarea 失焦、丢字）。
2. **过程组体限高** `min(400px, 50vh)` + 内部滚动；单条出参 220px 限高。
3. 折叠/展开**只住组件 state**，不落盘。

### 4.14 定案补记（2026-11-18，看完两张原型后拍板）

**原型**：`workspace/prototype-actions-v6.html`（A 回答底部动作行 / B 输入台工具栏 / C 命中区 / D 实测 / 间距滑杆）

**范围一句话**：把「对已生成内容做的事」和「决定这一轮怎么跑的事」分开 —— 前者是**动作行**（悬停才现、右对齐、22px），后者是**工具栏**（常驻、34px 级）；顺带把过程组头改成「无下划线 + 行首箭头」，并修掉「跑完不自动收起」。

#### 一、原件一览：继承 / 改动（§11.8 要求逐条标注）

| 元素 | 继承（原型的什么） | 改动（原型哪里不够，为什么） |
|---|---|---|
| 动作行的尺寸与出现方式 | pi-web `components/MessageView.tsx:512-553`：22px 高 / 11px 字 / `gap 4` / 右对齐 / `hover` 才现 / ✓ + 1.5s 复位 | ① 只放「复制」一个（重试见 `PLAN.md` 的 C62）② **不跟时间戳** —— 我们的 assistant 时间戳是发送时刻，4.13 已判不可靠 |
| 动作行命中区 | 项目既有 `--hit: 34px`（B3） | pi-web 是 22px 无扩边（纯鼠标界面）；我们守命中下限的方式是 `::before` 外扩 5px → **视觉 22 / 命中 32** |
| 过程组头 | 4.13 定的「33px 头 + 类别摘要 + N 步」（已实现） | ① 去掉下划线 ② 箭头从行尾挪到**行首**并改成会旋转的 SVG ③ 字号 13 → 12、墨色 → `--ink-faint`。**判据：线是「分隔」，箭头是「能展开」——一件事只用一个信号** |
| 审批档位 | 三档语义与说明文案（`approval-mode-switch` 的 `MODES`）原样搬 | 三个常驻 chip（实测 **211 × 34**）→ **一个下拉**（`审批 建议 ▾`）；理由：它一年改不了几次，却和每句话并列。对照 pi 的 `/settings`、DSH 的 `/permission` 都不让它常驻 |
| 卡片形态 / 发送圆 | `--col` 列宽、`--line-strong` 边、`--r-lg`、34px 圆钮、停止变红 | 只改三个内间距（见四） |
| 上下文圆环 | 28px 命中区（抄 DSH 时写死的） | **不改**（见下面的勘误） |

#### 二、勘误（我上一轮说错的两个数，以这里为准）

| 我说过 | 真相 | 来源 |
|---|---|---|
| 「圆环命中区只有 14px」 | **28 × 28**。14 是那颗 SVG 的**直径**，它装在一个 28px 的按钮里 | 真机量 `localhost:3000`：`button[aria-label*="上下文"]` = 28 × 28；`context-meter.module.css:24` 的注释也写着「28px 圆形命中区（DSH 同款）」 |
| 「三档 chip 占 ≈96px」 | **211px**（三个 chip 分别 54 / 57 / 54，含 label 与 6px 间距） | 真机量 `localhost:3000` |

⇒ **圆环不动**：28 是抄 DSH 时有据的选择，而把它抬到 34 只会让右边那簇（28 + 8 + 34 = 70）变成 76，没有证据表明需要。**这一条从本轮范围里划掉**。

#### 三、动作行（C61）的详细设计

| 项 | 定案 |
|---|---|
| 位置 | 每个 `turn` 内、`.answer` 之后（`app/components/transcript/index.tsx`） |
| 出现条件 | `turn.answer !== ""` —— 没有回答就不摆一个复制空串的按钮 |
| 常驻条件 | `turn.status !== "ok"`（被打断 / 失败但有半截回答）⇒ 常驻。理由：那时人更可能要把已有内容拿走 |
| 平时 | 悬停整个回合才现（`opacity 0 → 1`，`0.12s`） |
| 尺寸 | 高 22、`padding 3px 8px`、字号 11、图标 11、`gap 5`、圆角 5 |
| 命中 | `::before { inset: -5px }` ⇒ 32 × 32 |
| 复制什么 | `turn.answer`（**markdown 原文**，不是渲染后的文字） |
| 反馈 | 成功 → ✓ + 「已复制」，1500ms 复位；失败静默（同工具行「复制全文」的先例） |
| 颜色 | `--ink-faint` → 悬停 `--ink`；**不用 `--pen-*`**（那是通道色，每支只代表一类事件） |

#### 四、输入台与过程组头（C57 尾巴）

**① 审批下拉**：新目录 `app/components/approval-mode-menu/`（旧 `approval-mode-switch/` 删除，`app/page.tsx` 一处引用）。

| 部件 | 值 |
|---|---|
| 触发器 | `审批 建议 ▾`，高 22、字 12 等宽、`gap 6`、`padding 0 6px`；命中 `::before { inset: -6px }` ⇒ 34 |
| 菜单 | 宽 244，**向上**弹（`bottom: calc(100% + 8px)`，输入台在屏幕底，只能往上），`--plate` 底 + `--line` 边 + 与 `ui/menu` 同款投影 |
| 项 | 名称（12.5）＋ 一句说明（10.5 等宽）＋ 当前项 `✓`；`role="menuitemradio"` + `aria-checked` |
| 交互 | 点开 / 选中后收起并回焦 / 点外面关 / `Esc` 关 |
| **不做** | ~~方向键漫游~~ → **作废（实施时改了做法）**：原计划自己造一个下拉，"不做漫游"是为了省掉那层复杂度；实际动手时改成**复用 `ui/menu` 原语**（§10.6「组件组合 > 发明」+ 本项目「全站只有一个溢出模式」），漫游/Home/End/回到触发器全是原语自带的，等于**白拿到**了。原语因此加了三个可选参数：`placement="up"`（输入台在屏幕底，只能往上开）、`selection="single"`（`menuitemradio` + `aria-checked` + ✓）、`triggerClassName`（换掉 34px「⋯」触发器外观）；`MenuItem` 加了 `description`（第二行，用于把三个黑话翻译成人话）。**默认值都不变**，会话行 ⋯ 那几处菜单行为零影响。 |

**② 三个间距**（真机量过的现状 → 定案）：

| | 现在 | 定案 | 落点 |
|---|---|---|---|
| ① 文字 → 工具栏 | 8 | **8** | `.consoleFrame { gap }` |
| ② 工具栏 → 卡片下沿 | 11 | **4** | `.consoleFrame { padding-bottom }` |
| ③ 卡片下沿 → 读数 | 9 | **6** | `.statusBar { margin-top }` |

卡片总高 88 → **81px**。代价记下：② 取 4 后，键盘 `:focus-visible` 环离卡片边只剩 2px —— 实机上若觉得挤，改 `outline-offset: -3px`（向内画），**不动间距**。

**③ 过程组头**：无下划线；`height: 33px`；`margin: 0 -6px; padding: 0 6px; border-radius: 6px`；悬停 `--feed-hover` + 文字转 `--ink`；行首 12px 的 chevron，`data-open="true"` 时 `rotate(180deg)`；字号 **12**、颜色 **`--ink-faint`**。

**④ 修「跑完不自动收起」（本轮唯一的 bug 修复）**：

```ts
// 旧：初值只在挂载时算一次 —— 这一轮是边跑边长的，挂载时还没回答 ⇒ open=true 再也不变
const [open, setOpen] = useState(!collapsedByDefault);
// 新：用户没表态时听默认值（默认值随回合状态变）
const [manual, setManual] = useState<boolean | null>(null);
const open = manual ?? !collapsedByDefault;
```

判据本身（有回答 + `status === "ok"` + 不在跑）抽成纯函数 `shouldCollapseProcess(turn, live)` 放进 `app/lib/transcript`，可单测。

**⑤ 删底栏快捷键提示**：`.statusHint` 与 `composerHint()` 一起删（对熟练用户是零信息）。

#### 五、token：不新增，改一条注释

候选的中间档 `#84888f`（3.7:1）与现成的 `--ink-faint` `#8b8f96`（3.3:1）**肉眼分不出**，为它多一支 token 是账本污染。所以：

- 过程摘要用 `--ink-faint`；
- `app/globals.css` 里那条注释从「仅用于装饰与禁用态，不承载信息」改成三类并列举清判据：**装饰 / 禁用态 / 用户不需要读的次要读数（过程摘要）**，最后加一句「判据：它不承载任何决策信息，读不到也不影响你决定下一步」。

理由：这句话确实是"信息"，但它是**回执**不是**依据** —— 用户按你的说法「一般不关注这个」。写清楚比多一支 token 值。

#### 六、明确不做（防范围失控）

重试 / 重新生成（C62）· 点赞点踩 · 时间戳 · 附件与模型选择器（C12 / C25）· 方向键漫游 · 圆环命中区改造（勘误已撤）· 消息动作行做成可配置按钮组。

---

### 4.15 补记（2026-11-18 晚）：把「用时」补上 —— 附一条勘误

**背景**：C57 标了已交付，但 4.5 写的「本回合用时 12 秒 · 3 步」与 5.3③ 的验收**没落地**：代码里只有步数。用户 2026-11-18 发现后定「用时补，放在 AI 会话顶部那行文案后面」。

#### 一、勘误：4.5 / 4.11 那条前提是错的

4.5 当时写的是「时间戳没落盘 ⇒ 刷新后只有步数」，4.11 也据此把「历史回合没有用时」当成代价写进了边界。**两处都错**，查证如下：

| 我当时的说法 | 真相 | 出处 |
|---|---|---|
| assistant 的 `timestamp` 是**发送时刻**，不可靠 | 它在**流读完、装配最终消息**那一步写（`Date.now()`），即**这次模型调用结束的时刻** | `lib/deepseekModel/index.ts:386` / `:523`（正常路径）、`:238` / `:557` / `:568`（中止/报错路径） |
| 时间戳没落盘，历史回合算不出来 | **落盘了**：会话 JSONL 每条记录是 `{type:"message", message:{…, timestamp}}` | 实测 `~/.statve/sessions/--E-codeRead-zustand--/s_2026-11-18T02-32-13-944Z_35h8mu/session.jsonl`：23 条消息，**缺 timestamp 的 0 条** |

⇒ **用时可以从消息时间戳直接算，历史回合也有**，不需要 `observed`、不需要新落盘字段。4.11 那条「历史回合没有用时」的代价作废。

⚠️ 一个必须记住的细节：**一轮里有多次模型调用**（每次工具调用停一次），所以要用 **回合内「最早」与「最晚」消息时间戳之差**，不能取某一条 assistant 的。实测那一轮 = **118.8 秒**（02:32:34 问 → 02:34:33 收），而单看最后一次模型调用只有几秒。

#### 二、定案（用户 2026-11-18 拍板）

| 项 | 结论 |
|---|---|
| 跑完的文案 | 接在过程组头那行摘要后面：`读了 4 个文件 · 跑了 2 条命令 · 1 分 59 秒`（**甲**：不加「用时」二字） |
| 过程组头 | **永远渲染**（用户：「这个文案怎么都会有的，咱们还有思考没接进来呢」）⇒ `steps === 0` 时头只剩用时，不再省略整行 |
| 进行中的计时器 | **甲：侧栏会话行**（时间槽换成 `3:16`）+ **丙：过程组头**（`正在执行 bash… · 0:05`）。乙（输入台）、丁（状态条）不做 |
| 超一小时的强调 | **不做**（用户：暂时不用考虑）。格式本身仍能表达：过一小时是 `1:02:15`，不会变成「3720 秒」 |
| 缺时间戳 | **什么都不显示**（不编数字、不摆「—」） |
| 格式 | **只有一个**：`3:16`（mm:ss），过一小时 `1:02:15`。⭐ 用户 2026-11-18 当场否掉了我"两种写法"的方案（跑着 `3:16`、跑完 `1 分 59 秒`）—— 同一个数在一屏里出现两种写法就是乱的。代价：`0:00` 不如「不到 1 秒」有人情味，几百毫秒的回合显示 `0:00` |

#### 三、实现（逐文件）

| 文件 | 改动 |
|---|---|
| `app/lib/transcript/index.ts` | `TranscriptTurn.durationMs?: number`（`durationOf()`：回合内**最早/最晚**消息时间戳之差，用 min/max 防消息顺序不单调）· `formatElapsed()`（**唯一**的时长格式 —— 原先分过「回执 / 钟」两种，被用户否掉后合并成一个函数） |
| `app/lib/use-elapsed.ts` ⭐新 | 一个**共享**的每秒心跳：模块级 `listeners` 集合 + 单个 `setInterval`，订阅者清零时停掉（没在跑时整页零定时器）。订阅时**立刻先给一次当前值**，免得切到已在跑的会话时先显示 1 秒的 `0:00` |
| `app/lib/run-store.ts` | 新增 `runStarted: Record<string, number>`（**不进 runs 桶** —— 桶是"帧折叠、能重放"的，墙钟时间重放不出来，理由同 `reading`）· `startRun` 写入 · `deleteRun` 一起删 · 新增 `useRunStarted` |
| `app/components/session-list/session-row.tsx` | 时间槽：处于 `LIVE_PHASES`（running / waiting-approval / waiting-ask）且拿得到起点就显示 `formatElapsed`，否则显示原来的时间 |
| `app/components/transcript/index.tsx` | 头文案 = 若干读数用 ` · ` 拼，**空段自动不出现**（所以 0 步的头是「12 秒」而不是「 · 12 秒」）；`Transcript` 里用一次 `useElapsed`（hooks 不能进循环），只喂给最后一回合 |
| `app/page.tsx` | 传 `liveSince={runStarted[currentId]}` |

⚠️ **为什么侧栏那三种阶段都算"在跑"**：卡在**等审批**的会话最容易一放半小时 —— 那正是最该被看见的时刻。点仍负责区分状态（转圈 / 黄点），计时器只回答"过去多久了"。

#### 四、验收（真机，2026-11-18 实测）

| # | 判据 | 结果 |
|---|---|---|
| 1 | 跑完的头带用时 | ✅ 实测：`跑了 6 条命令 · 读了 1 个文件 · 4:27`、`跑了 5 条命令 · 5:43` |
| 2 | 0 步的回合也有头 | ✅ `0:07` + `0 步` |
| 3 | **两个位置格式一致** | ✅ 侧栏与过程组头都走 `formatElapsed`：`0:07` / `4:27` / `5:43`（用户 18 日否掉了"两种写法"） |
| 3 | 秒级真实 | ✅ 同一轮侧栏走针 `0:04→0:15`，结束后头显示 `16 秒`（四舍五入对得上） |
| 4 | 侧栏计时器会走、跑完变回时间 | ✅ `0:04 · 0:05 · 0:07 … 0:15` → 结束后 `15:45:32` |
| 5 | 过程组头的钟 | ✅ `正在执行 bash… · 0:04` → `· 0:12`（那次故意让它卡在审批框上，看它一路走） |
| 6 | 缺 timestamp 不显示 | 代码路径（`durationMs === undefined` ⇒ 空串）；**没有夹具** —— 真实数据里没有这种消息（23/23 都有），按夹具规则不造 |
| 7 | 侧栏在 waiting-approval 下走针 | 机制与 #4 同一个 hook，条件多两个枚举值；**没现场单独跑**（要等 60 秒审批超时），留给用户顺手看 |

静态：`tsc` 0 · `eslint` 0 · `prettier --check` 0 · 单测 **875 / 62 文件**（本项 +5）。

**一条被工具拦下的教训**：`useElapsed` 第一版写的是渲染期 `return Date.now() - startedAt`，被 `react-hooks/purity` 拦下（"Cannot call impure function during render"）；改成 state + tick 之后又撞 `react-hooks/set-state-in-effect`（不许在 effect 里直接 setState），最后把"订阅时先给一次值"挪进 `subscribe()`。**两轮都是机器拦我，不是我自己想起来的。**

---

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

### 5.5 动作行 / 审批下拉 / 过程组头（4.14 这一批）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 跑完的回合**自动收起**（不点、不刷新） | 发一句 → 跑完 → 过程组自己折成一行；点行首箭头能开能收；刷新后仍折叠 |
| 2 | 动作行的出现条件 | 有回答：悬停出现；被打断但有回答：常驻；失败且无回答：**没有**动作行 |
| 3 | 复制的是 **markdown 原文** | 复制后粘到编辑器：`##` / `**` 还在，不是渲染后的纯文本 |
| 4 | 反馈 | 点「复制」→ ✓ + 「已复制」，1.5s 复位 |
| 5 | 下拉 | 点「建议 ▾」→ 三档菜单（各带一句说明、当前项 ✓）；选 YOLO → 触发器显示 YOLO 且下一轮 `bash` 不再弹框；点外面 / `Esc` 关 |
| 6 | 命中区 | DevTools 量：动作行按钮 `::before` = **32 × 32**；下拉触发器 = **34** 高 |
| 7 | 间距 | `.consoleFrame` = `padding-bottom 4px` / `gap 8px`；`.statusBar` = `margin-top 6px`；卡片高 **81** |
| 8 | 过程组头 | 无下划线；行首 chevron；12px；`--ink-faint`；悬停有淡底且文字转深 |

**单测（一条纯函数，钉住"什么时候折"）**：`shouldCollapseProcess(turn, live)` —— ① 有回答 + `ok` + 不在跑 → `true` ② 正在跑 → `false` ③ 无回答 → `false` ④ `status = "error"` → `false`。

### 5.6 用时（4.15 这一批）

| # | 判据 | 结果 |
|---|---|---|
| 1 | 跑完的回合头里带时长（`· 16 秒`） | ✅ 真机两条 |
| 2 | `0 步` 的回合也渲染头，且只剩时长 | ✅ `不到 1 秒` + `0 步` |
| 3 | 侧栏在跑时时间槽变成 `3:16` 并每秒走，跑完变回时间 | ✅ `0:04…0:15` → `15:45:32` |
| 4 | 过程组头在跑时是 `正在执行 … · 0:05` 并每秒走 | ✅ `0:04…0:12`（卡在审批框上看的） |
| 5 | 缺时间戳就整段不显示 | 代码路径；无夹具（真实数据 23/23 都有） |
| 6 | 纯函数覆盖 | `durationOf` 3 条（整轮 / 单条 / 两回合不串）+ `formatElapsed` 6 个边界（含 `0:00` / 过小时） |

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
