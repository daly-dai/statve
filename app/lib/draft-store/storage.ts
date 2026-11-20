// ============================================================
// draft-store/storage —— 草稿的持久化层（C59 的 B 方案）
// ============================================================
// 这里**只做一件事**：把 `Drafts` 那张表与 localStorage 对齐。
// 为什么和 `index.ts` 分开：那边是纯函数（node 可测），这边碰 `window`
// （只能真机验）。混在一起，单测就得拖一个 localStorage 的桩进来。
//
// 键的形状照既有先例 `todoPanel:dismissed:<sessionId>`（app/components/task-panel）：
// **每个会话一个键**，不是一张大表 —— 删会话就删一个键，不用整表读改写。
//
// ⚠️ 服务端没有 localStorage：Next 对 `use client` 组件也会服务端预渲染。
//    所以这里有 `typeof window` 防护，读写一律走 `store()`。
// ============================================================

import type { Drafts } from "./index";

const PREFIX = "composer:draft:";

const keyOf = (sessionId: string): string => `${PREFIX}${sessionId}`;

/** 拿 localStorage；服务端 / 被用户禁用时返回 undefined（调用处一律当成"没有盘"） */
function store(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

/**
 * 把盘上所有草稿读成一张表（页面挂载后读一次，之后全在内存里）。
 *
 * 为什么是"一次读全量"而不是"切会话时读那一个"：后者要一个 effect + setState
 * **每切一次就跑一次**（还会闪一帧）；一次读全量之后，输入框的值只是
 * `drafts[当前会话]` 的派生，切到哪都对，包括以后新加的切换入口。
 *
 * 顺带丢掉空串的键（历史遗留 / 手动改坏的），让内存里的形状和 `writeDraft` 一致。
 */
export function readAllDrafts(): Drafts {
  const storage = store();
  if (!storage) return {};

  const drafts: Record<string, string> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(PREFIX)) continue;
    const value = storage.getItem(key);
    if (value !== null && value !== "") {
      drafts[key.slice(PREFIX.length)] = value;
    }
  }
  return drafts;
}

/**
 * 写一个会话的草稿（空串 = 删键，不盘上留空壳）。
 *
 * ⚠️ 写盘失败不算错：隐私模式 / 配额满时草稿留不下来，但**发消息不受影响** ——
 * 不能为了"保存草稿"把输入框搞坏。
 */
export function writeDraft(sessionId: string, text: string): void {
  const storage = store();
  if (!storage || sessionId === "") return;
  if (text === "") {
    storage.removeItem(keyOf(sessionId));
    return;
  }
  try {
    storage.setItem(keyOf(sessionId), text);
  } catch {
    /* 写不进去就算了：草稿是增强，不是依赖 */
  }
}

/** 删一个会话的草稿键（发送成功 / 命令执行完 / 会话被删） */
export function eraseDraft(sessionId: string): void {
  const storage = store();
  if (!storage || sessionId === "") return;
  storage.removeItem(keyOf(sessionId));
}
