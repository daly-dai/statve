"use client";

// ============================================================
// Transcript —— 右栏的转录稿：一次对话 = 一个回合（C57 P1）
// ============================================================
// 数据形状在 app/lib/transcript（纯函数）：一个回合 = 用户那句话 + 过程 + 最终回答。
// 这里只回答"长什么样"的**回合骨架**，判据一个都不住在这：
//   · 过程折叠与否 —— 有最终回答就折；进行中 / 打入 / 失败 / 只有工具没回答 ⇒ 展开
//   · 工具行 24px，点开才看入参/出参
// 详案：doc/plan/chat-surface-dsh-alignment.md 4.13
//
// ⚠️ 2026-11-20 拆过一刀（AGENTS 11.9：单文件 ≤ 500 行；拆前 480）。五块搬走：
//   tool-row.tsx       一行工具调用（+ 类别标记 / 状态标记 / 参数摘要）
//   reasoning-row.tsx  思考行（C58）
//   step-view.tsx      一条过程按 kind 分派到上面两个或"叙述 / 记录"
//   process-group.tsx  过程组的折叠头 + 展开壳（+ 摘要文案 / 进行中抬头）
//   answer-actions.tsx 回答底部的动作行（C61）
// 这个文件只剩"回合"本身：气泡 + 过程组 + 回答 + 尾部说明。
// ============================================================

import { Markdown } from "../../markdown";
import { AnswerActions } from "./answer-actions";
import { ProcessGroup } from "./process-group";
import { formatElapsed, type TranscriptTurn } from "../../lib/transcript";
import { useElapsed } from "../../lib/use-elapsed";
import styles from "./index.module.css";

type TranscriptProps = {
  turns: readonly TranscriptTurn[];
  /** 本轮 run 还在跑：最后一回合不折叠 */
  streaming: boolean;
  toolOutputs: Record<string, string> | undefined;
  /** 本轮 run 的本机起点（计时器用；`undefined` = 没有起点就不显示钟） */
  liveSince: number | undefined;
};

export function Transcript({
  turns,
  streaming,
  toolOutputs,
  liveSince,
}: TranscriptProps) {
  // 只有最后一回合可能是"在跑"，所以这里只需要一个计时器。
  // ⚠️ 必须提到 map 外面：hooks 不能写在循环里。
  const liveElapsedMs = useElapsed(streaming ? liveSince : undefined);

  return (
    <>
      {turns.map((turn, index) => {
        const isLast = index === turns.length - 1;
        const live = streaming && isLast;
        // 过程组默认折不折：**只要不在跑就折**，不管结局是 ok / 失败 / 被打断。
        // ⭐ 2026-11-18 用户改的规则。之前是「有回答才折；失败 / 被打断 / 没回答都摊开」，
        // 理由是"出事的时候过程就是线索"——但用户按了停止之后的第一反应是"把它收起来"，
        // 摊在那儿反而是噪音。出事的信息一样没丢：头上那行（类别摘要 + 时长）还在，
        // 下面还有「本轮被停止 / 本轮失败 / 本轮没有产出回答」。
        // 想看过程？点行首箭头。
        const collapsed = !live;
        // 跑完才有「这一轮花了多久」；缺时间戳（老数据）就是空串，界面什么都不显示。
        // 格式与进行中的计时器**同一个函数**（用户 2026-11-18 定：一屏里不许有两种写法）
        const durationLabel =
          turn.durationMs === undefined ? "" : formatElapsed(turn.durationMs);
        return (
          <section
            key={turn.index}
            className={styles.turn}
            data-live={live || undefined}
          >
            {turn.prompt !== "" && (
              <div className={styles.say}>
                <p className={styles.bubble}>{turn.prompt}</p>
              </div>
            )}
            <ProcessGroup
              steps={turn.steps}
              streaming={live}
              collapsedByDefault={collapsed}
              toolOutputs={live ? toolOutputs : undefined}
              durationLabel={durationLabel}
              liveElapsedMs={live ? liveElapsedMs : undefined}
            />
            {turn.answer !== "" && (
              <>
                <div className={styles.answer}>
                  <Markdown>{turn.answer}</Markdown>
                </div>
                <AnswerActions
                  answer={turn.answer}
                  persistent={turn.status !== "ok"}
                />
              </>
            )}
            {!live &&
              turn.answer === "" &&
              turn.status === "ok" &&
              turn.steps.length > 0 && (
                <p className={styles.note}>本轮没有产出回答</p>
              )}
            {!live && turn.status !== "ok" && (
              <p className={styles.note}>
                {turn.status === "error" ? "本轮失败" : "本轮被停止"}
              </p>
            )}
          </section>
        );
      })}
    </>
  );
}
