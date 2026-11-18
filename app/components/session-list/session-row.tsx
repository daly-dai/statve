"use client";

// ============================================================
// SessionRow —— 会话列表的"一行"（2026-08-28 从 SessionList 拆出）
// ============================================================
// 拆出理由（code-review 气味：嵌套三目 + 多职责）：
//   SessionList 只回答"列表长什么样"，本组件只回答"一行有几种形态"。
//   一行 4 态：正常 / 重命名编辑 / 删除确认 / ⋯操作菜单。
//
// 状态保持提在父级（SessionList 持有 editingId/pendingDelete/draft 单值）：
//   ——这是有意的互斥设计（同一时刻只有一行在编辑/删除）。
//   本组件只收 props 做展示 + 转发回调，不自己持有行内状态。
//   唯一例外：删除确认条的取消按钮 ref + 聚焦（纯行内视觉行为，与父级无关）。
//
// 交互约定（抄自 SessionList 时代，未变）：
//   点击行      → 切换会话（编辑/确认态中禁用）
//   ⋯→重命名  → 行内输入：Enter 保存 / Esc 或失焦取消
//   ⋯→删除    → 行内确认条：Esc 或取消退出，红字「删除」真删
// ============================================================

import { useEffect, useRef, type ReactNode } from "react";
import type { SessionSummary } from "../../lib/use-sessions";
import type { RunPhase } from "../../lib/run-fold";
import { formatClock } from "../../lib/format";
import { formatElapsed } from "../../lib/transcript";
import {
  useRunStarted,
  useSessionReading,
  useSessionRunPhase,
} from "../../lib/run-store";
import { useElapsed } from "../../lib/use-elapsed";
import { sessionDotFor, type DotKind } from "../../lib/session-dot";
import { Menu } from "../ui/menu";
import styles from "./session-list.module.css";

