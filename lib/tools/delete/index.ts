// ============================================================
// delete_file —— 删除工作区文件（Phase 3，不可逆）
// ============================================================

import { rm, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { RegisteredTool } from "../types";
import type { EscapePermits } from "../../permission/tool-escape";
import { resolveInsideWorkspace, stringArg } from "../path-utils";
import { text } from "../../message";

export function createDeleteTool(
  workspaceRoot: string,
  permits?: EscapePermits,
): RegisteredTool {
  return {
    name: "delete_file",
    description:
      "删除一个文件（不可逆；调用前会弹框请你确认）。默认在工作空间内；确实需要删外面的文件时，可以用绝对路径提出（会先向人确认，且只放行这一次）。",
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

      const info = await stat(filePath).catch(() => null);

      if (!info) {
        throw new Error(`delete_file: 文件不存在：${args.path}`);
      }

      if (info.isDirectory()) {
        throw new Error(`delete_file: ${args.path} 是目录，本工具只删除文件。`);
      }

      await rm(filePath);

      return {
        content: [text(`已删除：${args.path}`)],
        details: { path: relative(workspaceRoot, filePath) },
      };
    },
  };
}
