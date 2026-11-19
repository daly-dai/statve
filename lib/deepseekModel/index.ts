// ============================================================
// DeepSeekModel —— 真实模型适配器（provider 差异关在这里）
// ============================================================
//
// 实现 TeachingModel 接口，用 fetch 调 DeepSeek 的 OpenAI 兼容接口：
//   https://api.deepseek.com/chat/completions
//
// 关键原则（对应 pi 的 pi-ai 层思想）：
//   provider 的字段只在"本文件"里出现；runAgentLoop 永远只看统一的
//   AssistantMessage / ToolCallContent。换模型、换供应商，只改这里。
//
// 两条转换边界：
//   进模型前：AgentMessage[]        → OpenAI messages
//   出模型后：OpenAI response       → AssistantMessage
//
// 两种模式：
//   - 非流式（input.onDelta 为空）：一次请求拿完整响应
//   - 真·流式（input.onDelta 提供）：stream:true，逐 token 读 SSE，
//     文本 delta 立刻回调 onDelta，工具调用参数按 index 累积，
//     finish 后统一 parse。
//
// 错误策略（两条路径共用）：
//   网络错误 / HTTP 错误 / 用户中止都不抛异常，统一在
//   postChatCompletion 里转成受控的 AssistantMessage（stopReason
//   为 error / aborted），调用方（runAgentLoop）不需要 try-catch。
// ============================================================

import type {
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
  ToolDefinition,
  Usage,
} from "../types";
import type { CompleteInput, TeachingModel } from "../model";
import { messageText, text } from "../message";
import { config } from "../config";

// 模型/地址/调试开关全部来自 lib/config.ts（唯一配置入口）：
// DEFAULT 只是"config 兜底"，正式使用在 .env.local 用环境变量覆盖
const DEFAULT_BASE_URL = config.provider.baseUrl;
const DEFAULT_MODEL = config.provider.model; // V4 系列（flash / pro），具体 model id 以官方文档为准

// 错误 / 中止 / 流式消息没有真实 token 统计，统一用零值
const EMPTY_USAGE: Usage = { input: 0, output: 0, totalTokens: 0 };
const FALLBACK_TEXT = "（模型未返回内容）";

export type DeepSeekModelOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
};

export class DeepSeekModel implements TeachingModel {
  constructor(private readonly options: DeepSeekModelOptions) {}

  /**
   * 这条消息的「产地」（C58）：端点 + 模型。
   * 唯一用途是决定历史里的思考要不要回传给 API —— 换端点/换模型时不回传。
   */
  private originFor(baseUrl: string): { baseUrl: string; model: string } {
    return { baseUrl, model: this.options.model ?? DEFAULT_MODEL };
  }