type SessionRowProps = {
  session: SessionSummary;
  /** 是否当前会话（高亮态） */
  current: boolean;
  /** 该行是否在重命名编辑态 */
  editing: boolean;
  /** 该行是否在删除确认态 */
  confirmingDelete: boolean;
  /** 重命名草稿（受控值，父级持有） */
  draft: string;
  onSelect: () => void;
  /** ⋯菜单「重命名」：进入编辑态 */
  onStartRename: () => void;
  onRenameDraft: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  /** ⋯菜单「删除」：进入确认态（不真删） */
  onRequestDelete: () => void;
  /** 确认条「删除」：真删 */
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

/**
 * 状态点的悬停说明（C56 第二轮）。文案跟着新模型走：结局点只在你"没看见"时
 * 才存在，所以说法是"你还没看"，不是第一版的"上次运行已完成"。
 * 用 Record 而不是 switch：漏一个 DotKind 直接是类型错误（穷尽性交给 tsc），
 * 每个键都必然有值，`consistent-return` 也没得抱怨。
 */
const DOT_TITLES: Record<DotKind, string> = {
  none: "",
  running: "正在执行",
  waiting: "等你确认",
  done: "跑完了，你还没看",
  error: "失败了，你还没看",
};

/** "还没结束"的三个阶段（计时器在这三种状态里都走）。`idle/done/error` 不算。 */
const LIVE_PHASES: readonly RunPhase[] = [
  "running",
  "waiting-approval",
  "waiting-ask",
];

export function SessionRow({
  session,
  current,
  editing,
  confirmingDelete,
  draft,
  onSelect,
  onStartRename,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: SessionRowProps) {
  // 确认条取消按钮：出现时聚焦（安全侧——回车=取消，不误删；
  // 与退役的 ConfirmDialog 默认聚焦取消同款；同时让 Esc 有落点）。
  // 行内视觉行为，不占父级状态。
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingDelete) cancelRef.current?.focus();
  }, [confirmingDelete]);

  // 本会话的 run 阶段 + 阅读位置（C56 第二轮）：**点不是 phase 的投影** ——
  // "在跑 / 卡住等你"看此刻的事实，"结局"看"跑到第几次 vs 你看到第几次"。
  // 两个订阅都很轻：selector 只返回一个小字符串 / 一个引用，别的会话每帧更新
  // 时它们求值结果不变 → 本行不重渲。
  const phase = useSessionRunPhase(session.id);
  const reading = useSessionReading(session.id);
  const dot = sessionDotFor({
    phase,
    isCurrent: current,
    record: reading,
  });

  // 跑着的时候，右侧那一槽从「时间」变成「跑了多久」（2026-11-18 用户定：甲）。
  // 多会话并行时，只有侧栏能一眼看到"哪条已经跑了 3 分钟、该去打断它"。
  //
  // ⚠️ **三种"还没结束"的阶段都算**（running / 等审批 / 等回答）：卡在等审批的会话
  // 恰恰最容易一放就是半小时 —— 那正是最该被看见的时刻。点在那儿区分状态
  // （转圈 / 黄点），计时器只回答"过去多久了"。
  const startedAt = useRunStarted(session.id);
  const live = LIVE_PHASES.includes(phase) ? startedAt : undefined;
  const elapsed = useElapsed(live);

  // 行内容三态互斥，优先级：删除确认 > 重命名编辑 > 正常展示。
  // （原先是嵌套三目，"哪一态"要数冒号才看得出来，改成显式分支。）
  let rowBody: ReactNode;
  if (confirmingDelete) {
    /* 行内删除确认（2026-08-28，替代居中 ConfirmDialog 弹框）：
       复用行内重命名的"状态替换行内容"模式——点 ⋯→删除后，
       该行原地变成确认条，不遮罩、不打断阅读、操作就近。
       全站从此零模态弹框（审批/提问本就钉底部，删除就地确认）。 */
    rowBody = (
      <div
        className={styles.sessionConfirm}
        role="alert"
        onClick={(e) => e.stopPropagation()}
        /* Esc 取消：与重命名模式对齐（重命名有 Esc/失焦取消）。
           焦点在确认条内（默认在取消按钮），Esc 冒泡到容器 */
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancelDelete();
        }}
      >
        <span className={styles.confirmText}>删除后不可恢复</span>
        <div className={styles.confirmActions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.confirmCancel}
            onClick={onCancelDelete}
          >
            取消
          </button>
          <button
            type="button"
            className={styles.confirmDelete}
            onClick={onConfirmDelete}
          >
            删除
          </button>
        </div>
      </div>
    );
  } else if (editing) {
    rowBody = (
      <input
        className={styles.sessionRenameInput}
        value={draft}
        placeholder="会话名称"
        autoFocus
        onChange={(e) => onRenameDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommitRename();
          if (e.key === "Escape") onCancelRename();
        }}
        onBlur={onCancelRename}
        onClick={(e) => e.stopPropagation()}
      />
    );
  } else {
    rowBody = (
      <>
        {/* 状态点（2026-11-17 第二轮）：**点 = 这条会话有一件我没看见的事**。
            绝对定位：只在行首占 6px、不参与 flex 排布 —— 否则"有点 / 没点"
            两种行的标题会错开。四种形态（CSS 只认 data-dot，颜色/动画在样式里）：
              running → 转圈（正在跑）
              waiting → 黄点（卡住等你确认）
              done    → 蓝点（你离开期间跑完了，还没看）
              error   → 红点（同上，但失败了；点开能看到红横幅里的原因）
            判据**不在这里**，在 `app/lib/session-dot`（16 条场景的由来也在那里）：
              · 当前会话永不点 —— 连"在跑"也不点（右栏有别的表达）
              · 前两种看"此刻的事实"，后两种看"跑到第几次 vs 你看到第几次" */}
        {dot !== "none" && (
          <span
            className={styles.sessionDot}
            data-dot={dot}
            title={DOT_TITLES[dot]}
            role="status"
          />
        )}
        {/* 单行：标题占满剩余宽度 + 时间靠右（回到原型 `prototype-workspace.html`
            的 `.row` 形态）。没标题时回退到首条消息（preview），再没有才显示
            「新会话」——原始 id（s_2026-08-26T..._xxx）是存储细节，不是给人看的名字。
            ⚠️ 2026-11-17（C56 密度）：**不再单独渲染"预览"那一行** ——
            一行 60–80px 太占地方；标题本来就是"标题 ?? 预览"，
            没改过名的会话照样看得到那句话。 */}
        <div className={styles.sessionTitle}>
          {session.title ?? session.preview ?? "新会话"}
        </div>
        {/* 条数已删（2026-09-01 用户拍板）；时间常驻右侧，悬停时淡出给 ⋯ 让位。
            跑着的时候这里换成计时器（3:12）—— 同一个槽，零新增元素。 */}
        <span className={styles.sessionTime}>
          {elapsed === undefined
            ? formatClock(session.updatedAt)
            : formatElapsed(elapsed)}
        </span>
      </>
    );
  }

  return (
    <div
      className={`${styles.sessionItem}${current ? " is-current" : ""}`}
      // 编辑/确认态中禁点：避免"正在改这一行时误切会话"
      onClick={() => !editing && !confirmingDelete && onSelect()}
    >
      {rowBody}

      {!editing && !confirmingDelete && (
        /* V2（2026-08-26）：⋯ 菜单（重命名/删除，34px 命中区）。
           二次调整：从"常驻显示"改回"鼠标移上去才显示"（抄 DSH
           会话列表的 hover 操作模式）——行平时干净，干预才动手。
           键盘可达：焦点进到行内（focus-within）时同样显示 */
        <Menu
          label={`会话操作：${
            session.title ?? session.preview ?? "未命名会话"
          }`}
          /* V2 微调（2026-08-26，用户要求"偏右，别挡会话列表"）：
             side = 弹框贴 ⋯ 右侧水平展开，浮到转录稿上方，
             不再往下盖住下面会话行的标题/预览 */
          align="side"
          className={styles.sessionMenu}
          items={[
            {
              label: "重命名",
              onSelect: onStartRename,
            },
            {
              label: "删除",
              hint: "不可恢复",
              danger: true,
              onSelect: onRequestDelete,
            },
          ]}
        />
      )}
    </div>
  );
}
