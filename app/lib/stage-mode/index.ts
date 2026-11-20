// ============================================================
// stage-mode —— 右栏的三种模式 + 舞台的 data-* 开关（C67）
// ============================================================
// 为什么住 `app/lib/` 而不是 `page.tsx`：这里全是**纯函数**（不含 React 状态、
// 不含副作用）。AGENTS 11.9 的核心分界 —— **hook 管"状态与副作用的绑定"，
// 纯函数管"数据变换"**；不带状态的东西留在页面里只会把页面撑长
// （C64：单文件 ≤ 500 行；这批功能刚把 page.tsx 顶回 541 行就是它）。
//
// 两个函数：
//   stageModeOf  有会话 / 无会话 / 还在加载
//   stageDataOf  把它翻成 `.stage` 上的 data-tabs / data-empty / data-nosession
// ============================================================

/** 右栏的状态：加载中（会话列表还没回来）· 无会话 · 有会话 */
export type StageMode = "loading" | "no-session" | "session";

/**
 * 右栏现在处于哪个模式。
 *
 * ⚠️ 顺序不能反：**先看有没有会话**，再看是不是在加载 —— `refresh()` 期间
 * `loading` 会短暂为 true，但已经选中的会话不能被这次刷新藏掉。
 */
export function stageModeOf(
  sessionId: string,
  sessionsLoading: boolean,
): StageMode {
  if (sessionId) return "session";
  return sessionsLoading ? "loading" : "no-session";
}

/** 舞台上的三个 data-* 开关（undefined = 不写这个属性） */
export type StageData = { tabs?: string; empty?: string; nosession?: string };

/**
 * `.stage` 的 data-* 组合。
 *
 * 为什么"加载中"和"无会话"都给同一个 `data-nosession`：两者的**布局**一样
 * （舞台上只有一行、内容居中），差别只在"画不画那句话"——那是
 * `<NoSessionHint visible>` 的事，不该在这里分叉。
 *
 * 另外这一档**不给** tabs / empty：那两条是"有会话时的布局切换"，同时写就是
 * 两条 CSS 规则抢同一件事（同权重，靠声明顺序决胜负 = 最脆弱的那种赢法）。
 */
export function stageDataOf(mode: StageMode, showTabs: boolean): StageData {
  if (mode !== "session") return { nosession: "" };
  return { tabs: showTabs ? undefined : "none", empty: emptyAttr(showTabs) };
}

/**
 * 空会话才有 `data-empty`（空串表示"写这个属性"，undefined 表示不写）。
 * CSS 认的是属性在不在，不是它的值。
 */
export function emptyAttr(hasChat: boolean): string | undefined {
  return hasChat ? undefined : "";
}