  async complete(input: CompleteInput): Promise<AssistantMessage> {
    const baseUrl = (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    const url = `${baseUrl}/chat/completions`;
    const origin = this.originFor(baseUrl);

    // ① 统一协议 → OpenAI 格式
    const messages = toOpenAiMessages(
      input.systemPrompt,
      input.messages,
      origin,
    );
    const tools =
      input.tools.length > 0 ? toOpenAiTools(input.tools) : undefined;

    // 临时调试日志：DEBUG_DEEPSEEK=true 时，打印这次请求的完整 messages + tools
    debugLog({
      model: this.options.model ?? DEFAULT_MODEL,
      url,
      messages,
      tools,
    });

    if (input.onDelta) {
      return this.completeStreaming({ url, input, messages, tools, origin });
    }

    return this.completeNonStreaming({ url, input, messages, tools, origin });
  }

  // ----------------------------------------------------------
  // 两条路径共用的请求入口
  // 网络错误 / HTTP 错误 / 用户中止在这里统一转成受控消息，
  // 流式与非流式不再各写一份错误处理。
  // ----------------------------------------------------------
  private async postChatCompletion(params: {
    url: string;
    input: CompleteInput;
    messages: OpenAiMessage[];
    tools: OpenAiTool[] | undefined;
    stream: boolean;
  }): Promise<ChatResult> {
    const { url, input, messages, tools, stream } = params;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.options.model ?? DEFAULT_MODEL,
          messages,
          ...(tools ? { tools } : {}),
          stream,
          // 流式默认不返回 token 用量；include_usage 让流的最后一个 chunk
          // 带上 usage（OpenAI 兼容约定）。不支持的供应商会忽略它，
          // 前端那边会回退显示 0。
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: input.signal,
      });
    } catch (error) {
      // 网络错误 / 用户中止：不抛异常，转成受控的 AssistantMessage
      if (input.signal?.aborted)
        return { kind: "error", message: abortedMessage() };
      return {
        kind: "error",
        message: errorAssistant(
          "network",
          `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      };
    }

    if (!response.ok) {
      return {
        kind: "error",
        message: errorAssistant("http", await httpErrorText(response)),
      };
    }

    return { kind: "ok", response };
  }

  // ----------------------------------------------------------
  // 非流式：一次请求拿完整响应
  // ----------------------------------------------------------
  private async completeNonStreaming(params: {
    url: string;
    input: CompleteInput;
    messages: OpenAiMessage[];
    tools: OpenAiTool[] | undefined;
    origin: { baseUrl: string; model: string };
  }): Promise<AssistantMessage> {
    const { url, input, messages, tools, origin } = params;
    const result = await this.postChatCompletion({
      url,
      input,
      messages,
      tools,
      stream: false,
    });
    if (result.kind === "error") return result.message;

    const data = (await result.response.json()) as OpenAiResponse;
    return toTeachingAssistantMessage(data, origin);
  }

  // ----------------------------------------------------------
  // 真·流式：逐 token 读 SSE，文本 delta 立即 onDelta 回调
  // ----------------------------------------------------------
  private async completeStreaming(params: {
    url: string;
    input: CompleteInput;
    messages: OpenAiMessage[];
    tools: OpenAiTool[] | undefined;
    origin: { baseUrl: string; model: string };
  }): Promise<AssistantMessage> {
    const { url, input, messages, tools, origin } = params;
    // ② 供应商协议 → 统一协议
    const result = await this.postChatCompletion({
      url,
      input,
      messages,
      tools,
      stream: true,
    });

    if (result.kind === "error") return result.message;

    const response = result.response;

    if (!response.body) {
      return errorAssistant("http", "响应体为空，无法流式读取。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // 累积状态：文本/思考各自累积成串；工具调用按 index 累积（OpenAI 流式
    // 里同一个 tool_call 的 arguments 会分成多个 chunk 到达）
    const acc: StreamAccumulator = {
      textBuffer: "",
      reasoningBuffer: "",
      toolCalls: new Map(),
      onDelta: input.onDelta,
    };

    let buffer = "";

    try {
      while (true) {
        // 读取一个数据块
        const { done, value } = await reader.read();

        if (done) break;

        // 解码数据块
        buffer += decoder.decode(value, { stream: true });

        // SSE 按行解析；一行可能是半截，留到下一轮
        let newline: number;

        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();

          buffer = buffer.slice(newline + 1);

          // 只有 data: 行才是数据帧，其余（event: / id: / 空行）没有内容可吃
          consumeSseChunk(
            line.startsWith("data:")
              ? parseSseData(line.slice(5).trim())
              : null,
            acc,
          );
        }
      }
    } catch (error) {
      // 中止 / 断流：把已累积的思考与文本作为 partial 返回，不崩
      if (input.signal?.aborted) {
        return {
          role: "assistant",
          content: abortedContent(acc),
          stopReason: "aborted",
          usage: EMPTY_USAGE,
          timestamp: Date.now(),
        };
      }
      return errorAssistant(
        "stream",
        `流式读取中断：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return buildStreamMessage({
      textBuffer: acc.textBuffer,
      reasoningBuffer: acc.reasoningBuffer,
      toolCallsAcc: acc.toolCalls,
      finishReason: acc.finishReason,
      usage: acc.usage,
      origin,
    });
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.options.apiKey}`,
    };
  }
}

// ------------------------------------------------------------
// 流式累积：SSE chunk → 累积状态
// ------------------------------------------------------------

/**
 * 流式累积状态。
 *
 * 为什么装进一个可变对象：文本 / 工具调用 / 用量三部分都要跨 chunk 累积。
 * 解析逻辑抽成模块级函数 `consumeSseChunk` 之后，状态得有个明确的载体——
 * 传一个对象比传五个引用清楚，也让"哪个字段被谁改"一眼可见。
 */
type StreamAccumulator = {
  /** 已累积的正文（中止时作为 partial 返回） */
  textBuffer: string;
  /** 已累积的思考（DeepSeek 的 reasoning_content；中止时同样要保留） */
  reasoningBuffer: string;
  /** 工具调用按 index 累积（同一个 tool_call 的 arguments 会分成多个 chunk） */
  toolCalls: Map<number, { id?: string; name?: string; args: string }>;
  /** finish_reason（后到的非空值生效） */
  finishReason?: string;
  /** include_usage 时，流的最后一个 chunk（choices 为空）会带 usage */
  usage?: Usage;
  /** 文本增量回调：这是"真·流式"的核心 */
  onDelta?: (delta: string) => void;
};

/**
 * 流式 chunk 的 delta（文本增量 + 工具调用增量）。
 * 形状从 `OpenAiChunk` 推导——协议改了只改一处，不另抄一份。
 */
type OpenAiDelta = NonNullable<
  NonNullable<OpenAiChunk["choices"]>[number]["delta"]
>;

/** 单个工具调用的增量（同一个 tool_call 的 arguments 会分成多个 chunk） */
type OpenAiToolCallDelta = NonNullable<OpenAiDelta["tool_calls"]>[number];

/**
 * 吃一个 SSE data 载荷：累积文本 / 工具调用 / 用量。
 *
 * 传 `null` 表示这一帧没有内容——`[DONE]` 结束标记，或坏 JSON
 * （断流/网络抖动时常见，忽略即可，别让整个流崩掉）。
 */
function consumeSseChunk(
  chunk: OpenAiChunk | null,
  acc: StreamAccumulator,
): void {
  if (!chunk) return;

  // usage chunk 没有 choices/delta，必须在下面的 delta 早退之前捕获
  if (chunk.usage) {
    acc.usage = toUsage(chunk.usage);
  }

  const choice = chunk.choices?.[0];

  if (choice?.finish_reason) acc.finishReason = choice.finish_reason;

  const delta = choice?.delta;

  if (!delta) return;

  // ⚠️ 顺序有意义：思考先吃，正文后吃。
  // 有的网关（LiteLLM 那类）会把 reasoning 与 content 合进同一个 delta，
  // 而"先想后答"是事实顺序 —— 先处理思考才能保证块序正确
  // （pi 同款处理：`openai-completions.ts:577-579`）。
  appendReasoningDelta(delta, acc);
  appendTextDelta(delta, acc);
  appendToolCallDeltas(delta.tool_calls ?? [], acc);
}

/** 思考增量 → 累积（P1 只存；实时回调在 P3 接） */
function appendReasoningDelta(
  delta: OpenAiDelta,
  acc: StreamAccumulator,
): void {
  const piece = delta.reasoning_content;
  if (typeof piece !== "string" || piece.length === 0) return;
  acc.reasoningBuffer += piece;
}

/** 文本增量 → 立刻推给 onDelta（这是"真·流式"的核心） */
function appendTextDelta(delta: OpenAiDelta, acc: StreamAccumulator): void {
  if (typeof delta.content !== "string" || delta.content.length === 0) return;

  acc.textBuffer += delta.content;
  acc.onDelta?.(delta.content);
}

/** 工具调用增量 → 按 index 累积，finish 后再 parse */
function appendToolCallDeltas(
  toolCalls: OpenAiToolCallDelta[],
  acc: StreamAccumulator,
): void {
  for (const tc of toolCalls) {
    const entry = acc.toolCalls.get(tc.index) ?? { args: "" };

    if (tc.id) entry.id = tc.id;

    if (tc.function?.name) entry.name = tc.function.name;

    if (tc.function?.arguments) entry.args += tc.function.arguments;

    acc.toolCalls.set(tc.index, entry);
  }
}

// ------------------------------------------------------------
// 流式累积 → 最终 AssistantMessage
// ------------------------------------------------------------
function buildStreamMessage(params: {
  textBuffer: string;
  reasoningBuffer: string;
  toolCallsAcc: Map<number, { id?: string; name?: string; args: string }>;
  finishReason: string | undefined;
  usage: Usage | undefined;
  origin: { baseUrl: string; model: string };
}): AssistantMessage {
  const { textBuffer, reasoningBuffer, toolCallsAcc, finishReason, usage } =
    params;
  const content: AssistantMessage["content"] = [];
  // 思考块排在最前：先想后答是事实顺序，前端/回传都依赖它
  pushReasoningBlock(content, reasoningBuffer);
  if (textBuffer.length > 0) {
    content.push(text(textBuffer));
  }

  const toolCalls: ToolCallContent[] = [...toolCallsAcc.entries()]
    .sort((a, b) => a[0] - b[0]) // 按 index 排序，保证工具调用顺序
    .map(([, acc]) => ({
      type: "toolCall" as const,
      id:
        acc.id ??
        `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: acc.name ?? "",
      arguments: safeJsonParse(acc.args || "{}"),
    }));
  content.push(...toolCalls);

  return {
    role: "assistant",
    content: withFallbackText(content),
    stopReason: stopReasonFor(finishReason, toolCalls.length),
    // include_usage 拿到真实用量；供应商不支持时拿不到，回退 0
    usage: usage ?? EMPTY_USAGE,
    timestamp: Date.now(),
    origin: params.origin,
  };
}

