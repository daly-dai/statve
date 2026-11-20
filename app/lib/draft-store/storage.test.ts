import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eraseDraft, readAllDrafts, writeDraft } from "./storage";

/**
 * 最小的 localStorage 桩：只实现这个模块用到的四个成员。
 *
 * 为什么允许手造（AGENTS 11.5 的夹具纪律）：这里测的**正是**"与浏览器 API 对齐"
 * 这一层，而 node 里没有真的 localStorage（Chromium 里跑不到单测）。
 * 桩的语义照 MDN：setItem 覆盖同名键、removeItem 删键、key(i) 反映当前顺序。
 * 单测覆盖的是"我们的键名 / 空串删键 / 前缀过滤"，不是浏览器实现本身。
 */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  } as Storage;
}

let storage: Storage;

beforeEach(() => {
  storage = makeStorage();
  // 模块里判的是 `typeof window === "undefined"`，所以造一个最小的 window 就够
  (globalThis as { window?: unknown }).window = { localStorage: storage };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("writeDraft / readAllDrafts", () => {
  it("写进去能读回来，且按会话分开", () => {
    writeDraft("a", "你好");
    writeDraft("b", "在吗");
    expect(readAllDrafts()).toEqual({ a: "你好", b: "在吗" });
  });

  it("只认 composer:draft: 前缀 —— 别人的键（如 todoPanel）不会被读成草稿", () => {
    // 真实场景：同一个 localStorage 里还躺着 task-panel 的关闭标记
    storage.setItem("todoPanel:dismissed:a", "1");
    writeDraft("a", "你好");
    expect(readAllDrafts()).toEqual({ a: "你好" });
  });

  it("空串 = 删键（不留一个空壳键）", () => {
    writeDraft("a", "你好");
    writeDraft("a", "");
    expect(storage.getItem("composer:draft:a")).toBeNull();
    expect(readAllDrafts()).toEqual({});
  });

  it("没有会话 id 时不写（不攒 'composer:draft:' 这种无主键）", () => {
    writeDraft("", "还没选中会话时打的字");
    expect(readAllDrafts()).toEqual({});
  });
});

describe("eraseDraft", () => {
  it("删掉该会话的键，别的会话不受影响", () => {
    writeDraft("a", "你好");
    writeDraft("b", "在吗");
    eraseDraft("a");
    expect(readAllDrafts()).toEqual({ b: "在吗" });
  });
});

describe("服务端（没有 window）", () => {
  it("读返回空表、写与删都不抛 —— 服务端预渲染走到这里不能崩", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(readAllDrafts()).toEqual({});
    expect(() => writeDraft("a", "你好")).not.toThrow();
    expect(() => eraseDraft("a")).not.toThrow();
  });
});
