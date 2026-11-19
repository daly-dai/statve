// ============================================================
// 模型接口 —— Agent 的"大脑"
// 对应 teaching-agent/src/server/agent/model.ts
// ============================================================

import type { AgentMessage, AssistantMessage, ToolDefinition } from "./types";

export type CompleteInput = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  /** 逐段文本增量回调：流式模型每吐一段文本就调一次；非流式模型可忽略 */
  onDelta?: (delta: string) => void;
  /**
   * 逐段**思考**增量回调（DeepSeek 的 `reasoning_content`，2026-11-19，C58）。
   *
   * 为什么与文本分成两个回调，而不是 `onDelta(kind, delta)`：
   * DeepSeek 的流里思考就是另一个字段，两条通道本来就分开；合成一个回调会让所有
   * 现有消费者（引擎 / 前端 / 轨迹）都去判 kind，漏一处就把思考当正文渲染。
   *
   * `contentIndex` = 这段增量落在 `content` 的第几块。现在恒为 0（一条消息最多一段
   * 思考，思考永远在最前）；等 C66（块级协议）统一之后才可能出现交错。
   */
  onReasoningDelta?: (delta: string, contentIndex: number) => void;
};

export interface TeachingModel {
  complete(input: CompleteInput): Promise<AssistantMessage>;
}
