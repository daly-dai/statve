"use client";

// ============================================================
// EmptyHero —— 新会话空态的品牌行（2026-11-19 从 page.tsx 拆出）
// ============================================================
// 职责一句话：**空会话时，输入框卡片上方那行「s statve」**。
//
// 为什么拆：`app/page.tsx` 已经 727 行（AGENTS 11.9 的线是 500），而这一块
// 是纯展示、零状态、零副作用 —— 六刀里最独立的一刀，先切它试水。
//
// 为什么是"传 visible 进来"而不是"页面用 `!showTabs && <EmptyHero/>` 包着"：
// Home 的圈复杂度一直贴着 eslint 上限（注释里记过好几次），JSX 里每多一个
// `&&` 就多算一个分支。所以这个分支留在组件内部，页面只传值。
//
// 位置不归它管：空态怎么居中由页面级的 `.stage[data-empty]` 栅格决定
// （样式住 app/page.module.css）；这里只管它自己长什么样。
// ============================================================

import styles from "./index.module.css";

type EmptyHeroProps = {
  /** 空会话才显示（有对话时返回 null，不占位） */
  visible: boolean;
};

export function EmptyHero({ visible }: EmptyHeroProps) {
  if (!visible) return null;

  return (
    <div className={styles.hero}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          s
        </span>
        <span className={styles.brandName}>statve</span>
      </div>
    </div>
  );
}
