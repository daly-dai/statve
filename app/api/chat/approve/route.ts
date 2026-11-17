// ============================================================
// POST /api/chat/approve —— 回传工具确认的用户决定（Phase 3 人工确认）
// ============================================================
//
// 流程：引擎想执行写/改/删工具 → route.ts 推 tool_permission_request 帧
// 给前端 → 前端弹框 → 用户点「允许 / 拒绝」→ 本接口把决定交给挂起的确认。
//
// body: { toolCallId: string, allow: boolean }
//
// ⭐ 2026-11-17（C55 补记 14）：body 里不再有 session / persist ——
// 审批只有一次性（抄 DSH），所以这里**只做三件事**：找到挂起项、按需发
// 一次性凭据、resolve。没有"写记忆"这一步，这个接口也就没有副作用可记。
// 找不到挂起的确认（已超时/已处理）→ 404，前端提示「操作已超时」。
// ============================================================

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { toolApprovals } from "@/lib/toolApproval";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const toolCallId =
    typeof body?.toolCallId === "string" ? body.toolCallId : "";
  const allow = body?.allow === true;

  if (!toolCallId) {
    return NextResponse.json({ error: "缺少 toolCallId" }, { status: 400 });
  }

  const pending = toolApprovals.get(toolCallId);
  if (!pending) {
    return NextResponse.json(
      { error: "没有挂起的确认请求（可能已超时或已处理）" },
      { status: 404 },
    );
  }

  if (!allow) {
    pending.resolve("denied");
    return NextResponse.json({ ok: true, allow: false });
  }

  // 越界调用：先发一次性凭据，再放行。顺序不能反 —— 反了的话工具会先跑到
  // 围栏那里、发现没有凭据而抛"路径越界"，用户看到的是"批准了还是失败"。
  pending.grant?.();
  pending.resolve("approved");

  return NextResponse.json({ ok: true, allow: true });
}
