import { describe, expect, it } from "vitest";
import { draftOf, dropDraft, setDraft, type Drafts } from "./index";

const EMPTY: Drafts = {};

describe("draftOf", () => {
  it("没有键就是空串（不是 undefined，调用处不必再兜）", () => {
    expect(draftOf(EMPTY, "a")).toBe("");
  });
});

describe("setDraft", () => {
  it("不同会话各自记住 —— 这是整个功能的判据", () => {
    // 夹具理由：a / b 就是真实会话 id 的形状（useSessions 给的 id），
    // "在 a 打一半切到 b"就是这两个键先后出现。
    const drafts = setDraft(setDraft(EMPTY, "a", "你好"), "b", "在吗");
    expect(draftOf(drafts, "a")).toBe("你好");
    expect(draftOf(drafts, "b")).toBe("在吗");
  });

  it("同一个会话后写赢（覆盖，不是追加）", () => {
    const drafts = setDraft(setDraft(EMPTY, "a", "你"), "a", "你好");
    expect(draftOf(drafts, "a")).toBe("你好");
  });

  it("文字没变时返回同一个对象（引用相等，避免无谓重渲染）", () => {
    const drafts = setDraft(EMPTY, "a", "你好");
    expect(setDraft(drafts, "a", "你好")).toBe(drafts);
  });

  it("没有会话（空 id）时不写 —— 不攒幽灵键", () => {
    const drafts = setDraft(EMPTY, "", "还没选中会话时打的字");
    expect(drafts).toBe(EMPTY);
    expect(Object.keys(drafts)).toHaveLength(0);
  });
});

describe("dropDraft", () => {
  it("发送成功清掉该会话，别的会话不受影响", () => {
    // 真实组合：a 发出去的同时，b 里可能还留着没发完的草稿
    const drafts = dropDraft(
      setDraft(setDraft(EMPTY, "a", "你好"), "b", "在吗"),
      "a",
    );
    expect(draftOf(drafts, "a")).toBe("");
    expect(draftOf(drafts, "b")).toBe("在吗");
  });

  it("本来就是空的 → 引用都不换（幂等）", () => {
    expect(dropDraft(EMPTY, "a")).toBe(EMPTY);
    const one = setDraft(EMPTY, "a", "你好");
    expect(dropDraft(one, "b")).toBe(one);
  });

  it("会话被删时它的草稿一起没了（草稿不给会话保命）", () => {
    const drafts = dropDraft(setDraft(EMPTY, "gone", "没发出去的字"), "gone");
    expect(draftOf(drafts, "gone")).toBe("");
    expect(Object.keys(drafts)).toHaveLength(0);
  });
});