/** OpenAI 的 usage 字段 → 统一 Usage（流式最后一个 chunk 携带） */
function toUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): Usage {
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  };
}

// ------------------------------------------------------------
// 进模型前：AgentMessage[] → OpenAI messages
//
// 关键点：ToolResultMessage 必须转成 role:"tool" 且带 tool_call_id，
// 与上面 assistant 的 tool_calls[].id 对齐。丢了 id，模型就不知道
// 这个工具结果对应哪一次调用。
// ------------------------------------------------------------
/**
 * 历史里的思考要不要回传给 API（C58）。
 *
 * 三条规则，都不需要猜：
 *   没有 origin（老数据 / MockModel）  → 不回传（保守：不知道产地就别回放）
 *   origin ≠ 本次请求 (baseUrl, model) → 不回传（换模型了，旧思考不再有效）
 *   origin == 本次请求                 → 回传
 *
 * 为什么必须按产地而不是"一律回传/一律不回传"：
 *   官方文档要求带 tools 的请求回传 `reasoning_content`（否则 400），但我们实测
 *   这个端点宽松。宽松是运气不是契约 —— 换到网关端点后，不回传会**静默**变味
 *   （DSH 那条"网关靠哈希恢复签名"的坑），这类错一个月才发现且无法归因。
 */
