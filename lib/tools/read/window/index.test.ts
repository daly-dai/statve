// ============================================================
// window/index.test.ts —— 读窗口选择的纯逻辑（不碰 fs）
// ============================================================
// 为什么单独测它：行数上限与字节上限「谁先撞」是纯算术，用字符串就能穷举；
// 混进 fs 测试里，失败时分不清是逻辑错还是文件没写成。

import { describe, expect, it } from "vitest";
import { MAX_BYTES, selectWindow } from ".";
import type { WindowResult } from ".";

/** 造 n 行文本（第 i 行 = `${prefix} ${i}`），行间用 \n，末尾不加换行 */
function makeLines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join(
    "\n",
  );
}

/** 断言成「行窗口」那一支（否则给出实际 kind，报错能直接看出是哪个分支） */
function asLines(result: WindowResult) {
  if (result.kind !== "lines") {
    throw new Error(`期望 kind=lines，实际是 ${result.kind}`);
  }
  return result;
}

describe("selectWindow", () => {
  it("整份文件读完时不加任何提示", () => {
    const result = asLines(selectWindow({ content: makeLines(185) }));
    expect(result.totalLines).toBe(185);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(185);
    expect(result.notice).toBeNull();
    expect(result.text.startsWith("line 1\n")).toBe(true);
    expect(result.text.endsWith("line 185")).toBe(true);
  });

  it("offset 从 1 数起：offset=86 时第一行就是第 86 行", () => {
    const result = asLines(
      selectWindow({ content: makeLines(185), offset: 86 }),
    );
    expect(result.startLine).toBe(86);
    expect(result.endLine).toBe(185);
    expect(result.text.startsWith("line 86\n")).toBe(true);
    expect(result.notice).toBeNull();
  });

  it("超过 2000 行时给前 2000 行，并说清从哪接着读", () => {
    const result = asLines(selectWindow({ content: makeLines(2500) }));
    expect(result.endLine).toBe(2000);
    expect(result.notice).toBe(
      "[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]",
    );
  });

  it("offset 越界时报错，并把总行数带上", () => {
    expect(() =>
      selectWindow({ content: makeLines(185), offset: 9999 }),
    ).toThrow("Offset 9999 is beyond end of file (185 lines total)");
  });

  it("用户给了 limit 时，提示改成「还剩几行」", () => {
    const result = asLines(
      selectWindow({ content: makeLines(250), limit: 10 }),
    );
    expect(result.endLine).toBe(10);
    expect(result.notice).toBe(
      "[240 more lines in file. Use offset=11 to continue.]",
    );
  });

  it("字节上限先到先停，提示里标明 50KB", () => {
    const content = makeLines(100, "x".repeat(990));
    const result = asLines(selectWindow({ content }));
    expect(result.totalLines).toBe(100);
    expect(result.endLine).toBeLessThan(100);
    expect(result.endLine).toBeGreaterThan(10);
    expect(result.notice).toContain("(50KB limit)");
    expect(result.notice).toContain("of 100");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      MAX_BYTES,
    );
  });

  it("第一行单独就超过字节上限时不给正文", () => {
    const result = selectWindow({ content: "x".repeat(MAX_BYTES + 1024) });
    expect(result.kind).toBe("first-line-too-long");
    if (result.kind !== "first-line-too-long") return;
    expect(result.firstLineBytes).toBe(MAX_BYTES + 1024);
    expect(result.totalLines).toBe(1);
  });

  it("offset 小于 1 或不是整数时收敛成 1", () => {
    const content = makeLines(10);
    expect(asLines(selectWindow({ content, offset: 0 })).startLine).toBe(1);
    expect(asLines(selectWindow({ content, offset: -5 })).startLine).toBe(1);
    expect(asLines(selectWindow({ content, offset: 2.7 })).startLine).toBe(1);
  });

  it("文件末尾的换行不多算一行", () => {
    expect(asLines(selectWindow({ content: "a\nb\n" })).totalLines).toBe(2);
    expect(asLines(selectWindow({ content: "a\nb" })).totalLines).toBe(2);
  });

  it("空文件返回空正文，不报错", () => {
    const result = asLines(selectWindow({ content: "" }));
    expect(result.totalLines).toBe(0);
    expect(result.text).toBe("");
    expect(result.notice).toBeNull();
  });

  it("从中间读到结尾时，提示里的 A 是 offset 而不是 1", () => {
    const result = asLines(
      selectWindow({ content: makeLines(2500), offset: 1001 }),
    );
    expect(result.startLine).toBe(1001);
    expect(result.endLine).toBe(2500);
    expect(result.notice).toBeNull();
  });

  it("从中间开始、又撞上上限时，提示里的 A-B 都是真实行号", () => {
    const result = asLines(
      selectWindow({ content: makeLines(3000), offset: 501 }),
    );
    expect(result.startLine).toBe(501);
    expect(result.endLine).toBe(2500);
    expect(result.notice).toBe(
      "[Showing lines 501-2500 of 3000. Use offset=2501 to continue.]",
    );
  });
});
