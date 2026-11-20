"use client";

// ============================================================
// Composer —— 指令台：输入框卡片 + 工具栏 + 底栏读数（2026-11-19 从 page.tsx 拆出）
// ============================================================
// 职责一句话：**把用户的话送出去的那个框**（含发送/停止、审批档位、命令补全接线、读数）。
//
// 为什么拆：page.tsx 727 行超线（AGENTS 11.9）。这一刀最大（约 180 行），
// 因为它把四样东西攒在了一起：卡片、文本区、工具栏、底栏。
//
// ⚠️ 三条硬约束（C57 定案，拆的时候一条都不能破）：
//   ① **输入框不许重挂**：空会话 ↔ 有对话只换 props 与 `data-empty` 的 CSS，
//      绝不换父级。换父级 = 重挂 textarea = 焦点和没发出去的字一起丢
//      （DSH 在 EmptyHero.tsx 顶部专门写了这条）。
//   ② **审批/提问卡出现时不能卸载它**：`covered` 只是把它 absolute +
//      visibility:hidden 藏起来（DOM 和 ref 保留），卡一关就恢复
//      —— 规则见 app/page.module.css 的 `.decisionHost` / 这里的 `.consoleCovered`。
//   ③ **只收 props、不读 store**：这个组件不知道 session / store 的存在，
//      运行态由页面以 `run` / `state` 两组值喂进来。
// ============================================================

import styles from "./index.module.css";
import { ApprovalModeMenu } from "../approval-mode-menu";
import { CommandMenu } from "../command-menu";
import { ContextMeter } from "../context-meter";
import { SkillChip } from "../skill-chip";
import { formatTokens } from "@/app/lib/format";
import type { ContextPressure } from "@/app/lib/context-occupancy";
import type { CommandMenuState } from "@/app/lib/use-command-menu";
import type { ApprovalMode } from "@/app/services/chat/types";
import type { SessionStats } from "@/lib/types";

type ComposerProps = {
  /** useCommandMenu 的整套返回值：输入值 / 快照 / 键盘导航 / 提交 */
  command: CommandMenuState;
  /** 审批档位（B1-②）：工具栏左侧那个下拉（发送这次 run 用什么信任档） */
  approval: { mode: ApprovalMode; onChange: (mode: ApprovalMode) => void };
  /** 本次 run 的运行态：发送按钮「变身」成停止键要它 */
  run: { loading: boolean; runId: string; stop: (runId: string) => void };
  /** 会话级读数（底栏：轮次 / 工具数 / token） */
  stats: SessionStats;
  /** 上下文占用（圆环；无数据时不渲染） */
  contextPressure: ContextPressure | undefined;
  /** 空会话：卡片内顶部那行工作空间名 + 换一句 placeholder */
  empty: { visible: boolean; workspaceName?: string };
  /** 输入台的可用性与遮挡（disabled = 无会话或运行中；covered = 卡片占位） */
  state: { disabled: boolean; covered: boolean; hasSession: boolean };
};

