"use client";

// ============================================================
// StageTabs —— 右栏顶部的「对话 / 轨迹」切换条（2026-11-19 从 page.tsx 拆出）
// ============================================================
// 职责一句话：**两个 tab 的横条 + 当前选中态**（纯展示，不管点完切什么）。
//
// 为什么拆：page.tsx 727 行超线（AGENTS 11.9）。tab 条本身是 60 行 JSX 里的
// 两处三元（`aria-selected` / `className`），搬出来顺带把这两个分支从 Home
// 的圈复杂度里拿走。
//
// ⚠️ 两条不属于它的规则，故意留在页面里：
//   ① `.stage[data-tabs="none"]`（新会话时栅格少一行）—— 那是**舞台**的行模板，
//      不是 tab 条的样子；
//   ② 「新会话不显示 tab」的判据（`hasConversation`）—— 那是页面的数据判断，
//      这里只收一个 `hidden` 布尔。
// ============================================================

import styles from "./index.module.css";

export type StageTab = "chat" | "trace";

/** tab 的清单与文案（顺序即显示顺序） */
const TABS: readonly { id: StageTab; label: string }[] = [
  { id: "chat", label: "对话" },
  { id: "trace", label: "轨迹" },
];

type StageTabsProps = {
  /** 当前选中的 tab（受控） */
  value: StageTab;
  onChange: (tab: StageTab) => void;
  /**
   * 新会话（没有对话也没有轨迹）时隐藏。
   * ⚠️ 用 `display:none` 会把它从栅格里整个移除、后面的行全部前移
   * （实测：转录区被挤成 38px）。所以隐藏时页面同时换掉 `.stage` 的行模板 ——
   * 见 app/page.module.css 的 `.stage[data-tabs="none"]`。
   */
  hidden: boolean;
};

export function StageTabs({ value, onChange, hidden }: StageTabsProps) {
  return (
    <div
      className={styles.tabs}
      role="tablist"
      data-hidden={hidden ? "" : undefined}
    >
      {TABS.map((tab) => {
        const on = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={on ? `${styles.tab} ${styles.tabOn}` : styles.tab}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
