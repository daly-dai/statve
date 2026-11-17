"use client";

// ============================================================
// 审批模式切换 —— 运行时切换信任档位（B1-②）
// ============================================================
// 参考项目都有运行时切换入口（pi /settings、DSH /permission、
// CodeWhale Shift+Tab）——模式不能靠改 env 重启。
//
// 三档（抄 pi defaultProjectTrust: ask/always/never）：
//   建议(suggest) —— 写操作 + bash 都弹框（默认；审批本身**不记忆**，每次都问）
//   YOLO(bypass)  —— 除硬性策略外全部放行（琥珀：放行信号）
//   禁止(never)   —— 需确认的工具直接拒绝（红：错误信号）
//
// ⭐ 2026-11-17（C55 补记 14）：弹框里不再有「本会话允许 / 一直允许」，
// 这个开关就是**唯一**的"别再问我"——抄 DSH `approval/policy`（ask | never）
// 的做法：不打断是**策略**，不是记在某个工具名下的一次点击。
// 它存在 globalThis 里（重启恢复），所以是"这一轮"，不是永久放行。
// ============================================================

import type { ApprovalMode } from "../../services/chat/types";
import styles from "./approval-mode-switch.module.css";

const MODES: { value: ApprovalMode; label: string; title: string }[] = [
  {
    value: "suggest",
    label: "建议",
    title: "逐个确认：写操作和 bash 都问你（只放行这一次）",
  },
  {
    value: "bypass",
    label: "YOLO",
    title: "全部放行（越界除外）—— 调试用，重启恢复",
  },
  { value: "never", label: "禁止", title: "需人工确认的工具直接拒绝" },
];

type ApprovalModeSwitchProps = {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
};

export function ApprovalModeSwitch({
  mode,
  onChange,
}: ApprovalModeSwitchProps) {
  return (
    <div className={styles.switch} role="group" aria-label="审批模式">
      <span className={styles.label}>审批</span>
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          className={`${styles.btn} ${styles[m.value]} ${
            mode === m.value ? styles.active : ""
          }`}
          title={m.title}
          aria-pressed={mode === m.value}
          onClick={() => onChange(m.value)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
