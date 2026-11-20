"use client";

// ============================================================
// TranscriptPane —— 转录稿那一格：滚动容器 + 回合 + 末尾两条状态提示
// （2026-11-19 从 page.tsx 拆出）
// ============================================================
// 职责一句话：**对话 tab 里那块能滚的东西，以及吸底跟随**。
//
// 为什么拆：page.tsx 727 行超线（AGENTS 11.9）。这一刀同时带走三样：
//   ① `.transcript`（滚动容器）+ `.reel`（阅读列）两个样式块
//   ② 吸底跟随（useStickyScroll + 滚到底的 effect）—— 它跟着**这个容器**才有意义，
//      容器搬走、逻辑留在页面，就等于隔着一层去操作别人的 DOM
//   ③ 末尾两条状态提示（上下文压缩中 / 命令执行中·执行结果）
//
// ⚠️ 拆出来之后，元素在 DOM 里**仍然是 `.stage` 的直接子元素**
//    （组件边界不生成 DOM），所以页面那条
//    `.stage[data-empty] > [data-role="transcript"] { display: none }` 照旧生效。
// ============================================================

import { useEffect, useRef } from "react";
import styles from "./index.module.css";
import { Transcript } from "../transcript";
import type { TranscriptTurn } from "@/app/lib/transcript";
import { useStickyScroll } from "@/app/lib/use-sticky-scroll";

type TranscriptPaneProps = {
  /** 按回合折好的转录稿（纯函数 buildTranscript 的产物） */
  turns: readonly TranscriptTurn[];
  /** 本轮 run 还在跑：最后一回合不折叠、计时器在走 */
  streaming: boolean;
  /** bash 命令的实时输出（toolCallId → 文本） */
  toolOutputs: Record<string, string> | undefined;
  /** 本轮 run 的本机起点（计时器用；undefined = 没有起点就不显示钟） */
  liveSince: number | undefined;
  /** 后端正在压缩上下文（B2）：给用户一条明确反馈，不然像卡住了 */
  compacting: boolean;
  /** C13 命令：执行中的提示 + 结果兜底文案（压缩成功时文案为空） */
  command: { running: boolean; feedback: string };
};

export function TranscriptPane({
  turns,
  streaming,
  toolOutputs,
  liveSince,
  compacting,
  command,
}: TranscriptPaneProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  // ---- 滚动跟随（吸底）----
  // 2026-08-26 修：原来每次 messages/observed 更新都强制滚到底 ——
  // 流式每来一个 delta 就把滚动轴拽到底，用户想翻上面的历史做不到。
  // 现在由 useStickyScroll 判定"用户是否停靠底部"：停靠才自动滚，
  // 用户滚上去看历史就停止跟随，滚回底部自动恢复（标准聊天 UX）。
  // 阈值（48px）在 hook 里。元素引用也归这里 —— 容器在谁手里，跟随就归谁。
  const follow = useStickyScroll(boxRef);
  useEffect(() => {
    if (!follow) return;
    const box = boxRef.current;
    box?.scrollTo(0, box.scrollHeight);
  }, [follow, turns]);

  return (
    <div className={styles.transcript} ref={boxRef} data-role="transcript">
      <div className={styles.reel}>
        {/* C57：转录稿按**回合**渲染（一次对话 = 一个回合），不再一条消息一行。
            折叠规则、工具行、最终回答的切法都在 <Transcript> / app/lib/transcript 里；
            这里只负责"这一轮还在不在跑"和末尾的两条提示。 */}
        <Transcript
          turns={turns}
          streaming={streaming}
          toolOutputs={toolOutputs}
          liveSince={liveSince}
        />
        {compacting && (
          <div className={styles.compacting} role="status">
            <span className={styles.compactingLabel}>上下文超出上限</span>
            <span>正在压缩上下文，请稍候…</span>
          </div>
        )}
        {command.running && (
          <div className={styles.compacting} role="status">
            <span className={styles.compactingLabel}>命令</span>
            <span>正在执行，请稍候…</span>
          </div>
        )}
        {command.feedback && (
          <div className={styles.compacting} role="status">
            <span>{command.feedback}</span>
          </div>
        )}
      </div>
    </div>
  );
}
