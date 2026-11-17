"use client";

// ============================================================
// SessionBar —— 右栏第一行：会话标题 + 模型名（2026-11-17）
// ============================================================
// 为什么单独拆一个组件（而不是写在 page.tsx 的 JSX 里）：
//   ① 它有一条**展示规则**要讲清楚 —— 新会话不显示标题；
//   ② page.tsx 的 Home 已经顶着 eslint 的圈复杂度上限（20），
//      再往里塞三元就会红（拆出来是规则要求的出口，见 AGENTS §11.9）。
//
// 规则：
//   - 标签 = 「标题 ?? 首条消息」（和侧栏那一行的标签**同一条链**，不要各写一套）；
//   - 标签为空、或还是默认的「新会话」⇒ **不显示标题**（那一行只剩右边的模型名）。
// 状态不在这一行：会话行首那个点已经表达（转圈 / 蓝 / 黄 / 红）。
// ============================================================

import { DEFAULT_SESSION_TITLE } from "@/lib/types";
import styles from "./index.module.css";

type SessionBarProps = {
  /** 会话的显示标签（标题 ?? 首条消息；都没有时是空串） */
  label: string;
  /** 当前模型名（第一次 run 之前是空串） */
  model: string;
};

export function SessionBar({ label, model }: SessionBarProps) {
  // 新会话没有"名字"可言，显示「新会话」只是噪音
  const showTitle = label !== "" && label !== DEFAULT_SESSION_TITLE;
  // 什么可显示的都没有 ⇒ 整行收起（CSS 里 data-empty 把行高归零）。
  // 注意：**不能直接 return null** —— .stage 是按行排的栅格，少一个子元素
  // 会让后面的 tab / 内容整体错一行；用一个"高度 0 的占位"最稳。
  const empty = !showTitle && !model;

  return (
    <div className={styles.bar} data-empty={empty ? "" : undefined}>
      {showTitle ? (
        <h1 className={styles.title} title={label}>
          {label}
        </h1>
      ) : (
        <span />
      )}
      {model ? <span className={styles.meta}>{model}</span> : null}
    </div>
  );
}
