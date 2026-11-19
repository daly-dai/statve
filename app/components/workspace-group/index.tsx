"use client";

// ============================================================
// WorkspaceGroup —— 侧栏里「一个工作空间」这一块（C49/C51）
// ============================================================
// 只回答一件事：这一组长什么样、组头那几个动作在哪。
// 会话行**由外层传进来**（children）——因为行内状态（重命名草稿、删除确认）
// 必须由 SessionList 单点持有，否则每个组各持一份，"同一时刻只有一行在编辑"
// 这条不变量就没人守了。
//
// 形态全部继承已批准的原型 `workspace/prototype-workspace.html`：
//   组头 = [⌄] 名字 计数 [＋] [⋯]；动作默认 opacity 0，hover / 键盘聚焦才出现。
// ============================================================

import type { KeyboardEvent, ReactNode } from "react";
import { Menu } from "../ui/menu";
import type { MenuItem } from "../ui/menu";
import styles from "./index.module.css";

type WorkspaceGroupProps = {
  title: string;
  /** 组内会话总数（含被折叠的） */
  count: number;
  /** 折叠整组（状态只在界面上，不落盘） */
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 组内被"先 5 条"折叠掉的数量；0 = 不出现那一行 */
  hiddenCount: number;
  onShowMore: () => void;
  /** 在这个工作空间里新建会话（工作空间由本组决定，不再问） */
  onCreateSession: () => void;
  /** 进入"改名"态（组头就地换成输入框） */
  onStartRename: () => void;
  onOpenFolder: () => void;
  /** 删除是破坏性的（连带删会话）：先进入确认态，报清会删掉几个会话 */
  onDelete: () => void;
  /** 正在改名的这一组：组头换成输入框（就地编辑，不弹 prompt） */
  renaming?: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
  onCommitRename?: () => void;
  onCancelRename?: () => void;
  /** 正在确认删除（组头下方出现一层确认条） */
  confirmingDelete?: boolean;
  onConfirmDelete?: () => void;
  onCancelDelete?: () => void;
  children: ReactNode;
};

export function WorkspaceGroup({
  title,
  count,
  collapsed,
  onToggleCollapse,
  hiddenCount,
  onShowMore,
  onCreateSession,
  onStartRename,
  onOpenFolder,
  onDelete,
  renaming = false,
  draft = "",
  onDraftChange,
  onCommitRename,
  onCancelRename,
  confirmingDelete = false,
  onConfirmDelete,
  onCancelDelete,
  children,
}: WorkspaceGroupProps) {
  const menuItems: MenuItem[] = [
    { label: "重命名工作空间", onSelect: onStartRename },
    { label: "打开文件夹", onSelect: onOpenFolder },
    { label: "删除工作空间", danger: true, onSelect: onDelete },
  ];

  return (
    <section className={styles.group}>
      {/* 组头整行可点（2026-11-17 用户定：热区太小，只有箭头能点是浪费）：
          不在改名态时才可点；键盘用 Enter / Space 同样能切换 */}
      <div
        className={styles.head}
        {...(renaming
          ? {}
          : {
              role: "button",
              tabIndex: 0,
              "aria-expanded": !collapsed,
              "aria-label": `${collapsed ? "展开" : "折叠"} ${title}`,
              onClick: onToggleCollapse,
              onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onToggleCollapse();
              },
            })}
      >
        {renaming ? (
          <>
            <input
              className={styles.renameInput}
              value={draft}
              aria-label={`重命名 ${title}`}
              autoFocus
              onChange={(event) => onDraftChange?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCommitRename?.();
                if (event.key === "Escape") onCancelRename?.();
              }}
            />
            <button
              className={styles.renameAction}
              type="button"
              onClick={onCommitRename}
            >
              保存
            </button>
            <button
              className={styles.renameAction}
              type="button"
              onClick={onCancelRename}
            >
              取消
            </button>
          </>
        ) : (
          <>
            {/* 箭头只是视觉提示（不再是热区）：**整行**都能展开/收起，
                只有右边的 ＋ / ⋯ 除外（它们 stopPropagation） */}
            <span className={styles.chevron} aria-hidden="true">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
              >
                <path
                  d={collapsed ? "M3.5 2 6.5 5 3.5 8" : "M2 3.5 5 6.5 8 3.5"}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>

            <span className={styles.name} title={title}>
              {title}
            </span>

            <span
              className={styles.actions}
              // 动作区不参与"整行点击"：点 ＋ / ⋯ 不能顺手把组收起
              onClick={(event) => event.stopPropagation()}
            >
              {/* 顺序 2026-11-19 用户定：⋯ 在左、＋ 贴最右。
                  理由：动作区贴着右边缘，常用的「新建会话」放最外侧 —— 鼠标从屏幕右边
                  进来时不用先跨过 ⋯；而 ⋯ 低频、且里面有「删除」，退到内侧更稳。 */}
              <Menu
                label={`${title} 的工作空间操作`}
                items={menuItems}
                align="end"
                className={styles.menuWrap}
              />
              <button
                className={styles.iconButton}
                type="button"
                title="在这个工作空间里新建会话"
                aria-label={`在 ${title} 里新建会话`}
                onClick={onCreateSession}
              >
                <PlusIcon />
              </button>
            </span>
          </>
        )}
      </div>

      {confirmingDelete ? (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>
            删除「{title}」会连它的 {count} 个会话一起删掉，不可恢复。
          </p>
          <div className={styles.confirmActions}>
            <button
              className={styles.confirmCancel}
              type="button"
              onClick={onCancelDelete}
            >
              取消
            </button>
            <button
              className={styles.confirmDanger}
              type="button"
              onClick={onConfirmDelete}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}

      {collapsed ? null : (
        <div className={styles.body}>
          {children}
          {hiddenCount > 0 ? (
            <button
              className={styles.showMore}
              type="button"
              onClick={onShowMore}
            >
              展开其余 {hiddenCount} 个
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** 组头的「新建会话」：一个加号（2026-11-17 从「＋」文字换成图标，好调大小） */
function PlusIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
