// ============================================================
// useElapsed —— 一个共享的每秒心跳（"还在跑多久"的计时器用）
// ============================================================
// 为什么不是每个组件各自 setInterval：
//   侧栏可能同时有几行在跑（B22 允许多会话并行）⇒ N 个定时器各自 tick、
//   各自重渲，还互相错相位。这里只有**一个** interval，订阅者各自算
//   「现在 − 起点」；订阅者清零时把它停掉 —— 没在跑的时候整页零定时器。
//
// 只关心**秒**，所以固定 1000ms；不用 requestAnimationFrame（那是给动画的）。
//
// 返回值是**毫秒差**（`Date.now() - startedAt`），格式化交给纯函数
// `formatElapsed`（`app/lib/transcript`，有单测）。这个 hook 自己不做格式化：
// 一个只算差值、一个只排版，两边都能单独看懂。
// ============================================================

import { useEffect, useState } from "react";

const TICK_MS = 1000;

/** 订阅者集合 + 唯一的定时器（模块级：跨组件共享，跟 render 无关） */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // **先立刻给一次当前值**：切到一条"已经在跑"的会话时，第一帧就该显示 2:41，
  // 而不是停一秒的 0:00。放在这里而不是 effect 里直接 setState，是因为
  // `react-hooks/set-state-in-effect` 明令禁止后者（那条规则拦过我一次）。
  listener();
  if (timer === undefined) {
    timer = setInterval(() => {
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * 从 `startedAt` 到现在过了多少毫秒，每秒更新一次。
 *
 * - `startedAt === undefined`（没在跑 / 刷新过）⇒ 返回 `undefined`，**不订阅**
 *   —— 界面据此不渲染计时器，也不会为此重渲。
 * - 起点变了（新一轮 run）⇒ effect 用新起点重新订阅。
 */
export function useElapsed(startedAt: number | undefined): number | undefined {
  // "现在"住在 state 里，**不在渲染期读时钟**。
  // 起因很具体：第一版写的是 `return Date.now() - startedAt`，被 `react-hooks/purity`
  // 拦下（"Cannot call impure function during render"）。它是对的 —— 渲染必须是幂等的，
  // 读时钟就不是。改成：tick 负责把 now 写进 state，渲染只做减法。
  const [now, setNow] = useState(startedAt ?? 0);

  useEffect(() => {
    if (startedAt === undefined) return undefined;
    // 不需要在这里再 setNow 一次：`subscribe` 会在订阅时先给一次当前值
    return subscribe(() => setNow(Date.now()));
  }, [startedAt]);

  if (startedAt === undefined) return undefined;
  return now > startedAt ? now - startedAt : 0;
}
