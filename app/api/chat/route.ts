// ============================================================
// API 路由 —— SSE 流式消费者（使用端）
// ============================================================
//
// 这里演示了「使用端如何实时接收 Agent 事件」的第二种方式（推送式）：
//   之前：runAgentLoop 跑完 → 把 events 一次性打包成 JSON 返回（拉取式）
//   现在：runAgentLoop 边跑 → onEvent 回调里立刻把事件写进 SSE 流（推送式）
//
// SSE（Server-Sent Events）是单向的"服务器 → 浏览器"流：每个事件是一行
//   data: {json}\n\n
// 浏览器用 fetch + ReadableStream 逐块读取，事件一到就立刻渲染。
//
// 本路由会依次推送以下帧（frame）：
//   { type: "run", runId, model }   本次 run 的元信息（前端据此展示）
//   { type: "event", event }        每个 Agent 事件（含用户消息 + Agent 内部事件）
//   { type: "done", ... }           循环结束后的最终权威结果
//   { type: "error", message }      出错信息
// ============================================================

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  createUserMessage,
  isValidSessionId,
  sessionManager,
  getApprovalMode,
  toolApprovals,
  clearRun,
  runControllers,
  config,
} from "@/lib";
import type { ToolCallContent, ToolDecision, ToolContext } from "@/lib";
import type { StreamFrame } from "./_pipeline/frames";
import {
  decideToolCall,
  type ApprovalOutcome,
  type EscapeDanger,
} from "./_pipeline/approval";
import { selectModelSafe } from "./_pipeline/model";
import { createRequestContext, createSessionStore } from "./_pipeline/context";
import { runPipeline } from "./_pipeline/index";
import { computeContextPressure } from "./_pipeline/context";
import type { AgentEvent } from "@/lib/types";

// 显式声明 Node runtime：本路由（以及它的工具）会用 node:fs / node:path，
// 后面 Phase 4 还要用 node:child_process 跑终端。
export const runtime = "nodejs";

// 路径与行为配置：全部来自 lib/config（唯一入口，环境变量可覆盖）。
// ⚠️ 2026-11-11 起这里**不再**取 workspaceRoot / traceDir / sessionDir：
// 会话目录由 `SessionManager.locate(id)` 给出（lib/session/paths 是唯一拼法），
// 轨迹住在会话目录里。这一步删掉了「4 处各自拼路径」里的两处。
// 工具注册表【不在这里建单例】（贴 pi create-harness）：
// 它在每次 POST 请求内组装，业务 hooks 闭包捕获当次的 store/send。
//
// ⭐ **"这次请求的环境"（工作区根 + 技能根）已挪到 `_pipeline/context.ts`**（C8 T5）——
// 因为 `GET /api/chat/commands` 也要它（把技能组进面板清单），而技能根只允许有
// **一个生产点**（施工纪律 5）。里面那段"⚠️ 本常量在模块作用域是有前提的"照旧适用。

// systemPrompt 常量已拆到 _pipeline/prompt.ts（E2 阶段管线重构）

// StreamFrame 协议已拆到 _pipeline/frames.ts（E2 阶段管线重构）

