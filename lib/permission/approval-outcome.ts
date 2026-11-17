// ============================================================
// 审批结果类型 —— 一个纯类型，住在 lib 是因为**两边都要用**
// ============================================================
// 消费方：
//   - `lib/toolApproval.ts`（挂起的确认 → resolve 成结果）
//   - `app/api/chat/route.ts`（弹框的返回值）
//   - `app/api/chat/_pipeline/approval`（决策纯函数）
//
// 为什么从 lib 出发而不是 app：lib 不许依赖 app（分层）。以前它住在
// `lib/permission/approval-log`，C52 删掉那个模块后，类型单独留在这里。
//
// ⭐ 2026-11-17 只剩三档（C55 补记 14）：原来的 `approved-session` /
// `approved-persist`（本会话 / 一直允许）随"审批记忆"一起删了 ——
// 抄 DSH `interaction/user-approval`：审批只有**一次性**，想不被打断是**改策略**
// （页面上的审批模式），不是弹框里的一个选项。

/** 用户在弹框里的选择：允许这一次 / 拒绝 / 超时（超时按拒绝处理） */
export type ApprovalOutcome = "approved" | "denied" | "timeout";
