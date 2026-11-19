// ============================================================
// transcript —— 把消息列表折成「回合」（C57 P1，纯函数，node 可测）
// ============================================================
// 为什么需要它：一次对话在磁盘上是**一堆消息**（你那条 zustand 会话：1 个回合
// = 16 条记录 = 7 条助手消息 + 9 次工具 + 9 条结果 + 1 段正文）。界面要的是
// "一次对话"，所以先把这堆东西折成回合，再让组件照着回合渲染。
//
// 回合的定义（用户 2026-11-17 拍板，依据两家参考项目）：
//   - **用户消息**开新回合（pi-web `isMessageGroupAnchor`）
//   - **compactionSummary** 也开新回合（上下文断了一次）
//   - `source.kind === "skill-invocation"` 的 user 消息**不开**新回合 —— 它是
//     宿主按 `/名字` 注入的技能正文，算过程里的一条 note（见 lib/types.ts 注释）
//
// 「最终回答」的切法（pi-web `splitFinalAssistantBlocks`）：
//   回合内**最后一条助手消息**里，**最后一个非文本块之后**的文本才是回答。
//   前面所有助手文本（含中途叙述）都算过程。
//
// ⚠️ 这里**不判断**"是不是最后一个回合 / 还在不在跑" —— 那是 UI 状态，从数据里
// 推不出来。组件自己拿 run 状态叠加上去。
// ============================================================

import type {
  AgentMessage,
  AssistantMessage,
  ReasoningContent,
  TextContent,
  ToolCallContent,
} from "@/lib/types";

/** 工具按"干什么"分类：一个回合的头部摘要按这个聚合（DSH 的 ProcessActivity 思路） */
export type ToolCategory =
  | "read"
  | "search"
  | "write"
  | "command"
  | "fetch"
  | "ask"
  | "plan"
  | "skill"
  | "other";

/** 类别在摘要里的固定顺序（读/搜/写/命令/取/问/计划/技能/其他） */
export const CATEGORY_ORDER: readonly ToolCategory[] = [
  "read",
  "search",
  "write",
  "command",
  "fetch",
  "ask",
  "plan",
  "skill",
  "other",
];

/** 工具名 → 类别。工具集是固定的（lib/tools/*），没见过的名字落到 other，不猜 */
export function toolCategoryOf(name: string): ToolCategory {
  switch (name) {
    case "read_file":
    case "list_files":
    case "find":
      return "read";
    case "grep":
    case "web_search":
      return "search";
    case "write_file":
    case "edit_file":
    case "delete_file":
    case "write_note":
      return "write";
    case "bash":
      return "command";
    case "web_fetch":
      return "fetch";
    case "ask_user_question":
      return "ask";
    case "todo_write":
      return "plan";
    case "skill":
      return "skill";
    default:
      return "other";
  }
}

export type ProcessStep =
  | {
      kind: "tool";
      /** 工具调用 id（展开状态、React key 都用它） */
      id: string;
      name: string;
      category: ToolCategory;
      args: Record<string, unknown>;
      /** pending = 还没结果（正在跑，或被打断） */
      status: "ok" | "error" | "pending";
      result: string;
    }
  /** 中途叙述：组内按正文字号渲染，不压成 24px 行（罕见，但不能丢） */
  | { kind: "text"; text: string }
  /** 非对话记录：上下文压缩 / 技能注入。一行，点开看细节 */
  | {
      kind: "note";
      note: "compaction" | "skill";
      label: string;
      name?: string;
      text: string;
    };

export type TranscriptTurn = {
  index: number;
  /** 用户那句话（compaction 开头的回合为空串） */
  prompt: string;
  /** 回合开始时间（用户消息 / compaction 的时间戳） */
  at: number;
  steps: ProcessStep[];
  /** 最终回答（markdown 原文；空串 = 这个回合没有回答） */
  answer: string;
  /** 回合结局，取回合内最后一条助手消息的 stopReason */
  status: "ok" | "error" | "aborted";
  /**
   * 这一轮花了多久（墙钟，含工具等待）= 回合内**最早**与**最晚**消息时间戳之差。
   *
   * 为什么用消息时间戳、而不是 `observed` 里的 turn_start/turn_end：
   * ① 消息时间戳是**落盘**的（`message.timestamp`），所以历史回合也算得出来 —— 刷新后不丢；
   * ② assistant 的 timestamp 是在**流读完、装配最终消息**时写的（`lib/deepseekModel`），
   *    所以"最后一条消息的时间戳"≈ 这一轮结束的时刻。⚠️ 一轮里有**多次**模型调用
   *    （每次工具调用一停），所以必须取**回合内**的最早/最晚，不能取某一条 assistant 的。
   *
   * `undefined` = 缺时间戳（老数据 / 一条都没有）⇒ 界面上什么都不显示，**不编数字**。
   */
  durationMs?: number;
};

