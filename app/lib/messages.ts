// ============================================================
// 消息操作 —— 转录稿状态更新的两个纯函数
// ============================================================

import type { AgentMessage } from "@/lib/types";

/** 流式增量：把 delta 追加到末尾 assistant 消息的最后一个文本块 */
export function appendDelta(
  messages: AgentMessage[],
  delta: string,
): AgentMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (!last || last.role !== "assistant") return next;

  const content = [...last.content];
  const lastBlock = content[content.length - 1];
  if (lastBlock && lastBlock.type === "text") {
    content[content.length - 1] = {
      ...lastBlock,
      text: lastBlock.text + delta,
    };
  } else {
    content.push({ type: "text", text: delta });
  }

  next[next.length - 1] = { ...last, content };
  return next;
}

/** message_end 时：把末尾消息整体替换成最终版（含工具调用块） */
export function replaceLast(
  messages: AgentMessage[],
  message: AgentMessage,
): AgentMessage[] {
  if (messages.length === 0) return messages;
  const next = [...messages];
  next[next.length - 1] = message;
  return next;
}

/**
 * 思考增量（C58 P3）：追加到末尾 assistant 消息的思考块。
 *
 * 两个要点：
 *   ① **已有思考块就往后加**（一条消息只有一段思考，index 恒 0）；
 *   ② **没有就插在 `contentIndex` 那个位置** —— 引擎先发的是占位消息
 *      `[text("")]`，思考必须排在它**前面**（先想后答是事实顺序），
 *      直接 push 到末尾会得到 `[text, reasoning]` 这种倒序。
 */
export function appendReasoningDelta(
  messages: AgentMessage[],
  contentIndex: number,
  delta: string,
): AgentMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (!last || last.role !== "assistant") return next;

  const content = [...last.content];
  const existing = content.findIndex((block) => block.type === "reasoning");

  if (existing >= 0) {
    const block = content[existing];
    // findIndex 不保类型，这里显式收窄一次
    if (block.type !== "reasoning") return next;
    content[existing] = { type: "reasoning", text: block.text + delta };
  } else {
    // 位置夹在 [0, content.length] 之间：越界就贴边，不造空洞
    const at = Math.max(0, Math.min(contentIndex, content.length));
    content.splice(at, 0, { type: "reasoning", text: delta });
  }

  next[next.length - 1] = { ...last, content };
  return next;
}
