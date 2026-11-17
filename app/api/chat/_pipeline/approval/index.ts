// ============================================================
// _pipeline/approval/index.ts —— 工具审批决策纯函数（E2 步骤 2 / C55 补记 14）
// ============================================================
// 从 route.ts handleToolApproval 提炼：把"决策"和"副作用"分开。
//   - decideToolCall(call, ctx) → ToolDecision：纯决策（同输入必同输出）
//   - 副作用（推确认帧、写轨迹事件）留在 route 壳 / approve 接口
//
// ⭐ 2026-11-17 砍掉了"审批记忆"（本会话允许 / 一直允许）。理由（抄 DSH 的
// `interaction/user-approval`）：
//   - DSH 的审批结果只有**一次性**（`allowed-once`），"别再问我了"不是弹框里
//     的选项，而是**策略设置**（`approval/policy = ask | never` + 沙箱模式）。
//   - 按工具名记住"允许"是很粗糙的信任：点一次 `write_file` 的「本会话允许」，
//     之后**任何**路径的写都不再问 —— 而人当时看的是那一个路径。
//   - 所以这里只保留一条：**每一次都要问**。想整轮不被打断，用页面上的审批模式
//     切到 YOLO（运行时状态，重启恢复 —— 不写盘、不留痕）。
// ============================================================

import { classifyEscape } from "@/lib/permission/tool-escape";
import type { ToolCallContent } from "@/lib/types";
import type { ToolDecision } from "@/lib/agent";

/** 用户在弹框里的选择：允许这一次 / 拒绝 / 超时（超时按拒绝算） */
export type { ApprovalOutcome } from "@/lib/permission/approval-outcome";

/**
 * decideToolCall 的返回类型：ToolDecision 三选一（allow/block/rewrite）+ request。
 * request = "需要人工确认"——副作用（推帧/日志）由调用方执行，
 * 因为 request 不是引擎能理解的结果，引擎只见最终三选一。
 */
export type ApprovalDecision =
  | ToolDecision
  // request：调用方（route 壳）自己知道要做什么副作用。
  // `danger` 是**升级提示**：越界这种调用不该长得和"普通写文件"一样
  | { action: "request"; danger?: EscapeDanger };

/** 什么让这次调用比普通写操作更危险（前端据此换样式、列绝对路径、改按钮文案） */
export type EscapeDanger = { kind: "outside-workspace"; targets: string[] };

/** 需要人工确认的工具：全部写/改/删操作 + bash（bash **一律**弹框，不再做静态分析） */
const TOOLS_NEEDING_CONFIRM = [
  "write_note",
  "write_file",
  "edit_file",
  "delete_file",
  "bash",
] as const;

/** decideToolCall 的外部依赖（注入，测试传 stub） */
export type ApprovalContext = {
  /** 越界判定的基准（会话头的 cwd）—— 没有它，越界判不出来 */
  workspaceRoot: string;
  getApprovalMode: () => "suggest" | "bypass" | "never";
};

/**
 * 纯决策：一次工具调用该放行/拦截/弹框/改写。
 * 不推帧、不写日志、不碰全局——副作用留给调用方。
 *
 * 这里只做**编排**：三条分支各有一件事、各有一个名字（硬性策略 /
 * 分级模式 / 人工确认），细节在下面那几个小函数里。
 */
