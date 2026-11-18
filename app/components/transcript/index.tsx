"use client";

// ============================================================
// Transcript —— 右栏的转录稿：一次对话 = 一个回合（C57 P1）
// ============================================================
// 数据形状在 app/lib/transcript（纯函数）：一个回合 = 用户那句话 + 过程 + 最终回答。
// 这里只回答"长什么样"，判据一个都不住在这：
//   · 过程折叠与否 —— 有最终回答就折；进行中 / 打入 / 失败 / 只有工具没回答 ⇒ 展开
//   · 工具行 24px，点开才看入参/出参（出参 220px 限高 + 滚动）
// 详案：doc/plan/chat-surface-dsh-alignment.md 4.13
// ============================================================

import { useState } from "react";
import { Markdown } from "../../markdown";
import { SkillCard } from "../skill-card";
import {
  countByCategory,
  formatElapsed,
  shouldCollapseProcess,
  type ProcessStep,
  type ToolCategory,
  type TranscriptTurn,
} from "../../lib/transcript";
import { useElapsed } from "../../lib/use-elapsed";
import styles from "./transcript.module.css";

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

function ToolRow({ step, live }: ToolRowProps) {
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
    <div className={styles.stepBlock}>
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
          <div className={styles.kv}>
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

/** 过程里的一条：工具 / 中途叙述 / 非对话记录（三选一，各自渲染） */
function StepView({
  step,
  toolOutputs,
}: {
  step: ProcessStep;
  toolOutputs: Record<string, string> | undefined;
}) {
  if (step.kind === "tool") {
    return <ToolRow step={step} live={toolOutputs?.[step.id]} />;
  }
  if (step.kind === "text") {
    return <p className={styles.processText}>{step.text}</p>;
  }
  if (step.note === "skill" && step.name !== undefined) {
    return <SkillCard name={step.name} payload={step.text} />;
  }
  return <span className={styles.noteLabel}>{step.label}</span>;
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

function ProcessGroup({
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 回答底部的动作行（C61）：对**已经生成的内容**做事 —— 悬停才现，不占读者的注意力。
 *  尺寸抄 pi-web（`MessageView.tsx:512-553`）：22px 高 / 11px 字 / ✓ 反馈 1.5s；但命中区
 *  按本项目 `--hit: 34px` 的判据用 ::before 撑到 32（视觉 22，点得到 32）。 */
function AnswerActions({
  answer,
  persistent,
}: {
  answer: string;
  /** 被打断 / 失败的回合：常驻（那时人更可能要把已有内容拿走） */
  persistent: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      // 复制的是 markdown 原文（不是渲染后的文字）：粘贴回编辑器还能直接用
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用就算了：内容在上面，手选也能复制 */
    }
  };

  return (
    <div className={styles.answerRow} data-persistent={persistent || undefined}>
      <div className={styles.answerActs}>
        <button
          type="button"
          className={styles.act}
          onClick={copy}
          data-copied={copied || undefined}
          aria-label={copied ? "已复制" : "复制这条回答"}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {copied ? (
              <polyline points="20 6 9 17 4 12" />
            ) : (
              <>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </>
            )}
          </svg>
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
    </div>
  );
}

type TranscriptProps = {
  turns: readonly TranscriptTurn[];
  /** 本轮 run 还在跑：最后一回合不折叠 */
  streaming: boolean;
  toolOutputs: Record<string, string> | undefined;
  /** 本轮 run 的本机起点（计时器用；`undefined` = 没有起点就不显示钟） */
  liveSince: number | undefined;
};

export function Transcript({
  turns,
  streaming,
  toolOutputs,
  liveSince,
}: TranscriptProps) {
  // 只有最后一回合可能是"在跑"，所以这里只需要一个计时器。
  // ⚠️ 必须提到 map 外面：hooks 不能写在循环里。
  const liveElapsedMs = useElapsed(streaming ? liveSince : undefined);

  return (
    <>
      {turns.map((turn, index) => {
        const isLast = index === turns.length - 1;
        const live = streaming && isLast;
        // 判据住在 app/lib/transcript（纯函数，可单测）：有回答 + ok + 不在跑 ⇒ 折
        const collapsed = shouldCollapseProcess(turn, live);
        // 跑完才有「这一轮花了多久」；缺时间戳（老数据）就是空串，界面什么都不显示。
        // 格式与进行中的计时器**同一个函数**（用户 2026-11-18 定：一屏里不许有两种写法）
        const durationLabel =
          turn.durationMs === undefined ? "" : formatElapsed(turn.durationMs);
        return (
          <section
            key={turn.index}
            className={styles.turn}
            data-live={live || undefined}
          >
            {turn.prompt !== "" && (
              <div className={styles.say}>
                <p className={styles.bubble}>{turn.prompt}</p>
              </div>
            )}
            <ProcessGroup
              steps={turn.steps}
              streaming={live}
              collapsedByDefault={collapsed}
              toolOutputs={live ? toolOutputs : undefined}
              durationLabel={durationLabel}
              liveElapsedMs={live ? liveElapsedMs : undefined}
            />
            {turn.answer !== "" && (
              <>
                <div className={styles.answer}>
                  <Markdown>{turn.answer}</Markdown>
                </div>
                <AnswerActions
                  answer={turn.answer}
                  persistent={turn.status !== "ok"}
                />
              </>
            )}
            {!live &&
              turn.answer === "" &&
              turn.status === "ok" &&
              turn.steps.length > 0 && (
                <p className={styles.note}>本轮没有产出回答</p>
              )}
            {!live && turn.status !== "ok" && (
              <p className={styles.note}>
                {turn.status === "error" ? "本轮失败" : "本轮被停止"}
              </p>
            )}
          </section>
        );
      })}
    </>
  );
}