// --- POST /api/chat ---
export async function POST(req: NextRequest) {
  let text: unknown;
  // Phase 2 多会话：body 可选传 sessionId，不传用 default
  let sessionId = "default";

  try {
    const body = await req.json();

    text = body?.text;

    if (typeof body?.sessionId === "string" && body.sessionId.trim()) {
      sessionId = body.sessionId.trim();
      // 安全：sessionId 会拼进文件路径，必须过白名单校验（见 sessionManager）
      if (!isValidSessionId(sessionId)) {
        return NextResponse.json({ error: "非法 sessionId" }, { status: 400 });
      }
    }
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!text || typeof text !== "string") {
    return NextResponse.json({ error: "缺少 text 字段" }, { status: 400 });
  }

  // 模型选择：MOCK_MODE=true 用离线 Mock，否则用真实 DeepSeek。
  // 缺 key 时直接返回 400，让前端能显示清楚的错误，而不是崩在服务端。
  // selectModelSafe 统一"选择失败 → error 文案"（command route 同款）。
  const selected = selectModelSafe();
  if (!selected.ok) {
    return NextResponse.json({ error: selected.error }, { status: 400 });
  }
  const model = selected.model;
  const modelLabel = selected.label;

  // 创建用户消息
  const userMessage = createUserMessage(text.trim());

  // 创建会话存储和记录器（先定位：找不到会话 = 404，不再"顺手建一个"）
  const location = await sessionManager.locate(sessionId);
  if (!location) {
    return NextResponse.json(
      { error: `会话不存在：${sessionId}` },
      { status: 404 },
    );
  }
  const { store, recorder, toolContext } = await createRequestContext({
    sessionId,
    location,
    modelLabel,
  });

  // 新会话的标题：默认叫「新会话」，用户说的第一句话发出去之后换成那句话
  // （2026-11-17 用户定）。只在"还没有任何消息 + 没手动改过名"时才改；
  // 改不动就算了 —— 标题不该让这次对话失败。
  await sessionManager.adoptFirstMessageAsTitle(sessionId, text.trim());

  // 创建文本编码器
  const encoder = new TextEncoder();

  // 创建可读流
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 创建发送函数
      const send = (frame: StreamFrame) => {
        // 每个 frame 前加 data: 开头，后加两个换行符，模拟 SSE 流
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
      };

      // 客户端断开感知：标签页/浏览器关闭时，Next.js 会 abort 请求信号。
      // 此时 SSE 流的 finally 不一定触发，这里主动清理该 run 的挂起提问，
      // 防止 onAskUser Promise 永远等不到、残留内存。
      let runFinalized = false;
      const finalizeRun = () => {
        if (runFinalized) return;

        runFinalized = true;
        clearRun(recorder.runId);
      };
      // 客户端断开感知：标签页/浏览器关闭时，Next.js 会 abort 请求信号。
      req.signal.addEventListener("abort", finalizeRun);

      // run 级失败：抛异常时只发 SSE 是不够的——轨迹文件才是事后回放的依据。
      // 记在这里、在 finally 交给 recorder.end()，否则一个崩掉的 run 在轨迹里
      // 和跑成功的 run 长得一模一样（catch 之后仍会走到 finally 写 trace_end）。
      let runError: string | undefined;

      try {
        // 0) run 级取消：注册 AbortController（停止按钮通过 /api/chat/stop 触发）
        const abortController = new AbortController();
        runControllers.set(recorder.runId, abortController);

        // 0) 先推 run 元信息（runId + 模型名），前端据此展示"本次是哪个 run"
        send({ type: "run", runId: recorder.runId, model: modelLabel });

        // 1-3) 编排交给 _pipeline/index.ts 的 runPipeline（E2 步骤 4）：
        //     落盘/工具组装/系统提示词/loop/压缩/done 都收进编排层；这里只保留
        //     SSE 管道（send/abort/finally）——Next.js 请求生命周期。
        //     ⚠️ 系统提示词**不在这里装**（C34，2026-09-16）：它现在由 runPipeline 在
        //     组装完工具注册表之后现装 —— 因为提示词里有一段来自**各工具的投稿**
        //     （`RegisteredTool.guidelines`），而注册表是在那一层建的。装配点只有一个。
        await runPipeline({
          model,
          userMessage,
          store,
          recorder,
          send,
          signal: abortController.signal,
          // 这次请求的环境：围栏根 = 本会话的工作空间，技能根由它派生（每请求一份，
          // 不再是模块常量 —— 那是 F2「所有会话共用第一个工作空间」的来源）
          toolContext,
          beforeToolCall: (call) =>
            handleToolApproval({
              call,
              send,
              toolContext,
              // 审批结论也要进轨迹（C55 补记 14）：引擎只在"非放行"时发
              // tool_permission，**批准了的越界在轨迹里原本什么都不留**。
              record: (event: AgentEvent) => recorder.record(event),
            }),
        });
      } catch (e) {
        runError = (e as Error).message;
        send({ type: "error", message: runError });
      } finally {
        // run 结束（正常/出错/被停止）：注销取消句柄 + 清理该 run 的挂起提问。
        // 用 finalizeRun 收口（含移除 abort 监听器），和客户端断开路径一致，
        // 避免两处重复。clearRun 强制 resolve 空数组，onAskUser Promise 不残留。
        req.signal.removeEventListener("abort", finalizeRun);
        finalizeRun();
        runControllers.delete(recorder.runId);
        // error 只在失败时带（JSON.stringify 会丢掉 undefined 的键）。
        // completed 与 summary.error 是两件事：前者 = 文件写完了，
        // 后者 = 这次运行跑得怎么样——崩掉的 run 是「文件完整 + 有 error」。
        await recorder.end({
          messages: recorder.entries.length,
          error: runError,
        });
        controller.close();
      }
    },
  });

  // 关键：Content-Type 必须是 text/event-stream，且关闭缓存/缓冲，
  // 否则浏览器或中间件会把整个响应缓冲到结束才一次性返回。
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// --- GET /api/chat?sessionId=xxx ---
// 返回会话历史（全部消息，按对话顺序），供前端挂载/切换会话时恢复多轮对话。
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId") || "default";
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "非法 sessionId" }, { status: 400 });
  }
  const store = await createSessionStore(sessionId).catch(() => undefined);
  if (!store) {
    return NextResponse.json(
      { error: `会话不存在：${sessionId}` },
      { status: 404 },
    );
  }
  return NextResponse.json({
    sessionId,
    messages: store.buildContext(),
    stats: store.stats(),
    todos: store.getLatestTodos() ?? [],
    contextPressure: computeContextPressure(store), // C13 ContextMeter 数据源
  });
}

