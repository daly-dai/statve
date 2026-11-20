// ============================================================
// draft-store —— 按会话存的输入框草稿：纯逻辑层（C59）
// ============================================================
// 为什么要它：输入内容原本是**页面级的一份状态**，跟"当前是哪个会话"无关 ——
// 在 A 打了一半字切到 B，那段字还在框里，按发送就带着 **B 的 sessionId** 发出去。
//
// 形态（详案 `chat-surface-dsh-alignment.md` 4.12 的方案 A + B）：
// **输入框显示什么 = drafts[当前会话] ?? ""** —— 纯派生值。
// 换会话因此**不需要任何"清空 / 恢复"的 effect**（那正是单值状态才需要的补丁，
// 而且以后每新增一个切换入口都得记得再触发一次）。
//
// ⚠️ 这个文件**不碰 localStorage**（那是 `storage.ts` 的事）：纯函数、node 可测。
// 按 AGENTS 11.9 的分界，不含 React 状态与副作用的东西就该住 `app/lib/`。
// ============================================================

/** 会话 id → 那段还没发出去的字。没有键 = 没有草稿。 */
export type Drafts = Readonly<Record<string, string>>;

/** 取某个会话的草稿（没有就是空串，调用处不必再兜 undefined） */
export function draftOf(drafts: Drafts, sessionId: string): string {
  return drafts[sessionId] ?? "";
}

/**
 * 写入草稿。
 *
 * ⚠️ 两条小规矩，都是为了 React：
 * ① 没会话（id 是空串）就不写 —— 否则会攒出一个永远读不到的幽灵键；
 * ② 文字没变就**返回同一个对象**（引用相等）⇒ 不触发无谓的重渲染。
 */
export function setDraft(
  drafts: Drafts,
  sessionId: string,
  text: string,
): Drafts {
  if (sessionId === "") return drafts;
  if (draftOf(drafts, sessionId) === text) return drafts;
  return { ...drafts, [sessionId]: text };
}

/**
 * 把某个会话的草稿扔掉。幂等。
 *
 * 两个调用场景共用它：**发送成功 / 命令执行完**（用完了）、**会话被删**（没了）。
 * 只留一个名字，是因为它们**真的是同一个操作**；调用处靠注释说清是哪种。
 */
export function dropDraft(drafts: Drafts, sessionId: string): Drafts {
  if (!(sessionId in drafts)) return drafts; // 本来就没有：引用都不换
  const next: Record<string, string> = { ...drafts };
  delete next[sessionId];
  return next;
}