export function Composer({
  command,
  approval,
  run,
  stats,
  contextPressure,
  empty,
  state,
}: ComposerProps) {
  const {
    input,
    inputRef,
    commandMenuOpen,
    commandActiveIndex,
    setCommandActiveIndex,
    commandMenuRef,
    filteredCommands,
    armedSkill,
    clearArmedSkill,
    handleInputChange,
    handleKeyDown,
    handleBlur,
    pickCommand,
    submit,
  } = command;

  // 被卡片占位时的隐藏态：absolute + visibility:hidden（而不是 display:none）
  // ——不占文档流，卡片独占决策区，视觉与改造前等价；同时不接收点击。
  const formClass = state.covered
    ? `${styles.console} ${styles.consoleCovered}`
    : styles.console;

  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={styles.consoleFrame}>
        {/* 空会话：工作空间落在卡片内部的顶部左侧 —— 纯文本（位置先占住；
            以后要能切换，把它换成 button + 菜单，排版不用动） */}
        {workspaceRow(empty)}
        {/* C13 命令补全面板：贴输入框上方浮起；键盘导航在 textarea
            onKeyDown 处理（焦点始终在输入框，只移高亮项）。
            display:contents —— 包裹 div 不生成盒模型，不占 consoleFrame
            grid 的子项位（否则 popup 会把两列布局撑成两行），
            popup 的 absolute 定位祖先仍是 consoleFrame。 */}
        {commandMenuOpen && (
          <div ref={commandMenuRef} className={styles.commandLayer}>
            <CommandMenu
              commands={filteredCommands}
              activeIndex={commandActiveIndex}
              onActiveChange={setCommandActiveIndex}
              onPick={pickCommand}
            />
          </div>
        )}
        {/* C8 T6 · R4-1：行首挂着一个技能 → 框内上沿一个可点的标签。
            放在 textarea **之前**：consoleFrame 是两列 grid，它 grid-column
            1/-1、自然落在第一行，textarea 与右侧按钮仍在第二行 */}
        {armedSkill && (
          <SkillChip name={armedSkill.name} onClear={clearArmedSkill} />
        )}
        <textarea
          className={styles.consoleInput}
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(event) => handleInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={composerPlaceholder(state.hasSession)}
          disabled={state.disabled}
          autoFocus
        />
        {/* 工具栏（三层里的第三层）：左 = 这次 run 用什么信任档，
            右 = 占位圆环 + 发送/停止。整行横跨卡片（grid-column 1/-1）。 */}
        <div className={styles.consoleActions}>
          <ApprovalModeMenu mode={approval.mode} onChange={approval.onChange} />
          <div className={styles.consoleActionsRight}>
            <ContextMeter pressure={contextPressure} />
            <SubmitButton
              run={run}
              input={input}
              hasSession={state.hasSession}
            />
          </div>
        </div>
      </div>
      {/* 输入台底栏（A3，参考 DSH）：左 = 会话级读数，右 = 操作提示。
          读数原本长在 <TraceRail> 底部，轨迹栏下线后搬到这里——
          这样"会话跑了多少"在任何 tab 下都看得见。 */}
      <div className={styles.statusBar}>
        <span className={styles.statusStats}>
          {stats.turns} 轮 · {stats.tools} 工具 · {formatTokens(stats.tokens)}{" "}
          token
        </span>
      </div>
    </form>
  );
}

type SubmitButtonProps = {
  run: { loading: boolean; runId: string; stop: (runId: string) => void };
  /** 有字才可发（空白字符不算） */
  input: string;
  hasSession: boolean;
};

/**
 * 发送 / 停止 —— 同一个位置的同一颗按钮，角色随 `loading` 切换。
 *
 * 为什么不拆成两个组件：拆开就必然在父级写三元选哪个，而"同一颗按钮换角色"
 * 这件事本身就是要让人一眼看出来的（位置永远不变，操作跟随视线）。
 */
function SubmitButton({ run, input, hasSession }: SubmitButtonProps) {
  if (run.loading) {
    return (
      <button
        className={styles.consoleStop}
        type="button"
        onClick={() => run.stop(run.runId)}
        disabled={!run.runId}
        aria-label="停止"
        title="停止这次运行"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect width="10" height="10" rx="1.5" fill="currentColor" />
        </svg>
      </button>
    );
  }

  return (
    <button
      className={styles.consoleSend}
      type="submit"
      disabled={!input.trim() || !hasSession}
      aria-label="发送"
      title="发送（Enter）"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
      </svg>
    </button>
  );
}

// ============ 文案与空态零件（纯函数，不碰状态） ============

/**
 * placeholder 的两句话。
 *
 * 为什么提到模块层：写进 JSX 的三元会把组件的圈复杂度顶到 eslint 上限，
 * 而这两句就是常量，跟组件状态无关。
 */
function composerPlaceholder(hasSession: boolean): string {
  return hasSession
    ? "描述你想要构建的内容，/调用指令"
    : "先在工作空间里开一个会话，再给它目标";
}

/** 空会话：卡片内顶部那行「▸ 工作空间名」—— 纯文本，不是按钮 */
function workspaceRow(empty: { visible: boolean; workspaceName?: string }) {
  if (!empty.visible || empty.workspaceName === undefined) return null;

  return (
    <div className={styles.wsRow}>
      <span className={styles.wsMark} aria-hidden="true">
        ▸
      </span>
      <span className={styles.wsName}>{empty.workspaceName}</span>
    </div>
  );
}
