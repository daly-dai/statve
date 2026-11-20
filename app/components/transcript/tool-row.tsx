"use client";

// ============================================================
// ToolRow —— 过程里的一行工具调用（C57）
// ============================================================
// 职责一句话：**24px 的一行「调了什么工具」，点开才给入参 / 出参。**
//
// 为什么单独成文件：转录稿原本 480 行（AGENTS 11.9 的线是 500），
// 这一块连同它自己的三个小表（类别标记 / 状态标记 / 参数摘要）是最独立的一刀。
// 数值（24px 行 / 出参 220px 限高 + 内部滚动）对应原型
// workspace/prototype-right-pane-v5.html。
// ============================================================

import { useState } from "react";
import type { ProcessStep, ToolCategory } from "../../lib/transcript";
import styles from "./tool-row.module.css";

/** 类别在行首的两个字标记（没有图标体系时的最省做法） */
const CATEGORY_MARK: Record<ToolCategory, string> = {
  read: "读",
  search: "搜",
  write: "写",
  command: "令",
  fetch: "取",
  ask: "问",
  plan: "计",
  skill: "技",
  other: "·",
};

/** 状态标记：✓ 成功 / ✗ 失败 / … 还没有结果 */
const STATUS_MARK: Record<"ok" | "error" | "pending", string> = {
  ok: "✓",
  error: "✗",
  pending: "…",
};

/** 参数摘要：行上只给最关键的几项，别把整坨 JSON 摊在 24px 里 */
function argBrief(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const first = keys[0];
  const value = args[first];
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, 60);
}

type ToolRowProps = {
  step: Extract<ProcessStep, { kind: "tool" }>;
  /** 还在跑的那一步的实时输出（bash） */
  live: string | undefined;
};

export function ToolRow({ step, live }: ToolRowProps) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const output = step.result || live || "";
  const lines = output === "" ? 0 : output.split("\n").length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用就算了：内容在下面，手选也能复制 */
    }
  };

  return (
    <div>
      <button
        type="button"
        className={styles.step}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-status={step.status}
      >
        <span className={styles.stepCat} aria-hidden="true">
          {CATEGORY_MARK[step.category]}
        </span>
        <span className={styles.stepName}>{step.name}</span>
        <span className={styles.stepArg}>{argBrief(step.args)}</span>
        <span className={styles.stepStatus}>
          {STATUS_MARK[step.status]}
          {lines > 0 && <span className={styles.stepLines}>{lines} 行</span>}
        </span>
      </button>

      {open && (
        <div className={styles.stepBody}>
          <div>
            {Object.entries(step.args).map(([key, value]) => (
              <div key={key} className={styles.kvRow}>
                <span className={styles.kvKey}>{key}</span>
                <span className={styles.kvValue}>
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>
          <div className={styles.stepTools}>
            <button
              type="button"
              className={styles.ghost}
              onClick={() => setRaw(!raw)}
            >
              {raw ? "收起原始 JSON" : "原始 JSON"}
            </button>
            {output !== "" && (
              <button type="button" className={styles.ghost} onClick={copy}>
                {copied ? "已复制" : "复制全文"}
              </button>
            )}
          </div>
          {raw && (
            <pre className={styles.raw}>
              {JSON.stringify(step.args, null, 2)}
            </pre>
          )}
          {output !== "" && <pre className={styles.out}>{output}</pre>}
        </div>
      )}
    </div>
  );
}
