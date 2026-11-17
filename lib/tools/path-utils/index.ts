// ============================================================
// 路径沙箱 —— 所有工具的"围栏"（lib/tools/ 内部共享）
// ============================================================
// 每个文件工具都先过 resolveInsideWorkspace：目标路径必须落在
// workspaceRoot 内，`..` 越界直接抛错。这是「agent 只能在工作区
// 里动文件」的结构保证——工具能力再强也出不了这个围栏。
//
// ⚠️ **这条保证曾经有一个例外：跨盘符**（2026-09-16 真机撞出：只读、免审批的
// `read_file` 读到了另一个盘的文件）。**2026-09-21 已修**（C33）。
//
// ⚠️ **第二个例外：软链 / junction**（2026-11-17 补，C55 补记 14）：围栏以前只做
// 字符串解析 —— `<根>/link/x` 里的 `link` 指向哪，字符串永远不知道，于是
// "以为拦着、其实放行"。**修法不是在这里加判据**，而是把判据挪进
// `lib/permission/tool-escape` 的 `inspectPath`（realpath 之后再看包含），
// 让围栏和审批用**同一份**判定。见下面的实现说明与 `index.test.ts` 的真软链用例。
// ============================================================

import { inspectPath } from "../../permission/tool-escape";
import type { EscapePermits } from "../../permission/tool-escape";

/** 取字符串参数；空串/非字符串时用 fallback（工具参数的可选值统一入口） */
export function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * 把相对/绝对路径解析进工作区；越界抛错 —— **除非人刚刚批准过这一条**。
 *
 * 返回的是**真实路径**（realpath）：后续 fs 调用拿它去执行，从判定到执行
 * 之间目标被换掉（TOCTOU，Time-Of-Check-To-Time-Of-Use，"检查完再执行"中间
 * 那段空档）的风险就小一截。这是 DSH `fs-sandbox` 的做法：判定用规范化后的
 * 新目标，**执行也用同一个**。
 *
 * `permits`（一次性通行证）由审批链路在人点头后发放，这里消费一次就作废
 * ⇒ 同一个越界目标**第二次**仍然抛错（详案 4.6 ③：越界不记忆）。
 * 为什么判据放在 `inspectPath`、放行动作放在这里：判定是事实、放行是权限，
 * 8 个工具共用这一个入口，改一处就全都对。
 */
export function resolveInsideWorkspace(
  workspaceRoot: string,
  input: string,
  permits?: EscapePermits,
): string {
  const verdict = inspectPath(workspaceRoot, input);
  if (verdict.kind === "inside") return verdict.target;

  // 人批准过这一条？命中就放行这一次（凭据被消费掉，下次还得问）
  if (permits?.consume(verdict.target) === true) return verdict.target;

  throw new Error(denyReason(input, verdict.kind));
}

/**
 * 拒绝时给模型看的话。**要能照着改**：
 *   - `outside`：说清越界 + 这条路径要么在根外、要么就是人没批。
 *   - `linked`：说清"链"这件事，并且**不告诉它链指向哪** —— 否则模型照着
 *     报错里的绝对路径重发一次，就绕过"链不该被自动跟随"这条（只是多绕一圈）。
 */
function denyReason(input: string, kind: "outside" | "linked"): string {
  if (kind === "linked") {
    return `路径越界：${input} 是工作空间内的一条软链（或 junction），它指向工作空间之外。这种路径不进入人工确认，请改用在**工作空间内的真实路径**上操作。`;
  }
  return `路径越界：${input}`;
}
