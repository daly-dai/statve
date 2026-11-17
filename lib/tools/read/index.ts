// ============================================================
// read_file —— 读取工作区文件（长内容截断）
// ============================================================

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { RegisteredTool } from "../types";
import type { EscapePermits } from "../../permission/tool-escape";
import { resolveInsideWorkspace, stringArg } from "../path-utils";
import { truncate } from "../shared";
import { text } from "../../message";

export function createReadTool(
  workspaceRoot: string,
  permits?: EscapePermits,
): RegisteredTool {
  return {
    name: "read_file",
    description:
      "读取一个 UTF-8 文本文件。默认在工作空间内；确实需要工作空间外的文件时，可以直接用绝对路径提出（会先向人确认，且只放行这一次）。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "文件路径：工作空间内用相对路径；需要工作空间外时用绝对路径（会走一次人工确认）。",
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
      const content = await readFile(filePath, "utf8");
      return {
        content: [text(truncate(content, 1800))],
        details: { path: relative(workspaceRoot, filePath) },
      };
    },
  };
}
