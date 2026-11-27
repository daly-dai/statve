// ============================================================
// cache-stats 的单测（C68）
// ============================================================
// 测的是**口径**，不是实现。四条口径各有一组用例：
//   ① 只算"最后一条 user 消息之后"那一轮
//   ② 累加，不是取最后一笔（这是踩过的坑）
//   ③ 中止那笔跳过，不进总和/笔数/缺数判定
//   ④ 缺任何一笔的缓存数 ⇒ 整轮未知
// ============================================================

import { describe, expect, it } from "vitest";
import { cacheStatsOf } from ".";
import type { AgentMessage, Usage } from "@/lib/types";

/** 一条用户消息（作为轮次分隔） */
function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/** 一次已完成的模型调用 */
function assistant(
  usage: Usage,
  stopReason: "stop" | "toolUse" = "stop",
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason,
    usage,
    timestamp: 1,
  };
}

/** 被中止的那笔：真实数据里它就是全 0 + stopReason: "aborted" */
function aborted(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "（请求已中止）" }],
    stopReason: "aborted",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: 2,
  };
}

/** 一次调用的 usage。`cachedInput` 不传 = provider 没报 */
function usage(input: number, cachedInput?: number): Usage {
  return {
    input,
    output: 10,
    totalTokens: input + 10,
    ...(cachedInput === undefined ? {} : { cachedInput }),
  };
}

function toolResult(): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text: "文件内容" }],
    isError: false,
    timestamp: 3,
  };
}

describe("cacheStatsOf —— 只算这一轮", () => {
  it("空会话 ⇒ undefined", () => {
    expect(cacheStatsOf([])).toBeUndefined();
  });

  it("只有 user 消息（第一次调用还没回来）⇒ undefined，**不是**「已停止」", () => {
    expect(cacheStatsOf([user("写个函数")])).toBeUndefined();
  });

  it("多轮 ⇒ 只统计最后一条 user 之后的那一轮", () => {
    const messages: AgentMessage[] = [
      user("第一轮"),
      assistant(usage(100, 50)),
      user("第二轮"),
      assistant(usage(200, 150)),
    ];
    expect(cacheStatsOf(messages)).toEqual({
      kind: "measured",
      calls: 1,
      input: 200,
      cached: 150,
      percent: 75,
      partial: false,
    });
  });
});

describe("cacheStatsOf —— 累加，不是取最后一笔", () => {
  it("一轮 3 笔 ⇒ 三个数相加、笔数 3（真实场景：工具调用会拆成多笔）", () => {
    // 夹具来历：11-20 那轮真机上就是 13 笔，每笔都重新读一遍历史。
    // 只取最后一笔会得到 25,238，而实际花了 201,343 —— 差 8 倍。
    const messages: AgentMessage[] = [
      user("整理核心逻辑"),
      assistant(usage(5_419, 0), "toolUse"),
      toolResult(),
      assistant(usage(6_906, 5_000), "toolUse"),
      toolResult(),
      assistant(usage(25_238, 20_000)),
    ];
    expect(cacheStatsOf(messages)).toEqual({
      kind: "measured",
      calls: 3,
      input: 37_563,
      cached: 25_000,
      percent: 67,
      partial: false,
    });
  });

  it("命中率是**加权**（Σ命中 ÷ Σ输入），不是各笔百分比求平均", () => {
    // 两笔：50% 和 100%。简单平均是 75%；加权是 (50+1000)/(100+1000)=95.5%→95
    const messages: AgentMessage[] = [
      user("x"),
      assistant(usage(100, 50), "toolUse"),
      assistant(usage(1_000, 1_000)),
    ];
    expect(cacheStatsOf(messages)?.kind).toBe("measured");
    const stats = cacheStatsOf(messages);
    if (stats?.kind !== "measured") throw new Error("应是 measured");
    expect(stats.percent).toBe(95);
  });
});

describe("cacheStatsOf —— 中止那一笔", () => {
  it("跳过它：不进总和、不进笔数，但点亮 partial", () => {
    // 真实数据：11-18 那轮跑完 6 笔后被按停止，第 7 笔是 aborted
    const messages: AgentMessage[] = [
      user("看看这个仓库"),
      assistant(usage(5_257, 0), "toolUse"),
      toolResult(),
      assistant(usage(6_471, 5_404), "toolUse"),
      toolResult(),
      aborted(),
    ];
    expect(cacheStatsOf(messages)).toEqual({
      kind: "measured",
      calls: 2,
      input: 11_728,
      cached: 5_404,
      percent: 46,
      partial: true,
    });
  });

  it("第一笔就被停（0 笔完成）⇒ stopped，**不是** measured 0", () => {
    expect(cacheStatsOf([user("hi"), aborted()])).toEqual({ kind: "stopped" });
  });
});

describe("cacheStatsOf —— 没报就是没报", () => {
  it("任何一笔缺 cachedInput ⇒ 整轮 unknown（不给偏低的值）", () => {
    const messages: AgentMessage[] = [
      user("x"),
      assistant(usage(100, 90), "toolUse"),
      assistant(usage(200)), // 这笔没报
    ];
    expect(cacheStatsOf(messages)).toEqual({ kind: "unknown" });
  });

  it("input 为 0 ⇒ 百分比给 0，不出 NaN", () => {
    const messages: AgentMessage[] = [user("x"), assistant(usage(0, 0))];
    expect(cacheStatsOf(messages)).toEqual({
      kind: "measured",
      calls: 1,
      input: 0,
      cached: 0,
      percent: 0,
      partial: false,
    });
  });

  it("cached > input（provider 报错）⇒ 原样 >100%，不夹", () => {
    // 故意的：夹一下就把脏数据的唯一可见信号抹掉了
    const messages: AgentMessage[] = [
      user("x"),
      assistant(usage(1_000, 1_050)),
    ];
    const stats = cacheStatsOf(messages);
    if (stats?.kind !== "measured") throw new Error("应是 measured");
    expect(stats.percent).toBe(105);
  });
});
