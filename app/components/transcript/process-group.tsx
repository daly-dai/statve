"use client";

// ============================================================
// ProcessGroup —— 一个回合里的「过程组」（C57）
// ============================================================
// 职责一句话：**过程那一坨的折叠头 + 展开壳**（头上一行摘要，展开是若干条 StepView）。
//
// 两个判据住在外面（app/lib/transcript）：折没折、一条算什么类型。
// 这里只管三件事：摘要文案怎么拼、什么时候可以折、以及"用户手动开过就以他为准"。
// ============================================================

import { useState } from "react";
import { StepView } from "./step-view";
import {
  countByCategory,
  formatElapsed,
  type ProcessStep,
  type ToolCategory,
} from "../../lib/transcript";
import styles from "./process-group.module.css";

/** 类别 → 摘要里的话。一个回合只挑最多的两类说（其余在 title 里）。
 *  用 Record 而不是 switch：漏一个类别就是类型错误（穷尽性交给 tsc）。 */
const CATEGORY_LABEL: Record<ToolCategory, (count: number) => string> = {
  read: (n) => `读了 ${n} 个文件`,
  search: (n) => `搜了 ${n} 次`,
  write: (n) => `写了 ${n} 个文件`,
  command: (n) => `跑了 ${n} 条命令`,
  fetch: (n) => `取了 ${n} 页`,
  ask: (n) => `问了 ${n} 次`,
  plan: () => "更新了任务清单",
  skill: (n) => `加载了 ${n} 个技能`,
  other: (n) => `调了 ${n} 个工具`,
};

/** 摘要：按数量取前两类（多的话进 title），右侧另给步数 */
function processSummary(steps: readonly ProcessStep[]): {
  brief: string;
  full: string;
} {
  const counts = [...countByCategory(steps)].sort((a, b) => b.count - a.count);
  const labels = counts.map((entry) =>
    CATEGORY_LABEL[entry.category](entry.count),
  );
  return {
    brief: labels.slice(0, 2).join(" · "),
    full: labels.join(" · "),
  };
}

/** 进行中的那个回合：头上说"正在干什么"（比只说"正在执行"有用） */
function liveHead(steps: readonly ProcessStep[]): string {
  const running = steps.find(
    (step) => step.kind === "tool" && step.status === "pending",
  );
  if (running === undefined || running.kind !== "tool") return "正在回复…";
  return `正在执行 ${running.name}…`;
}

type ProcessGroupProps = {
  steps: readonly ProcessStep[];
  /** 进行中：头上一行说"正在…"，且不可折叠 */
  streaming: boolean;
  collapsedByDefault: boolean;
  toolOutputs: Record<string, string> | undefined;
  /** 跑完之后显示在文案末尾的用时（已格式化；缺时间戳时为空串） */
  durationLabel: string;
  /** 进行中的毫秒数（计时器；`undefined` = 还没拿到起点） */
  liveElapsedMs: number | undefined;
};

export function ProcessGroup({
  steps,
  streaming,
  collapsedByDefault,
  toolOutputs,
  durationLabel,
  liveElapsedMs,
}: ProcessGroupProps) {
  // 用户手动开/关过就以他为准；没表态时**跟着判据走** —— 所以跑完会自己折起来。
  // ⚠️ 不能写成 useState(!collapsedByDefault)：初值只在挂载时算一次，而这一轮是
  // "边跑边长"的（挂载时还没回答 ⇒ false），跑完之后判据翻成 true 也没人再读一次，
  // 于是"跑完不收、刷新才收"。派生值就没有这个坑。
  const [manual, setManual] = useState<boolean | null>(null);
  const { brief, full } = processSummary(steps);
  // 头的文案 = 读数串：段落之间用 ` · `，空的那段直接不出现
  // （所以 0 步的回合头是「12 秒」，不是「 · 12 秒」）。
  const head = (
    streaming
      ? [
          liveHead(steps),
          liveElapsedMs === undefined ? "" : formatElapsed(liveElapsedMs),
        ]
      : [brief, durationLabel]
  )
    .filter((part) => part !== "")
    .join(" · ");
  const canCollapse = !streaming && steps.length > 0;
  const open = canCollapse ? (manual ?? !collapsedByDefault) : true;

  return (
    <div className={styles.process} data-open={open}>
      <button
        type="button"
        className={styles.processHead}
        onClick={() => canCollapse && setManual(!open)}
        aria-expanded={canCollapse ? open : undefined}
        title={full}
        disabled={!canCollapse}
      >
        {/* 行首箭头：**它**才是"这行能展开"的信号（下划线是分隔，两件事别挤在一起）。
            进行中时这个槽位留空 —— 不是省事，是为了跑完那一刻文字不往左跳 20px。 */}
        <span className={styles.processLead} aria-hidden="true">
          {canCollapse && (
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2.5 4.5 6 8 9.5 4.5" />
            </svg>
          )}
        </span>
        <span className={styles.processLabel}>{head}</span>
        <span className={styles.processMeta}>{steps.length} 步</span>
      </button>
      {open && steps.length > 0 && (
        <div className={styles.processBody}>
          {steps.map((step, i) => (
            <StepView
              key={`${step.kind}-${i}`}
              step={step}
              toolOutputs={toolOutputs}
              // 只有最后一条可能是"正在长"的那条（思考在跑时才有 running 态）
              running={streaming && i === steps.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
