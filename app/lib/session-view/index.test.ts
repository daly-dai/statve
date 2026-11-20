import { describe, expect, it } from "vitest";
import { hasConversation, labelOfSession } from "./index";

// 夹具理由：这三条就是 /api/sessions 真实会返回的三种形状 ——
// 改过名的（有 title）、没改过名但有内容的（只有 preview）、刚建的（两个都没有）。
const RENAMED = { id: "a", title: "拆页面", preview: "第一句话" };
const UNTITLED = { id: "b", preview: "第一句话" };
const FRESH = { id: "c" };
const LIST = [RENAMED, UNTITLED, FRESH];

describe("labelOfSession", () => {
  it("有标题就用标题（哪怕已有首条消息）", () => {
    expect(labelOfSession(LIST, "a")).toBe("拆页面");
  });

  it("没标题就退回首条消息 —— 和侧栏那一行同一条链", () => {
    expect(labelOfSession(LIST, "b")).toBe("第一句话");
  });

  it("刚建的会话两个都没有 → 空串（由调用处决定怎么显示）", () => {
    expect(labelOfSession(LIST, "c")).toBe("");
  });

  it("列表里查不到 → 空串，不抛", () => {
    expect(labelOfSession(LIST, "gone")).toBe("");
  });
});

describe("hasConversation", () => {
  it("本次已经加载到消息 → 有（哪怕列表里还没有 preview）", () => {
    expect(hasConversation(LIST, "c", 2)).toBe(true);
  });

  it("服务端已有首条消息 → 有（进页面就有，不会闪一下才出现 tab）", () => {
    expect(hasConversation(LIST, "b", 0)).toBe(true);
  });

  it("刚建的会话、也没有消息 → 没有（tab 不该出现）", () => {
    expect(hasConversation(LIST, "c", 0)).toBe(false);
  });

  it("列表里查不到、也没有消息 → 没有", () => {
    expect(hasConversation(LIST, "gone", 0)).toBe(false);
  });
});
