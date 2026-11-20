"use client";

// ============================================================
// NoSessionHint —— 一个会话都没有时，右栏唯一的那句话（C67）
// ============================================================
// 职责一句话：**右侧没会话可看时，告诉用户去哪里弄一个会话。**
//
// 为什么有它：以前 A 态（无会话）画的是"禁用状态的输入台"，提示被写在一个
// 点不动的控件里；而它指的入口（组头的 ＋）在 hover 之前是不可见的
// —— 等于让用户按一个看不见的按钮。用户 2026-11-20 拍板：
// 「右侧能啥也不展示 提示他先去选择会话吗 这样的话 咱们也不需要苦恼什么禁用问题了」
//
// 为什么是"传 visible 进来"而不是页面用 `cond && <NoSessionHint/>`：
// 与 <EmptyHero> 同一个理由 —— Home 的圈复杂度贴着 eslint 上限，
// 每个 JSX 里的 `&&` 都算一个分支。分支留在组件内部，页面只传值。
//
// ⚠️ 三种输入的含义（page.tsx 的 `stageModeOf` 决定）：
//   visible=true  → A 态：只画这句话
//   visible=false && 加载中 → **什么都不画**（列表还没回来，画了会闪）
//   visible=false && 有会话 → 返回 null，右侧照旧渲染输入台/转录稿
// ============================================================

import styles from "./index.module.css";

type NoSessionHintProps = {
  /** 只在"一个会话都没有、且会话列表已经加载完"时为 true */
  visible: boolean;
};

export function NoSessionHint({ visible }: NoSessionHintProps) {
  if (!visible) return null;

  return (
    <div className={styles.pane} data-role="no-session">
      <p className={styles.hint}>请选择会话，或在工作空间组头点 ＋ 新建。</p>
    </div>
  );
}
