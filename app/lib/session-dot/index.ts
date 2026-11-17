// ============================================================
// session-dot —— 侧栏那一行该不该亮状态点（C56 第二轮，2026-11-17）
// ============================================================
// 模型：点 = 「这条会话有一件我没看见的事」。事有两种 ——
//   ① **正在发生**：running / waiting-*（此刻的事实，没有"读没读过"这回事）
//   ② **结局**：done / error（一次性的，判据是"跑到第几次 vs 你看到第几次"）
//
// 为什么不能直接从 run 阶段投影（第一版的错）：
//   `lastOutcome` 是**存量**（`run-fold` 注释原话「保持到下次 startRun」）⇒
//   「我看着它跑完再切走」会重新亮一个结局点、「切回去看过再切走」还会再亮
//   一次。用户两条都当场否掉了（原话与场景表见 doc/plan/session-sidebar-ux.md 八）。
//
// 依据（两家参考项目是同一个模型，一手源码位置见详案 8.2）：
//   DSH    completionUnread = manualUnread || (id !== viewing && completedTurn > readTurn)
//   pi-web unreadSessionIds：选中即删、又开始跑也删；running 是另一套数据
//
// ⚠️ 这套算术有个刻意的不对称：**"看过"是推进已读位置，不是清除标记**。
// 一个动作同时满足两条规则 —— "再切走也不亮"（位置已经推到最新）和
// "跑的时候切回来不点、切走又点"（在跑不看位置，看此刻事实）。
// ============================================================

import type { RunPhase } from "../run-fold";

/**
 * 一条会话的「阅读位置」。
 * 住 run-store 的旁表，**不进 `RunState`**：RunState 是帧折叠出来的（能重放），
 * "人看没看见"不是折叠的产物 —— 它是产品状态。
 */
export type ReadingRecord = {
  /** 最近一次 run 收尾的序号（0 = 本页面里还没跑完过） */
  endedSeq: number;
  /** 那次 run 是不是失败（结局只有成败两种，没有"不知道"） */
  failed: boolean;
  /** 你"看到"到第几次的结局（0 = 一次都没看过） */
  readSeq: number;
};

/** 没跑完过的会话（也用作 run 收尾时缺记录时的底） */
export const EMPTY_READING: ReadingRecord = {
  endedSeq: 0,
  failed: false,
  readSeq: 0,
};

/**
 * run 收尾：记下这次的结局。**`readSeq` 不动** —— 看没看见由 `advanceRead` 决定
 * （两条规则因此不打架：写事实和推进位置是两件事）。
 */
export function recordRunEnd(
  record: ReadingRecord,
  end: { seq: number; failed: boolean },
): ReadingRecord {
  return { ...record, endedSeq: end.seq, failed: end.failed };
}

/**
 * 看过这个结局：把已读位置推到最后一次收尾。
 * 没得推时**原样返回**（引用不变 ⇒ store 不换桶 ⇒ 不重渲、effect 不会自激）。
 */
export function advanceRead(record: ReadingRecord): ReadingRecord {
  if (record.readSeq >= record.endedSeq) return record;
  return { ...record, readSeq: record.endedSeq };
}

/** 一行的点："none" 表示不渲染（CSS 只认这四个 data-dot 值） */
export type DotKind = "none" | "running" | "waiting" | "done" | "error";

/**
 * 这一行该亮什么点。
 *
 * 优先级：当前会话 → 卡住等你的 → 正在跑的 → 没看过的结局。
 * ⚠️ `phase` 的 `done` / `error` **不参与判定**：它们只说明"上次结局是什么"，
 * 不说明"你看没看见"。结局一律走 `endedSeq > readSeq`。
 */
export function sessionDotFor(input: {
  phase: RunPhase;
  /** 右栏正在显示的是不是它 */
  isCurrent: boolean;
  record: ReadingRecord | undefined;
}): DotKind {
  // 规则 1：当前会话永不点（比两家参考项目都严 —— 它们会为在跑的当前会话点）
  if (input.isCurrent) return "none";
  // 卡住等你：必须提醒（我切过去看一眼没处理就走，它仍然卡着等我）
  if (input.phase === "waiting-approval" || input.phase === "waiting-ask") {
    return "waiting";
  }
  // 正在跑：此刻的事实，不看"读没读过"
  if (input.phase === "running") return "running";
  // 结局：只有"没看过这一次"才亮
  const record = input.record;
  if (!record || record.endedSeq <= record.readSeq) return "none";
  return record.failed ? "error" : "done";
}