// --- DELETE /api/chat?sessionId=xxx ---
// 清空会话消息（保留会话本身）。2026-08-26：前端「清空记录」按钮已删，
// 本路由保留为服务端能力（未来斜杠命令 /clear 等可复用）。
// 为什么要有服务端清空：只清前端本地状态的话，刷新后历史会从文件复活。
export async function DELETE(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId") || "default";
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "非法 sessionId" }, { status: 400 });
  }
  const store = await createSessionStore(sessionId).catch(() => undefined);
  if (!store) {
    return NextResponse.json(
      { error: `会话不存在：${sessionId}` },
      { status: 404 },
    );
  }
  await store.reset();
  return NextResponse.json({ ok: true, sessionId });
}

// --- 工具审批：硬性策略 + 人工确认 ---
// 引擎每次想调工具都会先来这里（beforeToolCall 钩子）。
// 两层把关：
//   1. 硬性安全策略：secret/秘密 文件名直接拦，不弹框（这类永远不该发生）
//   2. 人工确认：写/改/删工具 + bash 推确认帧给前端弹框，用户当场允许/拒绝
// 只读工具（list/read/grep/find）默认放行 —— ⚠️ 这里说的"只读"是**工具**，
// 不是 bash 命令：bash 不管读还是写**一样弹框**（C55 补记 14 删掉了静态分析）。
// 超时兜底：用户 5 小时不回应自动拒绝（block），避免挂起（前端不展示时间）。

// 人工确认超时：默认 5 小时（用户要长时间思考/离开也不该被打断；是"兜底防挂死"，
// 不是"催促"——前端已不展示任何时间提示）。可用 APPROVAL_TIMEOUT_MS 环境变量覆盖。
const APPROVAL_TIMEOUT_MS = config.approval.timeoutMs;

