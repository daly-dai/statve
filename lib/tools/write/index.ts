// ============================================================
// write_file —— 写任意工作区文件（Phase 3）
// ============================================================

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { RegisteredTool } from "../types";
import type { EscapePermits } from "../../permission/tool-escape";
import { resolveInsideWorkspace, stringArg } from "../path-utils";
import { isDirectory } from "../shared";
import { text } from "../../message";

export function createWriteTool(
  workspaceRoot: string,
  permits?: EscapePermits,
): RegisteredTool {
  return {
    name: "write_file",
    description:
      "写一个文件（不存在则创建，父目录自动创建）。默认写在工作空间内；确实需要写到外面时，可以用绝对路径提出（会先向人确认，且只放行这一次）。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "文件路径：工作空间内用相对路径；需要工作空间外时用绝对路径（会走一次人工确认）。",
        },
        content: {
          type: "string",
          description: "要写入的完整内容。",
        },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      // 解析文件路径，沙箱
      const filePath = resolveInsideWorkspace(
        workspaceRoot,
        stringArg(args.path, ""),
        permits,
      );
      // 目标是已存在目录 → 报错：写文件却指向目录，说明路径理解错了
      if (await isDirectory(filePath)) {
        throw new Error(`write_file: ${args.path} 是一个目录，无法写入。`);
      }
      // 创建目录
      await mkdir(dirname(filePath), { recursive: true });
      // 写文件
      await writeFile(filePath, stringArg(args.content, ""), "utf8");
      // 返回结果
      return {
        content: [text(relative(workspaceRoot, filePath))],
        details: { path: relative(workspaceRoot, filePath) },
      };
    },
  };
}
