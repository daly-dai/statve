"use client";

// ============================================================
// 审批卡片 —— 写/改/删工具 + bash 的人工确认（Phase 3）
// ============================================================
// 布局抄 Reasonix 的确认卡片（internal/serve/index.html）：
//   嵌在底部决策区（不打断，像一条待办卡片），不是居中弹框——
//   header（警告图标 + 标题）→ subject（工具 + 参数代码块）→
//   actions（按钮带快捷键徽标，键盘可操作）。
//
// ⭐ 两个动作（2026-11-17，C55 补记 14）：
//   允许(Y)   放行这一次
//   拒绝(N)   拦截这次调用
//   以前还有「本会话允许(A)」「一直允许(P)」两档，随"审批记忆"一起删了：
//   按工具名记住"允许"太粗 —— 人当时看的是那一个路径/那一条命令，记住的却是
//   整个工具。想整轮不被打断 → 用上方的**审批模式**（YOLO），那是运行时状态，
//   重启即恢复，语义比"记住这个工具"清楚。
//
// 快捷键：Y/N（Esc = 拒绝）。输入框聚焦时不响应（不抢用户的输入）。
// ============================================================

import { useEffect } from "react";
import type { ToolApprovalRequest } from "../../lib/use-agent-run";
import { isEditableTarget, isPlainKey } from "../../lib/keys";
import styles from "./approval-dialog.module.css";

/** 用户对一次确认的决定：只有"允许这一次 / 拒绝" */
export type ApprovalDecision = {
  allow: boolean;
};

type ApprovalDialogProps = {
  request: ToolApprovalRequest | null;
  onApprove: (decision: ApprovalDecision) => void;
};

export function ApprovalDialog({ request, onApprove }: ApprovalDialogProps) {
  // 键盘快捷键（抄 Reasonix：卡片出现期间 Y/N 可操作；
  // 输入框/文本域聚焦时不抢键——用户可能在打字）
  useEffect(() => {
    if (!request) return undefined;
    const onKey = (e: KeyboardEvent) => {
      // 前置判定提炼到 app/lib/keys.ts（纯函数层，可单测）：
      // 修饰键组合让路、焦点在编辑区让路（用户在打字，不抢键）
      if (!isPlainKey(e)) return;
      if (isEditableTarget(e.target as HTMLElement | null)) return;
      const k = e.key.toLowerCase();
      if (k === "y") {
        e.preventDefault();
        onApprove({ allow: true });
      } else if (k === "n" || k === "escape") {
        e.preventDefault();
        onApprove({ allow: false });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [request, onApprove]);

  if (!request) return null;

  // bash 工具：把命令从 JSON 壳里提取出来单独渲染（大字、代码样式），
  // 其他工具才渲染完整 JSON——命令是"要执行的动作"，值得单独看
  const isBash = request.toolName === "bash";
  // 越界（C55）：显示绝对路径、换危险配色、说清"只对这几条路径生效一次"
  const outside = request.danger?.kind === "outside-workspace";
  const targets = request.danger?.targets ?? [];
  const bashCommand =
    isBash && typeof request.args.command === "string"
      ? request.args.command
      : "";

  return (
    <div
      className={
        outside
          ? `${styles.approvalCard} ${styles.danger}`
          : styles.approvalCard
      }
      role="alertdialog"
      aria-modal="false"
    >
      <div className={styles.approvalHeader}>
        <svg
          className={styles.approvalIcon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className={styles.approvalTitle}>
          {outside ? "越界操作，需要确认" : "需要人工确认"}
        </span>
      </div>

      <div className={styles.approvalSubject}>
        <span className={styles.approvalTool}>{request.toolName}</span>
        {bashCommand ? (
          <pre className={styles.approvalCommand}>{bashCommand}</pre>
        ) : (
          <pre className={styles.approvalArgs}>
            {JSON.stringify(request.args, null, 2)}
          </pre>
        )}
      </div>

      {outside ? (
        <div className={styles.dangerNote}>
          <p className={styles.dangerLead}>
            这次调用要碰<strong>工作空间之外</strong>
            的东西。批准只对下面这些路径生效一次。
          </p>
          <ul className={styles.dangerTargets}>
            {targets.map((target) => (
              <li key={target}>{target}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.approvalActions}>
        <button
          className={`${styles.approvalBtn} ${styles.approvalAllow}`}
          type="button"
          onClick={() => onApprove({ allow: true })}
        >
          <span className={styles.approvalKey}>Y</span>
          {outside ? "仍要执行" : "允许"}
        </button>
        <button
          className={`${styles.approvalBtn} ${styles.approvalDeny}`}
          type="button"
          onClick={() => onApprove({ allow: false })}
        >
          <span className={styles.approvalKey}>N</span>
          拒绝
        </button>
      </div>

      {/* 去向说明：以前"不想老点"靠记忆档，现在只剩审批模式一个开关 ——
          不写出来，用户会以为这个能力被删了 */}
      <p className={styles.approvalHint}>
        只放行这一次。想整轮不打断，用上方的「审批」模式。
      </p>
    </div>
  );
}
