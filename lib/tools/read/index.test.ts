// ============================================================
// read.test.ts —— read_file（fs 工具层）
// ============================================================
// 窗口选择的边界住在 window/index.test.ts（纯字符串）；这里只测「真读盘」
// 那一层：8MB 护栏、越界报错、以及详案 §五 的五条验收走一遍真管道。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadTool } from ".";
import {
  createFixtureWorkspace,
  destroyFixtureWorkspace,
} from "../test-fixtures";

let root: string;
let tool: ReturnType<typeof createReadTool>;

beforeAll(async () => {
  root = await createFixtureWorkspace();
  tool = createReadTool(root);
});

afterAll(async () => {
  await destroyFixtureWorkspace(root);
});

/** 取第一个 text 块的内容（每次都要判类型，索性封装一次） */
async function readText(args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute(args);
  const block = result.content[0];
  if (block.type !== "text") throw new Error("期望 text 块");
  return block.text;
}

/** 造 n 行文本；第 i 行带编号，便于断言「从第几行开始」 */
function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("read_file", () => {
  it("读取文件内容", async () => {
    const result = await tool.execute({ path: "a.txt" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "hello world",
    });
  });

  it("嵌套路径读取", async () => {
    expect(await readText({ path: "notes/b.md" })).toContain("# Title");
  });

  it("185 行的文件一次读完，不出现续读提示", async () => {
    await writeFile(join(root, "vanilla.txt"), makeLines(185), "utf8");
    const text = await readText({ path: "vanilla.txt" });
    expect(text).toContain("line 1\n");
    expect(text).toContain("line 185");
    expect(text).not.toContain("[Showing lines");
  });

  it("offset=86 从第 86 行读起，读到文件尾不加提示", async () => {
    const text = await readText({ path: "vanilla.txt", offset: 86 });
    expect(text.startsWith("line 86\n")).toBe(true);
    expect(text).toContain("line 185");
    expect(text).not.toContain("[Showing lines");
  });

  it("2500 行的文件给前 2000 行，并说清从哪接着读", async () => {
    await writeFile(join(root, "big.txt"), makeLines(2500), "utf8");
    const text = await readText({ path: "big.txt" });
    expect(text).toContain("line 2000");
    expect(text).not.toContain("line 2001");
    expect(text).toContain(
      "[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]",
    );
  });

  it("offset 越界时报错，错误里带总行数", async () => {
    await expect(
      tool.execute({ path: "vanilla.txt", offset: 9999 }),
    ).rejects.toThrow("Offset 9999 is beyond end of file (185 lines total)");
  });

  it("超过 8MB 的文件报错，并指向 bash 分块读", async () => {
    const tooBig = "x".repeat(8 * 1024 * 1024 + 1);
    await writeFile(join(root, "huge.txt"), tooBig, "utf8");
    await expect(tool.execute({ path: "huge.txt" })).rejects.toThrow(
      /8MB[\s\S]*bash/,
    );
  });

  it("单行超过 50KB 时不给正文，给兜底写法", async () => {
    const oneHugeLine = "y".repeat(60 * 1024);
    await writeFile(join(root, "single-line.txt"), oneHugeLine, "utf8");
    const text = await readText({ path: "single-line.txt" });
    expect(text).toContain("超过 read_file 的 50KB 单行上限");
    expect(text).toContain("bash");
  });

  it("文件不存在抛错", async () => {
    await expect(tool.execute({ path: "no-such.txt" })).rejects.toThrow();
  });

  it("越界路径抛错", async () => {
    await expect(tool.execute({ path: "../outside.txt" })).rejects.toThrow(
      /路径越界/,
    );
  });
});
