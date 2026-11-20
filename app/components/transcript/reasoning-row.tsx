"use client";

// ============================================================
// ReasoningRow —— 思考行（C58）
// ============================================================
// 职责一句话：**24px 折叠的一行「思考」，点开看完整推理。**
//
// 为什么和工具行长得像、却有自己的一套：工具行的行首是"类别标记"，思考行不是类别 ——
// 它是一条**内容**（模型的推理）。同尺度不同语义，所以不复用 ToolRow，只复用观感。
// 这也正是它单独成一个文件的原因（两家长得像但住着不欠对方的）。
// ============================================================

import { useState } from "react";
import { Markdown } from "../../markdown";
import { reasoningSummary, type ProcessStep } from "../../lib/transcript";
import styles from "./reasoning-row.module.css";

export function ReasoningRow({
  step,
  running,
}: {
  step: Extract<ProcessStep, { kind: "reasoning" }>;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const summary = reasoningSummary(step.text, running);

  return (
    <div className={styles.reason}>
      <button
        type="button"
        className={styles.reasonHead}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={styles.reasonLead} aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className={styles.reasonTitle}>思考</span>
        {/* 折叠时才给摘要：展开了正文就在下面，再留一行摘要是重复 */}
        {!open && summary !== "" && (
          <span
            className={styles.reasonSummary}
            data-running={running || undefined}
          >
            {summary}
          </span>
        )}
        {running && <span className={styles.srOnly}>正在思考</span>}
      </button>
      {open && (
        <div className={styles.reasonBody}>
          <Markdown>{step.text}</Markdown>
        </div>
      )}
    </div>
  );
}
