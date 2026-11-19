// ============================================================
// read/window —— 从整份文本里选出「这一次要显示的行」
// ============================================================
// 为什么单独成一个模块：行数上限与字节上限「谁先撞」是纯算术，
// 用字符串就能穷举边界；混进 fs 测试里，失败时分不清是逻辑错还是文件没写成。
//
// 依据是 pi 的 `truncate.ts`（commit `890f920`，`packages/coding-agent/src/core/tools/`）：
// 2000 行 / 50KB 先到先停、**不返回半行**、第一行单独超限时不给正文。
// 两处与 pi 不同，都是刻意的：
//   ① 行数只有一份算法（pi 有「按 \n 切」与「去掉末尾空行」两套，末尾带换行的
//      文件会得到 186 与 185 两个数）；这里统一用 splitLines，A-B 与 N 同源。
//   ② 提示里写 `50KB`（pi 的 formatSize 会给出 `50.0KB`），与详案措辞一致。
// ============================================================

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

export interface WindowRequest {
  content: string;
  /** 从第几行开始（1 数起）。缺省 / 非整数 / 小于 1 都收敛成 1 */
  offset?: number;
  /** 最多几行。缺省 = MAX_LINES；非正整数视为没给 */
  limit?: number;
}

export type WindowResult =
  | {
      kind: "lines";
      text: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      /** 续读提示（含 `[...]`）；读完了就是 null */
      notice: string | null;
    }
  | {
      /**
       * 起始那一行单独就超过 MAX_BYTES：整行塞进去会吃掉半截上下文，
       * 所以**不给正文**，由调用方拼一句"改用 bash 分块读"的兜底提示。
       */
      kind: "first-line-too-long";
      startLine: number;
      totalLines: number;
      firstLineBytes: number;
    };

export function selectWindow({
  content,
  offset,
  limit,
}: WindowRequest): WindowResult {
  const lines = splitLines(content);
  const totalLines = lines.length;
  const startLine = normalizeOffset(offset);

  if (totalLines === 0) {
    return {
      kind: "lines",
      text: "",
      startLine,
      endLine: startLine - 1,
      totalLines,
      notice: null,
    };
  }
  if (startLine > totalLines) {
    throw new Error(
      `Offset ${offset} is beyond end of file (${totalLines} lines total)`,
    );
  }

  const firstLineBytes = Buffer.byteLength(lines[startLine - 1], "utf8");
  if (firstLineBytes > MAX_BYTES) {
    return {
      kind: "first-line-too-long",
      startLine,
      totalLines,
      firstLineBytes,
    };
  }

  const requestedLines = normalizeLimit(limit);
  const selected: string[] = [];
  let usedBytes = 0;
  let stoppedByBytes = false;

  for (let i = startLine - 1; i < totalLines; i++) {
    if (selected.length >= (requestedLines ?? MAX_LINES)) break;
    const line = lines[i];
    // 行间分隔符也占 1 字节：算的是"拼出来之后"的体积，不是各行之和
    const lineBytes =
      Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0);
    if (usedBytes + lineBytes > MAX_BYTES) {
      stoppedByBytes = true;
      break;
    }
    selected.push(line);
    usedBytes += lineBytes;
  }

  const endLine = startLine + selected.length - 1;
  return {
    kind: "lines",
    text: selected.join("\n"),
    startLine,
    endLine,
    totalLines,
    notice: buildNotice({
      startLine,
      endLine,
      totalLines,
      stoppedByBytes,
      requestedLines,
    }),
  };
}

function buildNotice({
  startLine,
  endLine,
  totalLines,
  stoppedByBytes,
  requestedLines,
}: {
  startLine: number;
  endLine: number;
  totalLines: number;
  stoppedByBytes: boolean;
  requestedLines: number | undefined;
}): string | null {
  if (endLine >= totalLines) return null;
  const nextOffset = endLine + 1;
  if (stoppedByBytes) {
    // 措辞照 pi（`read.ts:331`）：字节撞墙时把上限写在 `of N` 后面
    return `[Showing lines ${startLine}-${endLine} of ${totalLines} (50KB limit). Use offset=${nextOffset} to continue.]`;
  }
  if (requestedLines !== undefined) {
    const remaining = totalLines - endLine;
    return `[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  }
  return `[Showing lines ${startLine}-${endLine} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
}

function normalizeOffset(offset: number | undefined): number {
  return typeof offset === "number" && Number.isInteger(offset) && offset >= 1
    ? offset
    : 1;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1
    ? limit
    : undefined;
}

/**
 * 按行切，**且末尾那个换行不算一行** —— `"a\nb\n"` 是 2 行不是 3 行。
 * 这是「A-B of N」里 N 的唯一来源：切法与计数同源，两个数字不可能对不上。
 * 空文件是 0 行（不是 1 行空串）。
 */
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}
