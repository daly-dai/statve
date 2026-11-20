import { describe, expect, it } from "vitest";
import { emptyAttr, stageDataOf, stageModeOf } from "./index";

describe("stageModeOf", () => {
  it("有会话就是 session —— 哪怕会话列表正在刷新", () => {
    // 这个夹具的每个值都是真的会发生的组合：refresh() 期间 useSessions
    // 的 loading 会短暂为 true，而 currentId 已经有值。两者同时成立。
    expect(stageModeOf("s1", true)).toBe("session");
    expect(stageModeOf("s1", false)).toBe("session");
  });

  it("没有会话 + 列表还没回来 = loading（首屏什么都不画）", () => {
    // 刷新页面那一瞬：currentId 还是空串，useSessions 的 loading 初值是 true
    expect(stageModeOf("", true)).toBe("loading");
  });

  it("没有会话 + 列表已回来 = no-session（这时才画那句话）", () => {
    // 删掉最后一个会话、或一个工作空间都没有：列表已到，里面是空的
    expect(stageModeOf("", false)).toBe("no-session");
  });
});

describe("stageDataOf", () => {
  it("加载中与无会话都只给 data-nosession", () => {
    for (const mode of ["loading", "no-session"] as const) {
      expect(stageDataOf(mode, true)).toEqual({ nosession: "" });
      // tabs / empty 必须是 undefined：同时写会让两条布局规则抢同一件事
      expect(stageDataOf(mode, false).tabs).toBeUndefined();
    }
  });

  it("有会话且是新会话：不给 tab，且是空态布局", () => {
    expect(stageDataOf("session", false)).toEqual({
      tabs: "none",
      empty: "",
    });
  });

  it("有会话且有对话：三个属性一个都不写", () => {
    expect(stageDataOf("session", true)).toEqual({
      tabs: undefined,
      empty: undefined,
    });
  });
});

describe("emptyAttr", () => {
  it("空态写空串，有对话不写（CSS 认属性在不在，不认值）", () => {
    expect(emptyAttr(false)).toBe("");
    expect(emptyAttr(true)).toBeUndefined();
  });
});
