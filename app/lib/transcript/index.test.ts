import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  AssistantMessage,
  CompactionSummaryMessage,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";
import { buildTranscript, countByCategory, toolCategoryOf } from "./index";

// 夹具照真机数据的形状写（见 doc/plan/chat-surface-dsh-alignment.md 4.13 的实测：
// 一个回合 = 用户 + 若干「助手带 toolCall」+ 同样多的 toolResult + 最后一条助手正文）。
// 每条不超过几行，看 diff 的人一眼能看穿。

const text = (t: string): TextContent => ({ type: "text", text: t });

const call = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolCallContent => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const user = (t: string, extra: Partial<UserMessage> = {}): UserMessage => ({
  role: "user",
  content: [text(t)],
  timestamp: 100,
  ...extra,
});

const assistant = (
  content: Array<TextContent | ToolCallContent>,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content,
  stopReason,
  usage: { input: 10, output: 5, totalTokens: 15 },
  timestamp: 200,
});

/** 成功的结果（绝大多数）；失败的单独一个名字，测试里读起来更像人话 */
const result = (id: string, name: string, t: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [text(t)],
  isError: false,
  timestamp: 300,
});

const failureResult = (
  id: string,
  name: string,
  t: string,
): ToolResultMessage => ({
  ...result(id, name, t),
  isError: true,
});

const compaction = (summary: string): CompactionSummaryMessage => ({
  role: "compactionSummary",
  summary,
  tokensBefore: 9000,
  timestamp: 400,
});

describe("buildTranscript：回合边界", () => {
  it("两条用户消息 ⇒ 两个回合（一条用户消息开一回合）", () => {
    const turns = buildTranscript([
      user("第一个问题"),
      assistant([text("第一个回答")]),
      user("第二个问题"),
      assistant([text("第二个回答")]),
    ]);
    expect(turns.map((t) => t.prompt)).toEqual(["第一个问题", "第二个问题"]);
    expect(turns.map((t) => t.answer)).toEqual(["第一个回答", "第二个回答"]);
  });

  it("compactionSummary 开新回合，prompt 为空、摘要进过程 note", () => {
    const turns = buildTranscript([
      user("问"),
      assistant([text("答")]),
      compaction("旧对话的摘要"),
      user("压缩之后的问题"),
    ]);
    expect(turns).toHaveLength(3);
    expect(turns[1].prompt).toBe("");
    expect(turns[1].steps).toEqual([
      {
        kind: "note",
        note: "compaction",
        label: "上下文已压缩",
        text: "旧对话的摘要",
      },
    ]);
    expect(turns[2].prompt).toBe("压缩之后的问题");
  });

  it("技能注入（source=skill-invocation）不开新回合，算过程里的一条 note", () => {
    const turns = buildTranscript([
      user("用一下那个技能"),
      user("技能正文……", {
        source: { kind: "skill-invocation", name: "review", baseDir: "/s" },
      }),
      assistant([text("好了")]),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].steps[0]).toMatchObject({
      kind: "note",
      note: "skill",
      label: "已加载技能 review",
    });
    expect(turns[0].answer).toBe("好了");
  });
});

describe("buildTranscript：最终回答怎么切", () => {
  it("最后一条助手消息只有正文 ⇒ 整条就是回答，过程为空", () => {
    const [turn] = buildTranscript([user("问"), assistant([text("答")])]);
    expect(turn.answer).toBe("答");
    expect(turn.steps).toEqual([]);
  });

  it("最后一条是 `[正文, toolCall]` ⇒ 没有回答，那段正文算过程（pi-web 同款切法）", () => {
    const [turn] = buildTranscript([
      user("问"),
      assistant([text("我先看看"), call("t1", "read_file", { path: "a.md" })]),
      result("t1", "read_file", "内容"),
    ]);
    expect(turn.answer).toBe("");
    expect(turn.steps[0]).toEqual({ kind: "text", text: "我先看看" });
    expect(turn.steps[1]).toMatchObject({
      kind: "tool",
      name: "read_file",
      status: "ok",
    });
  });

  it("中途叙述进过程、最终回答单独出来（顺序不乱）", () => {
    const [turn] = buildTranscript([
      user("问"),
      assistant([text("第一段叙述"), call("t1", "bash")]),
      result("t1", "bash", "输出"),
      assistant([text("最后的结论")]),
    ]);
    expect(turn.answer).toBe("最后的结论");
    expect(turn.steps.map((s) => s.kind)).toEqual(["text", "tool"]);
  });

  it("一个回合里的多段回答文本会按顺序拼起来", () => {
    const [turn] = buildTranscript([
      user("问"),
      assistant([text("前半"), call("t1", "read_file")]),
      result("t1", "read_file", "x"),
      assistant([text("总结一"), text("总结二")]),
    ]);
    expect(turn.answer).toBe("总结一\n\n总结二");
  });

  it("空文本块不进任何东西（流式占位不留空行）", () => {
    const [turn] = buildTranscript([
      user("问"),
      assistant([text("   "), text("真内容")]),
    ]);
    expect(turn.answer).toBe("真内容");
    expect(turn.steps).toEqual([]);
  });
});

