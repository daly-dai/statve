"use client";

// ============================================================
// AnswerActions —— 回答底部的动作行（C61）
// ============================================================
// 职责一句话：**对已经生成的内容做事**（首发只有「复制」）—— 悬停才现，不占读者注意力。
//
// 尺寸抄 pi-web（`MessageView.tsx:512-553`）：22px 高 / 11px 字 / ✓ 反馈 1.5s；
// 但命中区按本项目 `--hit: 34px` 的判据用 ::before 撑到 32（视觉 22，点得到 32）。
//
// ⚠️ "悬停整条回合才现身"那条规则住在父组件（index.module.css），因为它选的是
// **回合**；这里只负责给自己挂一个 `data-role="answer-actions"` 让父级能选中
// （CSS Modules 会哈希类名，跨文件写类名指不到 —— 这条坑在拆分时踩过）。
// ============================================================

import { useState } from "react";
import styles from "./answer-actions.module.css";

export function AnswerActions({
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
      <div className={styles.answerActs} data-role="answer-actions">
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
