// ============================================================
// read_file —— 读取工作区文件（支持按行区间读）
// ============================================================
// 为什么有 offset/limit：以前固定只给前 1,800 字符，`zustand/src/vanilla.ts`
// （185 行 / 5,799 字符）只显示 33%，且不说总共多少行、从哪接着读 ⇒ 模型只能
// 去调 `bash`，而 `bash` 每次都要人点批准（2026-11-18 真机：一个会话 6 次弹框）。
// ⇒ 弹框不是审批策略的问题，是「读」这个动作被逼进了需要审批的那条路。
//
// 行窗口的取舍（2000 行 / 50KB 先到先停、各种续读提示）住在 ./window，
// 那部分是纯算术，单测不需要真文件。

import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { RegisteredTool } from "../types";
import type { EscapePermits } from "../../permission/tool-escape";
import { resolveInsideWorkspace, stringArg } from "../path-utils";
import { text } from "../../message";
import { MAX_BYTES, selectWindow } from "./window";

/**
 * 单文件硬上限。pi 用流式读绕开这个数；我们是一次性 `readFile` 进内存，
 * 一个 1GB 的单行文件会把 Node 打爆 —— 所以超了直接拒绝并指路。
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function createReadTool(
  workspaceRoot: string,
  permits?: EscapePermits,
): RegisteredTool {
  return {
    name: "read_file",
    description:
      "读取一个 UTF-8 文本文件。默认在工作空间内；确实需要工作空间外的文件时，可以直接用绝对路径提出（会先向人确认，且只放行这一次）。大文件可以按行区间分段读（offset / limit）。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "文件路径：工作空间内用相对路径；需要工作空间外时用绝对路径（会走一次人工确认）。",
        },
        offset: {
          type: "number",
          description: "从第几行开始读（1 数起）。默认 1。",
        },
        limit: {
          type: "number",
          description: "最多读几行。默认读到上限（2000 行 / 50KB，先到先停）。",
        },
      },
      required: ["path"],
    },
    async execute(args) {
      const filePath = resolveInsideWorkspace(
        workspaceRoot,
        stringArg(args.path, ""),
        permits,
      );
      const relPath = relative(workspaceRoot, filePath);

      const size = (await stat(filePath)).size;
      if (size > MAX_FILE_BYTES) {
        throw new Error(
          `文件 ${inMb(size)}，超过 read_file 的 8MB 上限；请用 bash 分块读取（Get-Content -TotalCount / -Skip）。`,
        );
      }

      const window = selectWindow({
        content: await readFile(filePath, "utf8"),
        offset: optionalNumber(args.offset),
        limit: optionalNumber(args.limit),
      });

      if (window.kind === "first-line-too-long") {
        return {
          content: [
            text(
              longLineNotice(relPath, window.startLine, window.firstLineBytes),
            ),
          ],
          details: { path: relPath },
        };
      }

      const body = window.notice
        ? `${window.text}\n\n${window.notice}`
        : window.text;
      return {
        content: [text(body)],
        details: {
          path: relPath,
          startLine: window.startLine,
          endLine: window.endLine,
          totalLines: window.totalLines,
        },
      };
    },
  };
}

/** 第一行/起始行单独就超过 50KB —— 不给正文，给一条能照做的兜底命令（pwsh） */
function longLineNotice(path: string, line: number, bytes: number): string {
  return `[第 ${line} 行单独就有 ${inKb(bytes)}，超过 read_file 的 ${MAX_BYTES / 1024}KB 单行上限，整行返回会吃掉大段上下文。请改用 bash 分块读：Get-Content '${path}' -TotalCount ${line} | Select-Object -Last 1 | ForEach-Object { $_.Substring(0, 2000) }]`;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function inKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function inMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