function replayableReasoning(
  message: AgentMessage,
  current: { baseUrl: string; model: string },
): string | undefined {
  if (message.role !== "assistant" || message.origin === undefined) {
    return undefined;
  }
  if (message.origin.baseUrl !== current.baseUrl) return undefined;
  if (message.origin.model !== current.model) return undefined;

  const block = message.content.find((b) => b.type === "reasoning");
  return block?.text;
}

function toOpenAiMessages(
  systemPrompt: string,
  messages: AgentMessage[],
  currentOrigin: { baseUrl: string; model: string },
): OpenAiMessage[] {
  const result: OpenAiMessage[] = [{ role: "system", content: systemPrompt }];

  for (const message of messages) {
    if (message.role === "user") {
      result.push({ role: "user", content: messageText(message) });
      continue;
    }

    // compactionSummary → user 指令（B2，2026-08-25）
    // 摘要消息在协议里是独立类型（前端能认出、渲染成卡片），但对模型
    // 它本质是"旧内容已摘要，参考它"的指令——转成 user 消息，模型无感。
    if (message.role === "compactionSummary") {
      result.push({
        role: "user",
        content: `以下是旧上下文摘要。后续回答必须参考它，但最近消息优先级更高。\n\n${message.summary}`,
      });
      continue;
    }

    if (message.role === "assistant") {
      const plainText = messageText(message);

      const toolCalls = message.content.filter(
        (block): block is ToolCallContent => block.type === "toolCall",
      );

      const reasoning = replayableReasoning(message, currentOrigin);

      result.push({
        role: "assistant",
        // OpenAI 要求 content 为 string 或 null；纯工具调用消息给 null
        content: plainText.length > 0 ? plainText : null,
        // 思考只在"同一产地"时回传（见 replayableReasoning）
        ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
        // 工具调用
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  // arguments 在 OpenAI 协议里是 JSON 字符串
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    // toolResult → tool 消息
    result.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: messageText(message),
    });
  }

  return result;
}

// ------------------------------------------------------------
// 工具定义 → OpenAI tools schema（function calling 格式）
// ------------------------------------------------------------
function toOpenAiTools(tools: ToolDefinition[]): OpenAiTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ------------------------------------------------------------
// 出模型后：OpenAI response → AssistantMessage（非流式用）
// ------------------------------------------------------------
function toTeachingAssistantMessage(
  data: OpenAiResponse,
  origin: { baseUrl: string; model: string },
): AssistantMessage {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const finishReason = choice?.finish_reason;

  const toolCalls: ToolCallContent[] = (message?.tool_calls ?? []).map(
    (call) => ({
      type: "toolCall",
      id: call.id,
      name: call.function.name,
      arguments: safeJsonParse(call.function.arguments),
    }),
  );

  const content: AssistantMessage["content"] = [];

  pushReasoningBlock(content, message?.reasoning_content);

  if (message?.content) {
    content.push(text(message.content));
  }

  content.push(...toolCalls);

  const usage: Usage = {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  };

  return {
    role: "assistant",
    content: withFallbackText(content),
    stopReason: stopReasonFor(finishReason, toolCalls.length),
    usage,
    timestamp: Date.now(),
    origin,
  };
}

// ------------------------------------------------------------
// 两条路径共用的零碎逻辑
// ------------------------------------------------------------

/** 模型是否要进入工具循环：finish_reason 或内容里有 tool call 就算 */
function stopReasonFor(
  finishReason: string | undefined,
  toolCallCount: number,
): AssistantMessage["stopReason"] {
  return finishReason === "tool_calls" || toolCallCount > 0
    ? "toolUse"
    : "stop";
}

/** 内容为空时补占位文本，避免发出空消息 */
function withFallbackText(
  content: AssistantMessage["content"],
  fallback: string = FALLBACK_TEXT,
): AssistantMessage["content"] {
  return content.length > 0 ? content : [text(fallback)];
}

/**
 * 把思考文本变成内容块（永远放在最前）。
 * 纯空白的思考不产出块 —— 上游偶尔会发一个只有换行的 `reasoning_content`，
 * 造一个空块会让界面多出一行空气泡（DSH 也是这个判据：`\u00a0` 之类都算空）。
 */
function pushReasoningBlock(
  content: AssistantMessage["content"],
  reasoning: string | null | undefined,
): void {
  if (reasoning === null || reasoning === undefined) return;
  if (reasoning.trim().length === 0) return;
  content.push({ type: "reasoning", text: reasoning });
}

/** 中止时的内容：已收到的思考 + 正文；两者都没有才给占位文案 */
function abortedContent(acc: StreamAccumulator): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];
  pushReasoningBlock(content, acc.reasoningBuffer);
  if (acc.textBuffer.length > 0) content.push(text(acc.textBuffer));
  return withFallbackText(content, "（请求已中止）");
}

