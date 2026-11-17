"use client";

// ============================================================
// use-mark-session-read —— 把当前会话的"已读位置"推上去（C56 第二轮）
// ============================================================
// 为什么是一个 effect，而不是在某一次点击里推进：
// 结局有两种到达方式 ——
//   ① 我**切到**一条已经跑完的会话（sessionId 变了）
//   ② 我在这个会话里**看着它跑完**（sessionId 没变，结局是后到的）
// 只认 ① 会漏掉 ② —— 那样"我看着它跑完再切走"还会亮一个结局点，
// 正是用户第 3 条否掉的行为。
//
// 依赖 `record` 而不是只依赖 id：② 的情形里 id 不变、只有记录变。
// 重复调用是安全的（markRead 在没法推进时原样返回 state）。
//
// 模型与场景表：app/lib/session-dot/index.ts + doc/plan/session-sidebar-ux.md 八
// ============================================================

import { useEffect } from "react";
import { useRunStore, useSessionReading } from "./run-store";

/** 当前会话（右栏显示的这一条）的结局，只要发生在这个页面里就算"看过" */
export function useMarkSessionRead(sessionId: string): void {
  const record = useSessionReading(sessionId);

  useEffect(() => {
    if (!sessionId || !record) return;
    useRunStore.getState().markRead(sessionId);
  }, [sessionId, record]);
}
