"use client";

// ============================================================
// StepView —— 过程里的"一条"：按 kind 分派到各自的渲染（C57）
// ============================================================
// 职责一句话：**手里有一条 ProcessStep，决定它长什么样。**
//
// 四种：工具行（ToolRow）/ 思考行（ReasoningRow）/ 中途叙述（正文段落）/
// 非对话记录（技能卡片 or 一行标签）。这一层很薄，但它把"分派"这件事
// 从过程组里拿出来了 —— 否则过程组要同时管折叠状态和四种渲染。
// ============================================================

import { SkillCard } from "../skill-card";
import { ReasoningRow } from "./reasoning-row";
import { ToolRow } from "./tool-row";
import type { ProcessStep } from "../../lib/transcript";
import styles from "./step-view.module.css";

export function StepView({
  step,
  toolOutputs,
  running,
}: {
  step: ProcessStep;
  toolOutputs: Record<string, string> | undefined;
  /** 是不是"正在跑的最后一条"（只有它显示进行中的态） */
  running: boolean;
}) {
  if (step.kind === "tool") {
    return <ToolRow step={step} live={toolOutputs?.[step.id]} />;
  }
  if (step.kind === "reasoning") {
    return <ReasoningRow step={step} running={running} />;
  }
  if (step.kind === "text") {
    return <p className={styles.processText}>{step.text}</p>;
  }
  if (step.note === "skill" && step.name !== undefined) {
    return <SkillCard name={step.name} payload={step.text} />;
  }
  return <span className={styles.noteLabel}>{step.label}</span>;
}
