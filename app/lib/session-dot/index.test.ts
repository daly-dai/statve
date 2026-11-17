import { describe, expect, it } from "vitest";
import type { RunPhase } from "../run-fold";
import {
  EMPTY_READING,
  advanceRead,
  recordRunEnd,
  sessionDotFor,
  type DotKind,
  type ReadingRecord,
} from "./index";

/**
 * 记录工厂。三个数就是 run-store 收尾时写进去的真值：`endedSeq` 来自自增
 * 计数器、`failed` 来自"没收完 done 帧"、`readSeq` 只在人看见之后才追上。
 * 用例名直接写"真机上怎么发生"（对应 doc/plan/session-sidebar-ux.md 8.7 的场景表），
 * 不造真实数据里不存在的状态。
 */
function reading(
  endedSeq: number,
  failed: boolean,
  readSeq: number,
): ReadingRecord {
  return { endedSeq, failed, readSeq };
}

type Case = {
  name: string;
  phase: RunPhase;
  isCurrent: boolean;
  record?: ReadingRecord;
  expected: DotKind;
};

const cases: readonly Case[] = [
  // ── 正在发生：只看"此刻"，不看"读没读过" ──
  {
    name: "场景1：我在 A 且 A 在跑 → 不点",
    phase: "running",
    isCurrent: true,
    expected: "none",
  },
  {
    name: "场景2：A 跑着，我切到 B → 转圈",
    phase: "running",
    isCurrent: false,
    expected: "running",
  },
  {
    name: "场景3：A 还在跑，我切回 A → 不点",
    phase: "running",
    isCurrent: true,
    expected: "none",
  },
  {
    name: "场景4：再切到 B（A 还在跑）→ 又是转圈",
    phase: "running",
    isCurrent: false,
    expected: "running",
  },
  // 场景 1 与 3、2 与 4 的输入相同 —— 这正是要点：函数看不到历史，
  // "第一次进来"和"第二次切回来"在数据上就是同一件事。
  {
    name: "场景11：A 在后台等我批准 → 黄点",
    phase: "waiting-approval",
    isCurrent: false,
    expected: "waiting",
  },
  {
    name: "场景12：我切回去看一眼没批、又走 → 仍然黄点",
    phase: "waiting-approval",
    isCurrent: false,
    expected: "waiting",
  },
  {
    name: "追问（不进场景表）：我在 A，A 卡在等确认 → 不点",
    phase: "waiting-ask",
    isCurrent: true,
    expected: "none",
  },

  // ── 结局：只有"没看过这一次"才亮 ──
  {
    name: "场景5：A 在后台跑完（成功）→ 蓝点",
    phase: "done",
    isCurrent: false,
    record: reading(1, false, 0),
    expected: "done",
  },
  {
    name: "场景6：切回 A（它已完成）→ 不点",
    phase: "done",
    isCurrent: true,
    record: reading(1, false, 0),
    expected: "none",
  },
  {
    name: "场景7：切回看过之后，再切走 → 永不亮",
    phase: "done",
    isCurrent: false,
    record: reading(1, false, 1),
    expected: "none",
  },
  {
    name: "场景8：我看着它跑完，再切走 → 不亮（readSeq 已被推到那一次）",
    phase: "done",
    isCurrent: false,
    record: reading(1, false, 1),
    expected: "none",
  },
  {
    name: "场景9：A 在后台跑失败 → 红点",
    phase: "error",
    isCurrent: false,
    record: reading(1, true, 0),
    expected: "error",
  },
  {
    name: "场景10：切回 A 看过，再切走 → 永不亮",
    phase: "error",
    isCurrent: false,
    record: reading(1, true, 1),
    expected: "none",
  },
  {
    name: "场景13：等批准 → 超时失败 → 红点",
    phase: "error",
    isCurrent: false,
    record: reading(1, true, 0),
    expected: "error",
  },
  {
    name: "场景14：我在 A 点了停止，再切走 → 不亮（停止也是已看过的结局）",
    phase: "done",
    isCurrent: false,
    record: reading(1, false, 1),
    expected: "none",
  },
  // 场景 7 / 8 / 14 输入相同：三个故事，同一个数据形态 —— "看过"就是 readSeq 追上 endedSeq。
  // 场景 9 与 13 同理（失败就是失败，等批准超时不是另一种结局）。
  {
    name: "场景15：后台断流（没有 done/error 帧）→ 红点（结局没有'不知道'）",
    phase: "idle",
    isCurrent: false,
    record: reading(1, true, 0),
    expected: "error",
  },
  {
    name: "场景16：看到第 1 次、第 2 次又跑完 → 亮（序号往前滚了）",
    phase: "done",
    isCurrent: false,
    record: reading(2, false, 1),
    expected: "done",
  },
];

describe("sessionDotFor", () => {
  for (const item of cases) {
    it(item.name, () => {
      const actual = sessionDotFor({
        phase: item.phase,
        isCurrent: item.isCurrent,
        record: item.record,
      });
      expect(actual).toBe(item.expected);
    });
  }

  it("冷会话（刷新后 / 从没跑过）：没有记录也不点", () => {
    expect(
      sessionDotFor({ phase: "idle", isCurrent: false, record: undefined }),
    ).toBe("none");
  });

  it("防御：phase 说是 done 但没有记录 —— 不拿 phase 当结局（只有记录能点亮）", () => {
    expect(
      sessionDotFor({ phase: "done", isCurrent: false, record: undefined }),
    ).toBe("none");
  });
});

describe("记录算术", () => {
  it("run 收尾只记结局，不动已读位置", () => {
    const next = recordRunEnd(EMPTY_READING, { seq: 1, failed: false });
    expect(next).toEqual({ endedSeq: 1, failed: false, readSeq: 0 });
  });

  it("新一次收尾覆盖旧的成败（不是累加）", () => {
    const previous = reading(1, true, 1);
    const next = recordRunEnd(previous, { seq: 2, failed: false });
    expect(next).toEqual({ endedSeq: 2, failed: false, readSeq: 1 });
  });

  it("看过之后已读位置追到最新，且幂等（第二次返回同一个引用）", () => {
    const seen = advanceRead(reading(1, false, 0));
    expect(seen.readSeq).toBe(1);
    expect(advanceRead(seen)).toBe(seen);
  });

  it("没跑完过时推进是空操作（返回同一个引用，store 因此不重渲）", () => {
    expect(advanceRead(EMPTY_READING)).toBe(EMPTY_READING);
  });

  it("看过第 1 次之后第 2 次跑完：点回来，看过再灭", () => {
    const afterSecond = recordRunEnd(reading(1, false, 1), {
      seq: 2,
      failed: true,
    });
    expect(
      sessionDotFor({ phase: "error", isCurrent: false, record: afterSecond }),
    ).toBe("error");
    const seen = advanceRead(afterSecond);
    expect(
      sessionDotFor({ phase: "error", isCurrent: false, record: seen }),
    ).toBe("none");
  });
});
