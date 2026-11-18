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
  | { kind: "note"; note: "compaction" | "skill"; label: string; text: string };

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
  block: TextContent | ToolCallContent;
  blockIndex: number;
  /** 回答从这个块下标开始（Infinity = 这条消息不产出回答） */
  answerStart: number;
  results: ReadonlyMap<string, { status: "ok" | "error"; result: string }>;
}): void {
  const { turn, block, blockIndex, answerStart, results } = input;
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
