"use client";

// ============================================================
// 品牌行 —— 左栏最上面那一行（2026-11-17 从"整页页头"降级）
// ============================================================
// 以前它是**横跨全宽**的页头：左边标志 + 标题，右边模型 / runId / 状态灯 / 轮次。
// 2026-11-17 用户定：右侧那些信息没意义（"待命"看不懂、"T2"是内部轮次、
// runId 每轮都变），于是整块删掉；页头也缩成**只属于左栏的品牌行**，
// 右栏从顶部开始（见 page.module.css 的 leftColumn / stage）。
//
// 状态不再写文字：会话行首那个点会说话（进行中转圈 / 完成蓝 / 待确认黄 / 失败红），
// 见 app/components/session-list/session-row.tsx。
//
// 停止按钮也不在这里：它放在输入框旁（run 进行中发送按钮变成「停止」）。
// ============================================================

import styles from "./nameplate.module.css";

export function Nameplate() {
  return (
    <div className={styles.brand}>
      <PenMark />
      <span className={styles.wordmark}>statve</span>
    </div>
  );
}

/** 标志：一段笔迹。它和轨迹区画的是同一件事 */
function PenMark() {
  return (
    <svg
      className={styles.mark}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M2 16.5H5.7L8.6 6.8l3.4 12 2-8.2 2.3 2.3h5.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