// ------------------------------------------------------------
// 受控错误 / 中止消息
// ------------------------------------------------------------
function errorAssistant(code: string, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [text(`[模型错误] ${message}`)],
    stopReason: "error",
    usage: EMPTY_USAGE,
    timestamp: Date.now(),
    errorMessage: `${code}: ${message}`,
  };
}

function abortedMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [text("（请求已中止）")],
    stopReason: "aborted",
    usage: EMPTY_USAGE,
    timestamp: Date.now(),
  };
}

async function httpErrorText(response: Response): Promise<string> {
  const bodyText = await response.text().catch(() => "");
  return `DeepSeek API ${response.status} ${response.statusText}${
    bodyText ? `：${truncate(bodyText, 300)}` : ""
  }`;
}

/**
 * 解析一个 SSE data 载荷。
 * 返回 null 表示跳过：`[DONE]` 结束标记，或这一行是坏 JSON
 * （断流/网络抖动时常见，忽略即可，别让整个流崩掉）。
 */
function parseSseData(payload: string): OpenAiChunk | null {
  if (payload === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(payload) as OpenAiChunk;
  } catch {
    return null;
  }
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    // 保留原始串，方便在轨迹快照里看到"模型吐了什么坏 JSON"
    return { _parseError: raw };
  }
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}… [截断]`;
}

// ------------------------------------------------------------
// 临时调试日志：DEBUG_DEEPSEEK=true 时打印请求概览
// （默认关闭，不影响正常使用；不打印 Authorization 头，安全）
// ------------------------------------------------------------
function debugLog(params: {
  model: string;
  url: string;
  messages: OpenAiMessage[];
  tools: OpenAiTool[] | undefined;
}): void {
  const { model, url, messages, tools } = params;
  if (!config.agent.debugDeepSeek) return;

  console.log("\n[DeepSeek] ============ 请求 ============");
  console.log("[DeepSeek] url:", url);
  console.log("[DeepSeek] model:", model);
  console.log("[DeepSeek] messages:");
  for (const m of messages) {
    const content =
      typeof m.content === "string" ? truncate(m.content, 200) : "(null)";
    console.log(`  - ${m.role}: ${content}`);
  }
  console.log("[DeepSeek] tools:", JSON.stringify(tools ?? [], null, 2));
  console.log("[DeepSeek] ============ end ============\n");
}

// ------------------------------------------------------------
// provider 侧类型（只在本文件可见，不污染 lib/types.ts）
// ------------------------------------------------------------

/** postChatCompletion 的结果：成功拿到 Response，或已转成受控错误消息 */
type ChatResult =
  | { kind: "ok"; response: Response }
  | { kind: "error"; message: AssistantMessage };

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "tool"; content: string; tool_call_id: string }
  | {
      role: "assistant";
      content: string | null;
      /**
       * 思考内容的**原生字段**（不是塞进 content）。DeepSeek 的思考模式要求
       * 带 tools 的请求把历史思考按这个字段回传；塞进 content 会被模型当成
       * "自己说过的话"，行为就变了。
       */
      reasoning_content?: string;
      tool_calls?: OpenAiToolCall[];
    };

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OpenAiResponse = {
  choices?: Array<{
    message?: {
      role: "assistant";
      content?: string | null;
      /** 非流式时思考在同级字段里（思考模式下与 content 平级） */
      reasoning_content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type OpenAiChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** 思考增量：思考模式下与 content 平级，先于正文到达 */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  // include_usage 时，流的最后一个 chunk 携带用量
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};
