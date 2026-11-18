"use client";

// ============================================================
// ApprovalModeMenu —— 审批模式：一个下拉，不是三个常驻 chip（C57 尾巴，2026-11-18）
// ============================================================
// 为什么改：三档以前是三个 34px 的 chip 常驻在输入台（实测 211px 宽），
// 而它一年改不了几次，却和你说每句话的输入框并列。对照 pi 的 `/settings`、
// DSH 的 `/permission` —— 两家都不让策略常驻在输入台。
//
// 现在：**只显示当前值**（`审批 建议 ▾`），要换才展开。改一次多一次点击，
// 换掉的是每天的注意力占用，这个交换划算。
//
// 复用 `ui/menu` 原语（全站只有一个溢出模式）：开合 / 点外面关 / Esc /
// 键盘漫游 / 焦点还给触发器，都在原语里，这里只给「三项 + 单选语义 + 触发器长相」。
//
// ⭐ 2026-11-17（C55 补记 14）那条不变：弹框里没有「本会话允许 / 一直允许」，
// 这个开关是**唯一**的"别再问我"——它是策略，不是记在某个工具名下的一次点击。
// ============================================================

import { Menu } from "../ui/menu";
import type { ApprovalMode } from "../../services/chat/types";
import styles from "./approval-mode-menu.module.css";

/** 三项各自的**一句人话**：菜单里只有三个词（建议 / YOLO / 禁止）等于黑话，
 *  第一次看到的人得猜。说明就写在这（原来住在 chip 的 title 里，很不好发现）。 */
const MODES: {
  value: ApprovalMode;
  label: string;
  description: string;
}[] = [
  {
    value: "suggest",
    label: "建议",
    description: "写操作和 bash 都问你，只放行这一次",
  },
  {
    value: "bypass",
    label: "YOLO",
    description: "全部放行（越界除外），调试用，重启恢复",
  },
  {
    value: "never",
    label: "禁止",
    description: "需人工确认的工具直接拒绝",
  },
];

type ApprovalModeMenuProps = {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
};

export function ApprovalModeMenu({ mode, onChange }: ApprovalModeMenuProps) {
  const current = MODES.find((item) => item.value === mode) ?? MODES[0];

  return (
    <Menu
      label={`审批模式：${current.label}`}
      // 输入台贴着屏幕底，面板只能往上开
      placement="up"
      // 从 N 个里选一个：项用 menuitemradio，选中项右侧 ✓
      selection="single"
      triggerClassName={styles.trigger}
      panelClassName={styles.panel}
      items={MODES.map((item) => ({
        label: item.label,
        description: item.description,
        checked: item.value === mode,
        onSelect: () => onChange(item.value),
      }))}
    >
      <span className={styles.label}>审批</span>
      <span className={styles.value}>{current.label}</span>
      <span className={styles.caret} aria-hidden="true">
        ▾
      </span>
    </Menu>
  );
}