async function handleToolApproval(params: {
  call: ToolCallContent;
  send: (frame: StreamFrame) => void;
  toolContext: ToolContext;
  /** 把审批结论写进轨迹（越界被批准时引擎不会发事件，需要在这里补一条） */
  record: (event: AgentEvent) => void;
}): Promise<ToolDecision> {
  const { call, send, toolContext, record } = params;
  // 决策交给纯函数 decideToolCall（_pipeline/approval/index.ts，已单测覆盖）：
  //   - allow / block / rewrite → 直接用决策
  //   - request → 需要人工确认：这里执行副作用（推帧 + 挂起弹框 + 记轨迹）
  const decision = decideToolCall(call, {
    // 越界判定基准 = 这个会话的工作空间（值来自会话头，不是全局配置）
    workspaceRoot: toolContext.workspaceRoot,
    getApprovalMode,
  });
  if (decision.action !== "request") return decision;

  const outcome = await askUserApproval({
    call,
    send,
    danger: decision.danger,
    // 人点头之后，把"这一次的目标"发成一次性凭据；围栏消费一次就作废
    grant: () => toolContext.permits?.grant(decision.danger?.targets ?? []),
  });

  if (outcome === "approved") {
    // ⭐ 审计（C55 补记 14）：引擎只在 block / rewrite 时发 tool_permission，
    // 所以"越界被批准"在轨迹里原本是一个**空档** —— 事后翻 trace 只看到一次
    // 普通工具调用，看不出它出过工作区、更看不出是人批的。
    // 这里补一条 action=allow 的 tool_permission（带目标），DSH 对应的做法是
    // 会话事件 `approval/asked` + `approval/decided`。
    if (decision.danger) {
      record({
        type: "tool_permission",
        toolCallId: call.id,
        toolName: call.name,
        action: "allow",
        reason: `越界调用已获人工批准：${decision.danger.targets.join("、")}`,
        originalArgs: call.arguments,
        args: call.arguments,
      });
    }
    return { action: "allow" };
  }

  return {
    action: "block",
    reason: denyReason(outcome, decision.danger),
  };
}

/**
 * 拒绝时回给模型的理由。
 * 越界被拒要说清"拒的是越界"（连带目标）：只说"用户拒绝了"，模型下一轮
 * 会照原样再试一次 —— 它不知道问题出在路径上。
 */
function denyReason(outcome: ApprovalOutcome, danger?: EscapeDanger): string {
  if (outcome === "timeout") return "审批超时未回应，自动拒绝。";
  if (danger) {
    return `用户拒绝了这次越界到工作空间之外的调用（${danger.targets.join("、")}）。`;
  }
  return "用户拒绝了本次工具调用。";
}

/** 挂起一次人工确认：推帧 → 注册 pending → 返回 Promise（approve 接口或超时来 resolve） */
function askUserApproval(params: {
  call: ToolCallContent;
  send: (frame: StreamFrame) => void;
  /** 越界提示（普通写操作没有） */
  danger?: EscapeDanger;
  /** 人批准后发放一次性凭据（越界才需要） */
  grant?: () => void;
}): Promise<ApprovalOutcome> {
  const { call, send, danger, grant } = params;

  return new Promise((resolve) => {
    send({
      type: "tool_permission_request",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
      ...(danger ? { danger } : {}),
    });

    // 超时兜底：5 小时不回应自动拒绝（timeout），run 不会被挂死（前端不展示时间）
    const timer = setTimeout(() => {
      toolApprovals.delete(call.id);
      resolve("timeout");
    }, APPROVAL_TIMEOUT_MS);

    toolApprovals.set(call.id, {
      toolName: call.name,
      // approve 路由在"允许"时调它 —— 这是凭据跨越两个 HTTP 请求的唯一通路
      ...(grant ? { grant } : {}),
      resolve: (outcome: ApprovalOutcome) => {
        clearTimeout(timer);
        toolApprovals.delete(call.id);
        resolve(outcome);
      },
      timer,
    });
  });
}