describe("buildTranscript：工具与结局", () => {
  it("toolResult 按 toolCallId 归位；isError ⇒ status=error", () => {
    const [turn] = buildTranscript([
      user("问"),
      assistant([call("t1", "read_file"), call("t2", "bash")]),
      result("t1", "read_file", "内容"),
      failureResult("t2", "bash", "炸了"),
      assistant([text("答")]),
    ]);
    const tools = turn.steps.filter((s) => s.kind === "tool");
    expect(tools).toMatchObject([
      { id: "t1", status: "ok", result: "内容" },
      { id: "t2", status: "error", result: "炸了" },
    ]);
  });

  it("没有结果的工具（被打断）⇒ status=pending", () => {
    const [turn] = buildTranscript([
      user("问"),
      assistant([call("t1", "bash")], "aborted"),
    ]);
    expect(turn.steps[0]).toMatchObject({ kind: "tool", status: "pending" });
    expect(turn.status).toBe("aborted");
  });

  it("回合结局取最后一条助手消息的 stopReason", () => {
    const [turn] = buildTranscript([
      user("问"),
      assistant([text("出错了")], "error"),
    ]);
    expect(turn.status).toBe("error");
  });
});

describe("类别与计数", () => {
  it("工具名映射到类别；没见过的落 other", () => {
    expect(toolCategoryOf("read_file")).toBe("read");
    expect(toolCategoryOf("list_files")).toBe("read");
    expect(toolCategoryOf("grep")).toBe("search");
    expect(toolCategoryOf("web_search")).toBe("search");
    expect(toolCategoryOf("write_file")).toBe("write");
    expect(toolCategoryOf("delete_file")).toBe("write");
    expect(toolCategoryOf("bash")).toBe("command");
    expect(toolCategoryOf("web_fetch")).toBe("fetch");
    expect(toolCategoryOf("ask_user_question")).toBe("ask");
    expect(toolCategoryOf("todo_write")).toBe("plan");
    expect(toolCategoryOf("skill")).toBe("skill");
    expect(toolCategoryOf("mystery_tool")).toBe("other");
  });

  it("countByCategory 按固定顺序给计数（界面摘要就用它）", () => {
    const [turn] = buildTranscript([
      user("问"),
      assistant([
        call("a", "read_file"),
        call("b", "read_file"),
        call("c", "bash"),
        call("d", "web_search"),
      ]),
      result("a", "read_file", "1"),
      result("b", "read_file", "2"),
      result("c", "bash", "3"),
      result("d", "web_search", "4"),
      assistant([text("答")]),
    ]);
    expect(countByCategory(turn.steps)).toEqual([
      { category: "read", count: 2 },
      { category: "search", count: 1 },
      { category: "command", count: 1 },
    ]);
  });
});

describe("真实形状：16 条记录折成 1 个回合", () => {
  it("7 条助手 + 9 条结果 + 1 用户 ⇒ 1 回合、9 个工具步、1 段回答", () => {
    const messages: AgentMessage[] = [user("帮我介绍一下这个项目")];
    for (let i = 0; i < 9; i += 1) {
      messages.push(
        assistant([call(`t${i}`, "read_file", { path: `f${i}.md` })]),
      );
      messages.push(result(`t${i}`, "read_file", `内容 ${i}`));
    }
    messages.push(assistant([text("一句话结论：这是 Zustand 的源码仓库。")]));

    const turns = buildTranscript(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("帮我介绍一下这个项目");
    expect(turns[0].steps).toHaveLength(9);
    expect(turns[0].answer).toBe("一句话结论：这是 Zustand 的源码仓库。");
    expect(countByCategory(turns[0].steps)).toEqual([
      { category: "read", count: 9 },
    ]);
  });
});
