"use client";

// ============================================================
// ContextMeter —— 上下文占用圆环（C13，抄 DSH ContextMeter）
// ============================================================
// 形态：发送按钮旁的 14px SVG 圆环（strokeDasharray 按百分比填充），
// 点击展开面板：占用百分比 + 数字（~32K / 128K）+ 条形图。
// 数据源：后端 fetchHistory / done 帧携带的 contextPressure。
// 抄 DSH `ui-conversation/src/client/skeleton/ContextMeter.tsx`：
//   - contextOccupancy 纯函数算 percent（app/lib/context-occupancy.ts）
//   - 无数据（分子或容量未知）→ 不渲染（优雅降级）
//   - 外部点击 / Esc 关闭（Menu 同款模式）
// 简化（vs DSH）：无 Tooltip 原语（用 title）；无 system/tools/messages
// 分段 breakdown（后端暂无该 heuristics，留接口）。
// ============================================================

import { useEffect, useRef, useState } from "react";
import styles from "./context-meter.module.css";
import {
  contextOccupancy,
  type ContextPressure,
} from "@/app/lib/context-occupancy";
import type { CacheStats } from "@/app/lib/cache-stats";

/** 圆环几何：14px viewBox、2px stroke */
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 紧凑数字格式：<1K 原样、<1M 用 K、否则 M（DSH formatTokens 同款） */
function formatTokens(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100
      ? String(Math.round(candidate))
      : String(Math.round(candidate * 10) / 10);
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/**
 * 缓存那一块底部的小字（C68）。三种形态各有各的说法 —— 见
 * `app/lib/cache-stats` 的文件头：
 *   正常跑完 / 缺数据 → 不写小字（没有要解释的）
 *   中止「有钱」（partial）→ 说明最后那笔没算进来
 *   中止「一笔都没完成」→ 说明数据来源本来就是空
 *   provider 没报 → 说明为什么给不出数
 */
function cacheFootNote(stats: CacheStats | undefined): string {
  if (stats === undefined) return "";
  if (stats.kind === "stopped") return "已停止 · 本轮无数据";
  if (stats.kind === "unknown") return "provider 未报缓存用量";
  return stats.partial ? "已停止 · 最后一笔未计入" : "";
}

/** 面板里的一行读数：左标签 + 右数字（默认 mono 右对齐；`plain` 用于"13 笔"这类文字值） */
function CacheRow({
  label,
  value,
  plain = false,
}: {
  label: string;
  value: string;
  plain?: boolean;
}) {
  return (
    <div className={styles.cacheRow}>
      <span className={styles.cacheKey}>{label}</span>
      <span className={styles.cacheValue} data-plain={plain}>
        {value}
      </span>
    </div>
  );
}

export function ContextMeter({
  pressure,
  cacheStats,
}: {
  pressure: ContextPressure | undefined;
  /**
   * 这一轮的缓存命中读数（C68）。
   * `undefined` = provider 没报 ⇒ 面板里那三行**整块不出现** —— 显示 0% 是在说谎。
   */
  cacheStats: CacheStats | undefined;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const context = contextOccupancy(pressure);
  const available = context !== null;

  // 数据消失（切模型/清空）时关闭已开面板，不保留过期 UI
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- "外部数据消失 → 关掉过期面板"只能由 effect 驱动；改成派生值要动组件状态模型（重构级改动）→ 见池子 C46
    if (!available && open) setOpen(false);
  }, [available, open]);

  // 外部点击 / Esc 关闭（Menu 同款模式）
  useEffect(() => {
    if (!open || !available) return undefined;
    const onPointerDown = (e: PointerEvent): void => {
      if (
        e.target instanceof Node &&
        rootRef.current?.contains(e.target) === true
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [available, open]);

  if (context === null) return null;
  const percent = context.percent;
  const reading = `${percent}%`;
  const footNote = cacheFootNote(cacheStats);

  return (
    <span ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={styles.trigger}
        data-high={percent >= 75} // 高占用警示色（CSS .trigger[data-high]）
        title={`上下文已用 ${reading}（约 ${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}）`}
        aria-label={`上下文已用 ${reading}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
          <circle className={styles.track} cx="7" cy="7" r={RADIUS} />
          <circle
            className={styles.fill}
            cx="7"
            cy="7"
            r={RADIUS}
            strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
      </button>
      {/* C68：常驻读数 —— 不点开也知道上下文占了百分之几。
          高占用时跟圆环填充一起转警示色（两处不一致会让人以为哪个坏了）。 */}
      <span className={styles.reading} data-high={percent >= 75}>
        {reading}
      </span>
      {open && (
        <div
          className={styles.panel}
          role="dialog"
          aria-label={`上下文已用 ${reading}`}
        >
          <div className={styles.header}>
            <span className={styles.percent}>{reading}</span>
            <span className={styles.headline}>上下文已用</span>
            <span className={styles.figures}>
              {`~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`}
            </span>
          </div>
          <div className={styles.bar}>
            <div className={styles.segment} style={{ width: `${percent}%` }} />
          </div>
          {/* C68：这一轮的缓存账（**累计**口径：从最后一条 user 消息起）。
              三种形态各有各的说法，见 app/lib/cache-stats 的文件头。 */}
          {cacheStats !== undefined && (
            <div className={styles.cache}>
              {cacheStats.kind === "measured" && (
                <>
                  <CacheRow
                    label="本轮调用"
                    value={`${cacheStats.calls} 笔`}
                    plain
                  />
                  <CacheRow
                    label="累计输入"
                    value={formatTokens(cacheStats.input)}
                  />
                  <CacheRow
                    label="命中缓存"
                    value={formatTokens(cacheStats.cached)}
                  />
                  <CacheRow label="命中率" value={`${cacheStats.percent}%`} />
                </>
              )}
              {cacheStats.kind === "stopped" && (
                <CacheRow label="本轮调用" value="0 笔" plain />
              )}
              {cacheStats.kind === "unknown" && (
                <CacheRow label="本轮用量" value="未知" plain />
              )}
              {footNote !== "" && <div className={styles.foot}>{footNote}</div>}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