export function decideToolCall(
  call: ToolCallContent,
  ctx: ApprovalContext,
): ApprovalDecision {
  // --- 硬性策略：secret/秘密 永不弹框，直接拦 ---
  // ⚠️ 顺序：**必须在越界判定之前**。反了的话，写 `.env` 会被降级成"可以问人"，
  // secret 的"永不弹框、直接拦"就废了。
  const secretBlock = blockSecretWrite(call);
  if (secretBlock) return secretBlock;

  // --- 越界：不是"放行"，是"升级成更危险的弹框" ---
  const escape = classifyEscape(call, ctx.workspaceRoot);
  if (escape.kind === "linked") {
    // 软链出去：不问。见 classifyEscape 上的说明（工作空间的内容不能自己扩大根）
    return {
      action: "block",
      reason:
        "这条路径是工作空间内的软链（或 junction），指向工作空间之外。它不进入人工确认 —— 请在工作空间内的真实路径上操作。",
    };
  }
  if (escape.kind === "outside") {
    return decideEscape(ctx, escape.targets);
  }

  // --- 分级模式（抄 pi defaultProjectTrust / CodeWhale approval_mode）---
  const needsConfirm = (TOOLS_NEEDING_CONFIRM as readonly string[]).includes(
    call.name,
  );
  const approvalMode = ctx.getApprovalMode();
  if (approvalMode === "bypass") {
    // YOLO：除硬性策略外全部放行（没有"人机确认"过程，不记日志）
    return { action: "allow" };
  }
  if (approvalMode === "never" && needsConfirm) {
    return {
      action: "block",
      reason: "当前审批模式为 never：需人工确认的工具直接拒绝。",
    };
  }

  // --- 人工确认（suggest 默认）：每一次都问，没有记忆 ---
  if (needsConfirm) return { action: "request" };

  return applyDefaultArguments(call);
}

/**
 * 越界怎么处理（C55 / 详案 4.6 ②）：**不是放行，是升级**。
 *
 *   bypass（YOLO）→ **block**："这次不问你" ⇒ 答案只能是"不行"。
 *                   若写成 allow，等于 YOLO 把围栏也关了。
 *   never         → block（与"需确认的一律拒绝"同义）
 *   suggest       → request + danger：前端据此弹危险样式、列**绝对路径**
 *
 * 为什么越界要独立于下面的"需确认工具表"：`read_file` 这类只读工具平时**不弹框**，
 * 但它越界读了工作区外的文件时，危险程度不低于写文件。
 */
function decideEscape(
  ctx: ApprovalContext,
  targets: string[],
): ApprovalDecision {
  const mode = ctx.getApprovalMode();
  if (mode === "bypass") {
    return {
      action: "block",
      reason:
        "当前是 YOLO（bypass）模式，越界调用不进入人工确认 ⇒ 直接拒绝。要执行请切回「建议」模式后再批准。",
    };
  }
  if (mode === "never") {
    return {
      action: "block",
      reason: "当前审批模式为 never：越界调用直接拒绝。",
    };
  }
  return {
    action: "request",
    danger: { kind: "outside-workspace", targets },
  };
}

/**
 * 硬性策略：写文件类工具的目标里出现 secret/秘密 → 永不弹框，直接拦。
 * 不需要拦时返回 undefined，调用方继续往下走。
 */
function blockSecretWrite(call: ToolCallContent): ApprovalDecision | undefined {
  if (call.name !== "write_note" && call.name !== "write_file") {
    return undefined;
  }

  // 取要检查的路径：write_note 用 fileName，write_file 用 path。
  // 不用嵌套三元——两层 ? : 叠在一起难读，if/else 直白。
  let target = "";
  if (typeof call.arguments.fileName === "string") {
    target = call.arguments.fileName;
  } else if (typeof call.arguments.path === "string") {
    target = call.arguments.path;
  }

  if (!/secret|秘密/i.test(target)) return undefined;

  return {
    action: "block",
    reason: "权限策略：不允许写入包含 secret/秘密 的文件。",
  };
}

/** 无需确认的工具：list_files 缺 path 时补默认值，其余直接放行 */
function applyDefaultArguments(call: ToolCallContent): ApprovalDecision {
  // list_files 没有 path 参数时补齐默认值
  if (call.name === "list_files" && typeof call.arguments.path !== "string") {
    return {
      action: "rewrite",
      args: { ...call.arguments, path: "." },
      reason: "补齐默认目录参数。",
    };
  }

  return { action: "allow" };
}