function textOf(message: AgentMessage): string {
  if (message.role === "compactionSummary") return message.summary;
  let joined = "";
  for (const block of message.content) {
    if (block.type !== "text") continue;
    joined += block.text;
  }
  return joined;
}

function isSkillInjection(message: AgentMessage): boolean {
  return message.role === "user" && message.source?.kind === "skill-invocation";
}

/** 回合内最后一条助手消息里，「回答」从第几个块开始（= 最后一个非文本块的下一个） */
function answerStartOf(message: AssistantMessage): number {
  let start = -1;
  message.content.forEach((block, i) => {
    if (block.type !== "text") start = i;
  });
  return start + 1;
}

/** 一个回合的原始材料：从开头的用户消息/压缩记录，到下一条用户消息之前 */
type TurnSlice = {
  prompt: string;
  at: number;
  messages: AgentMessage[];
};

function sliceTurns(messages: readonly AgentMessage[]): TurnSlice[] {
  const slices: TurnSlice[] = [];
  let current: TurnSlice | undefined;

  for (const message of messages) {
    // 回合起点：用户消息（技能注入不算）或压缩记录
    const startsTurn =
      message.role === "compactionSummary" ||
      (message.role === "user" && !isSkillInjection(message));
    if (startsTurn) {
      current = {
        prompt: message.role === "user" ? textOf(message) : "",
        at: message.timestamp,
        messages: [message],
      };
      slices.push(current);
      continue;
    }
    // 其余消息（助手 / 工具结果 / 技能注入）都归当前回合；还没有回合就先开一个
    if (current === undefined) {
      current = { prompt: "", at: message.timestamp, messages: [] };
      slices.push(current);
    }
    current.messages.push(message);
  }

  return slices;
}

/**
 * 一个回合的墙钟时长：取回合内**最早**与**最晚**的消息时间戳之差。
 * 用 min/max 而不是"首条/末条"，是因为不同来源的消息（用户 / 助手 / 工具结果）
 * 时间戳不保证严格单调；取极值就不会被顺序问题咬到。
 * 少于一条带时间戳的消息 ⇒ undefined（不编数字）。
 */
function durationOf(messages: readonly AgentMessage[]): number | undefined {
  let earliest: number | undefined;
  let latest: number | undefined;
  for (const message of messages) {
    const ts = message.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    earliest = earliest === undefined ? ts : Math.min(earliest, ts);
    latest = latest === undefined ? ts : Math.max(latest, ts);
  }
  if (earliest === undefined || latest === undefined) return undefined;
  return latest - earliest;
}

/** 助手消息的收尾原因 → 回合结局（别写成嵌套三元，读的人要数冒号） */
function statusOf(
  stopReason: AssistantMessage["stopReason"],
): TranscriptTurn["status"] {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  return "ok";
}

/**
 * 把消息列表折成回合。纯函数：只读输入，不改它，也不依赖时间/环境。
 */
export function buildTranscript(
  messages: readonly AgentMessage[],
): TranscriptTurn[] {
  return sliceTurns(messages).map(foldTurn);
}

/** 一条助手消息里的一个块：正文进回答或过程，工具调用进过程 */
function pushBlock(input: {
  turn: TranscriptTurn;
  block: TextContent | ToolCallContent | ReasoningContent;
  blockIndex: number;
  /** 回答从这个块下标开始（Infinity = 这条消息不产出回答） */
  answerStart: number;
  results: ReadonlyMap<string, { status: "ok" | "error"; result: string }>;
}): void {
  const { turn, block, blockIndex, answerStart, results } = input;
  // 思考块（C58 P1）：数据层已经落盘、也在 answerStart 的判定里算"非文本块"，
  // 但**渲染**归 P2（要新增一种 step + 组件）。这一期先不收进 steps。
  if (block.type === "reasoning") return;
  if (block.type === "text") {
    const text = block.text.trim();
    if (text === "") return;
    if (blockIndex >= answerStart) {
      turn.answer = turn.answer === "" ? text : `${turn.answer}\n\n${text}`;
      return;
    }
    turn.steps.push({ kind: "text", text });
    return;
  }
  // ⚠️ 显式认 toolCall，**不要**写成"不是 text 就当工具调用"。
  // 2026-11-19 的真事：旧版就是这么兜底的，于是新加的 reasoning 块被当成工具步
  // （`name: undefined, args: undefined`），一路崩在组件里的 `Object.keys(undefined)` ——
  // 现场离原因隔了两层。不认识的块宁可**不渲染**，也别硬塞进一个已知形状。
  if (block.type !== "toolCall") return;
  const result = results.get(block.id);
  turn.steps.push({
    kind: "tool",
    id: block.id,
    name: block.name,
    category: toolCategoryOf(block.name),
    args: block.arguments,
    status: result?.status ?? "pending",
    result: result?.result ?? "",
  });
}

