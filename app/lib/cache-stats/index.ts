// ============================================================
// cache-stats —— 「这一轮」的缓存命中读数（C68，2026-11-27）
// ============================================================
// 纯数据变换：消息数组 → 四个数。不含任何 React 状态/副作用，
// 所以住 app/lib 而不是 hook（`AGENTS.md` 11.9 的分界）。
//
// ⚠️ 口径是**累计**，不是"取最后一笔"——这是踩过一次的坑：
//   11-20 那轮一共 13 笔模型调用，最后一笔 input 只有 25,238，
//   而整轮累计 201,343（8 倍差）。「这一轮花了多少」只有累加答得对。
//
// 四条口径（各自的用例在 index.test.ts）：
//   ① 起点 = 最后一条 user 消息之后（本轮 = 一次提问引发的全部调用）
//   ② 逐笔累加 input / cachedInput；命中率 = Σ命中 ÷ Σ输入（加权，
//      不是各笔百分比求平均 —— 后者会让小请求和大请求等权）
//   ③ `stopReason === "aborted"` 那笔**跳过**：它的 usage 是全 0 的占位，
//      不进总和、不进笔数、不参与"是否缺数"判定，只用来点亮"最后一笔未计入"
//   ④ 任何一笔**非中止**的调用没报 `cachedInput` ⇒ 整轮「未知」——
//      只把有数的几笔加起来会算出**偏低**的命中率，那是错的。
// ============================================================

import type { AgentMessage } from "@/lib/types";

export type CacheStats =
  | {
      kind: "measured";
      /** 本轮已完成的模型调用笔数（不含被中止的那笔） */
      calls: number;
      /** 本轮累计输入 token */
      input: number;
      /** 其中命中前缀缓存的部分 */
      cached: number;
      /** 命中率，0–100 取整。>100 只可能来自 provider 报错 —— 原样保留，不夹 */
      percent: number;
      /** 本轮最后一笔被中止 ⇒ 它的用量没算进来（数字偏小但方向正确） */
      partial: boolean;
    }
  /** 本轮一笔都没完成（第一笔就被停）—— 不是"0 花费"，是"一笔都没等到" */
  | { kind: "stopped" }
  /** 有已完成的笔，但 provider 没报缓存用量 ⇒ 算不出来 */
  | { kind: "unknown" };

/**
 * 从消息历史里取「这一轮」的缓存读数。
 * `undefined` = 当前这一轮**还没有任何可算的东西**（正在跑、或空会话）。
 */
export function cacheStatsOf(
  messages: readonly AgentMessage[],
): CacheStats | undefined {
  // ① 倒着找最后一条 user 消息，它之后就是"这一轮"。
  //    找不到 user（空会话 / 只有系统注入）⇒ 从数组开头算。
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      start = i + 1;
      break;
    }
  }

  let calls = 0;
  let input = 0;
  let cached = 0;
  let missing = false;
  let stopped = false;

  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    // ③ 中止那笔的 usage 是全 0 占位，不能当真实读数参与任何计算
    if (message.stopReason === "aborted") {
      stopped = true;
      continue;
    }
    calls += 1;
    input += message.usage.input;
    if (message.usage.cachedInput === undefined) missing = true;
    else cached += message.usage.cachedInput;
  }

  // 正在跑（本轮的第一次调用还没回来）⇒ 没有可显示的，也不算"已停止"
  if (calls === 0) return stopped ? { kind: "stopped" } : undefined;
  // ④ 缺任何一笔的缓存数 ⇒ 整轮未知，宁可不给数也不给偏低的值
  if (missing) return { kind: "unknown" };

  return {
    kind: "measured",
    calls,
    input,
    cached,
    // input 为 0 时不给 NaN（中止/错误时 provider 可能回全 0）
    percent: input > 0 ? Math.round((cached / input) * 100) : 0,
    partial: stopped,
  };
}
