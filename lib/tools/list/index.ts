// ============================================================
// list_files —— 列出工作区文件
// ============================================================

import type { RegisteredTool } from "../types";
import type { EscapePermits } from "../../permission/tool-escape";
import { resolveInsideWorkspace, stringArg } from "../path-utils";
import { listFiles } from "../shared";
import { text } from "../../message";

export function createListTool(
  workspaceRoot: string,
  permits?: EscapePermits,
): RegisteredTool {
  return {
    name: "list_files",
    description:
      "列出一个目录里的文件。默认在工作空间内；确实需要列工作空间外的目录时，可以用绝对路径提出（会先向人确认）。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "目录路径：工作空间内用相对路径，默认 '.'；需要工作空间外时用绝对路径（会走一次人工确认）。",
        },
      },
    },
    async execute(args) {
      const dir = resolveInsideWorkspace(
        workspaceRoot,
        stringArg(args.path, "."),
        permits,
      );
      const entries = await listFiles(dir, workspaceRoot);
      return {
        content: [text(entries.length > 0 ? entries.join("\n") : "(空目录)")],
        details: { entries },
      };
    },
  };
}
