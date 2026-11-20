// ============================================================
// session-view —— 侧栏 / 标题行共用的两条"看会话"判据（纯函数）
// ============================================================
// 为什么住 `app/lib/`：全是纯函数（只看传入的列表），不含 React 状态与副作用 ——
// 按 AGENTS 11.9 的分界就该在这儿，而且这样它们能上单测（页面只做组装）。
//
// 来历：这两个函数原本在 `app/page.tsx` 底部。2026-11-20 给页面加 C59 时，
// 文件被我们自己的 `max-lines: 500` 规则抓住（510 行）⇒ 按规则把纯函数搬出来，
// 而不是删注释凑数。
// ============================================================

/** 列表里能查到的最小形状：这两个判据只用到这些字段 */
type SessionPeek = {
  id: string;
  title?: string;
  preview?: string;
};

/**
 * 会话的显示标签（**和侧栏那一行的标签同一条链**：标题 ?? 首条消息 ?? 空）。
 *
 * 为什么要"同一条链"：标题行和侧栏行显示同一个会话的名字，两条链迟早会漂 ——
 * 一处显示「新会话」、另一处显示首条消息，用户会以为点错了。
 */
export function labelOfSession(sessions: SessionPeek[], id: string): string {
  const found = sessions.find((item) => item.id === id);
  if (!found) return "";
  return found.title ?? found.preview ?? "";
}

/**
 * 这个会话有没有"对话"可看 —— 决定右栏顶部的「对话 / 轨迹」tab 要不要出现。
 *
 * 判据两条任一成立即可：
 *   ① 本次打开后已经加载/产生了消息；
 *   ② 列表里这条会话已有首条消息的预览（服务端事实，进页面就有，不会闪）。
 * 都没有 ⇒ 这是新会话，tab 没有意义（没有对话也没有轨迹）。
 */
export function hasConversation(
  sessions: SessionPeek[],
  id: string,
  messageCount: number,
): boolean {
  if (messageCount > 0) return true;
  const found = sessions.find((item) => item.id === id);
  return Boolean(found?.preview);
}