/** 一个回合的折叠：工具结果先按 id 归位，再按顺序走一遍消息 */
function foldTurn(slice: TurnSlice, index: number): TranscriptTurn {
  const turn: TranscriptTurn = {
    index,
    prompt: slice.prompt,
    at: slice.at,
    steps: [],
    answer: "",
    status: "ok",
    durationMs: durationOf(slice.messages),
  };

  // 工具结果按 toolCallId 归位（结果总是跟在调用之后）
  const results = new Map<string, { status: "ok" | "error"; result: string }>();
  for (const message of slice.messages) {
    if (message.role !== "toolResult") continue;
    results.set(message.toolCallId, {
      status: message.isError ? "error" : "ok",
      result: textOf(message),
    });
  }

  // 最后一条助手消息：只有它「最后一个非文本块之后」的文本算回答
  const assistantIndexes = slice.messages
    .map((message, i) => (message.role === "assistant" ? i : -1))
    .filter((i) => i >= 0);
  const lastAssistant = assistantIndexes[assistantIndexes.length - 1];

  slice.messages.forEach((message, messageIndex) => {
    if (message.role === "compactionSummary") {
      turn.steps.push({
        kind: "note",
        note: "compaction",
        label: "上下文已压缩",
        text: message.summary,
      });
      return;
    }
    if (message.role === "user") {
      if (!isSkillInjection(message)) return; // 用户那句话已经进了 prompt
      turn.steps.push({
        kind: "note",
        note: "skill",
        label: `已加载技能 ${message.source?.name ?? ""}`.trim(),
        name: message.source?.name,
        text: textOf(message),
      });
      return;
    }
    if (message.role === "toolResult") return; // 已并进对应的工具步

    turn.status = statusOf(message.stopReason);

    const answerStart =
      messageIndex === lastAssistant ? answerStartOf(message) : Infinity;

    message.content.forEach((block, blockIndex) => {
      pushBlock({ turn, block, blockIndex, answerStart, results });
    });
  });

  return turn;
}

/** 类别计数（组件拿它拼"读了 4 个文件 · 跑了 3 条命令"） */
export function countByCategory(
  steps: readonly ProcessStep[],
): Array<{ category: ToolCategory; count: number }> {
  const counts = new Map<ToolCategory, number>();
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    counts.set(step.category, (counts.get(step.category) ?? 0) + 1);
  }
  return CATEGORY_ORDER.filter((category) => counts.has(category)).map(
    (category) => ({
      category,
      count: counts.get(category) ?? 0,
    }),
  );
}

/**
 * 时长**唯一**的写法（用户 2026-11-18 定的第二版：**统一成中文分秒**）。
 *
 * | 区间 | 写法 |
 * |---|---|
 * | < 1 秒 | `不到 1 秒` |
 * | 1–59 秒 | `16 秒` |
 * | 60–3599 秒 | `1 分 59 秒`（整分写 `2 分`，不写「2 分 0 秒」） |
 * | ≥ 1 小时 | `1 小时 2 分` |
 *
 * 演进史（别再走回头路）：
 * ① 我先写了两种 —— 跑着 `3:16`、跑完 `1 分 59 秒`，理由是"一个是钟、一个是回执"；
 *    用户否了：一屏里两种写法就是乱的。
 * ② 我统一到 mm:ss（理由是侧栏那槽定宽、等宽数字不抖、一个函数一处定义）；
 *    用户又否了：**不好看，统一成分秒**。
 * ⇒ 现在只有一个函数、一种写法，中文分秒。代价（如实记下）：侧栏那槽是定宽的，
 *   `1 小时 2 分` 比 `15:45:32` 略宽；而且计时每秒在变，`9 秒 → 10 秒` 会多一个字符、
 *   标题会跟着挪一下。这是"可读性 > 稳定性"的取舍，用户选的。
 *
 * 取整用 **floor**（不是四舍五入）：这是个秒表读数，`118.8 秒` 就是 `1 分 58 秒`，
 * 不该提前跳成 `1 分 59 秒`；跑到最后那一秒也不会出现"比实际多一秒"。
 */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 1000) return "不到 1 秒";

  const total = Math.floor(safe / 1000);
  if (total < 60) return `${total} 秒`;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`;
  }
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}
