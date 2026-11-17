// ============================================================
// approval —— 工具审批决策纯函数单测（E2 步骤 2 / C55 补记 14）
// ============================================================
// 从 route.ts handleToolApproval 提炼的纯决策函数 decideToolCall。
// 外部依赖（审批模式 / 工作空间根）全部注入 ctx，函数本身纯：
// 同输入必同输出，node 环境直接测。
//
// ⭐ 2026-11-17 的两处收紧，各有一组用例守着：
//   ① **bash 不再看命令内容**：以前"只读命令"自动放行，现在一律弹框。
//   ② **审批不再有记忆**：ctx 里已经没有 isSessionApproved / isPersistApproved，
//      所以"点过一次就一直放行"这个洞在类型上就不存在了。

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideToolCall, type ApprovalContext } from ".";

// 工具调用构造器（最小化）
function call(name: string, args: Record<string, unknown> = {}) {
  return { type: "toolCall" as const, id: "call_1", name, arguments: args };
}

// ⚠️ 为什么工作空间根要用**真目录**（mkdtemp）而不是 "/work/proj-a"：
// 判定现在是 realpath 驱动的（C55 补记 14），假路径上 realpath 一律走
// "最近的已存在祖先"回退 —— 那测的是回退分支，不是真实判定。
let base = "";
let WORKSPACE = "";
let OUTSIDE = "";

// 默认 ctx：suggest 模式
function ctx(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    workspaceRoot: WORKSPACE,
    getApprovalMode: () => "suggest",
    ...overrides,
  };
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "statve-approval-"));
  WORKSPACE = join(base, "ws");
  OUTSIDE = join(base, "outside");
  mkdirSync(WORKSPACE);
  mkdirSync(OUTSIDE);
  // 工作空间里的一条 junction，指向根外（用来测 linked 分支）
  symlinkSync(OUTSIDE, join(WORKSPACE, "link"), "junction");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("decideToolCall —— secret/秘密 硬拦截", () => {
  it("write_file 含 secret 文件名 → block（不弹框）", () => {
    const r = decideToolCall(
      call("write_file", { path: "secret-key.txt" }),
      ctx(),
    );
    expect(r.action).toBe("block");
  });

  it("write_note 含 秘密 文件名 → block", () => {
    const r = decideToolCall(
      call("write_note", { fileName: "秘密笔记.md" }),
      ctx(),
    );
    expect(r.action).toBe("block");
  });

  it("write_file 普通文件名 → 不拦截（走后续判定 → request）", () => {
    // 收紧：断言精确到 request（需要弹框），而不是"不是 block"——
    // not.toBe("block") 会把误 allow 也放行，测不出"走了后续判定"
    const r = decideToolCall(call("write_file", { path: "notes.md" }), ctx());
    expect(r.action).toBe("request");
  });
});

describe("decideToolCall —— 分级模式", () => {
  it("bypass 模式：除硬拦截外全部放行（不弹框）", () => {
    const c = ctx({ getApprovalMode: () => "bypass" });
    expect(decideToolCall(call("write_file", { path: "x.ts" }), c).action).toBe(
      "allow",
    );
  });

  it("never 模式 + 需确认工具 → block", () => {
    const r = decideToolCall(
      call("write_file", { path: "x.ts" }),
      ctx({ getApprovalMode: () => "never" }),
    );
    expect(r.action).toBe("block");
  });

  it("never 模式 + 只读工具 → allow（不在确认名单）", () => {
    const r = decideToolCall(
      call("read_file", { path: "x.ts" }),
      ctx({ getApprovalMode: () => "never" }),
    );
    expect(r.action).toBe("allow");
  });
});

// ============================================================
// bash：一律弹框（2026-11-17 删掉"只读命令自动放行"）
// ============================================================
describe("decideToolCall —— bash 不再做静态分析", () => {
  it.each([
    "Get-Content a.txt", // 看起来只读
    "git status", // 看起来只读
    "Set-Content a.txt hello", // 明显写
    "Get-Content $env:USERPROFILE\\.ssh\\id_rsa", // 只读，但路径在根外（旧实现的洞）
    "cat ../secrets.txt", // 只读，但越界
  ])("suggest 模式下一律 request：%s", (command) => {
    expect(decideToolCall(call("bash", { command }), ctx()).action).toBe(
      "request",
    );
  });

  it("对照：bypass 下 bash 仍然放行（模式是唯一的「别再问」开关）", () => {
    expect(
      decideToolCall(
        call("bash", { command: "Get-Content a.txt" }),
        ctx({ getApprovalMode: () => "bypass" }),
      ).action,
    ).toBe("allow");
  });

  it("对照：never 下 bash 直接拒绝", () => {
    expect(
      decideToolCall(
        call("bash", { command: "git status" }),
        ctx({ getApprovalMode: () => "never" }),
      ).action,
    ).toBe("block");
  });
});

describe("decideToolCall —— list_files 补默认参数", () => {
  it("list_files 无 path → rewrite 补 '.'", () => {
    const r = decideToolCall(call("list_files", {}), ctx());
    expect(r.action).toBe("rewrite");
    if (r.action === "rewrite") {
      expect(r.args).toEqual({ path: "." });
    }
  });

  it("list_files 有 path → 不动", () => {
    expect(
      decideToolCall(call("list_files", { path: "src" }), ctx()).action,
    ).toBe("allow");
  });
});

describe("decideToolCall —— 只读工具默认放行", () => {
  it("read_file / grep / find → allow", () => {
    for (const name of ["read_file", "grep", "find"]) {
      expect(decideToolCall(call(name), ctx()).action).toBe("allow");
    }
  });
});

describe("decideToolCall —— A5 的两个 web 工具不弹框", () => {
  it("web_fetch / web_search → allow（只读放行，不在 TOOLS_NEEDING_CONFIRM）", () => {
    // ⭐ 这不是"顺带断言"，它钉的是一条**设计决策**（A5 详案）：
    // web_fetch 之所以要拦 loopback，正是因为它是**放行档、没人把关**。
    // 哪天有人把它加进 TOOLS_NEEDING_CONFIRM，那条决策的前提就变了——
    // 这条用例会红，提醒去重读 A5 详案。
    for (const name of ["web_fetch", "web_search"]) {
      expect(decideToolCall(call(name), ctx()).action).toBe("allow");
    }
  });

  it("对照：确认清单里的 bash → request（证明上面的 allow 不是恒真）", () => {
    // 没有这条对照，上面那条在"所有工具都放行"的实现下也会绿——等于没测。
    expect(decideToolCall(call("bash", { command: "ls" }), ctx()).action).toBe(
      "request",
    );
  });
});

// ============================================================
// 越界（C55）：不是"放行"，是"升级成更危险的弹框"
// ============================================================
// 判据来自详案 4.6：bypass/never 直接拒；suggest 弹框并带 danger。
describe("decideToolCall —— 越界（人写在外面的路径）", () => {
  const outsidePath = () => join(OUTSIDE, "outside.md");

  it("suggest：越界写 → request + danger（带绝对路径）", () => {
    const decision = decideToolCall(
      call("write_file", { path: outsidePath() }),
      ctx(),
    );

    expect(decision.action).toBe("request");
    if (decision.action !== "request") return;
    expect(decision.danger?.kind).toBe("outside-workspace");
    expect(decision.danger?.targets).toHaveLength(1);
    expect(decision.danger?.targets[0]).toMatch(/outside\.md$/);
  });

  it("越界对**只读工具**同样生效（read_file 平时不弹框）", () => {
    expect(
      decideToolCall(call("read_file", { path: outsidePath() }), ctx()).action,
    ).toBe("request");
  });

  it("界内不受影响：写工作区内的文件仍走普通确认（无 danger）", () => {
    const decision = decideToolCall(
      call("write_file", { path: "notes/a.md" }),
      ctx(),
    );
    expect(decision.action).toBe("request");
    if (decision.action !== "request") return;
    expect(decision.danger).toBeUndefined();
  });

  it("⭐ bypass（YOLO）下越界 = **block**，不是 allow（否则 YOLO 把围栏也关了）", () => {
    const decision = decideToolCall(
      call("write_file", { path: outsidePath() }),
      ctx({ getApprovalMode: () => "bypass" }),
    );
    expect(decision.action).toBe("block");
  });

  it("never 下越界 = block", () => {
    expect(
      decideToolCall(
        call("write_file", { path: outsidePath() }),
        ctx({ getApprovalMode: () => "never" }),
      ).action,
    ).toBe("block");
  });

  it("⭐ secret 判定**先于**越界：写 .env 直接拦，不给「问人」的机会", () => {
    const decision = decideToolCall(
      call("write_file", { path: join(OUTSIDE, "secret.md") }),
      ctx(),
    );
    expect(decision.action).toBe("block");
  });
});

// ============================================================
// 软链出去（C55 补记 14）：**不问，直接拒**
// ============================================================
// 与上面的 `outside` 分开：`outside` 是人自己写下的路径（弹框里显示的就是它，
// 人看得懂自己在批什么）；`linked` 是"看起来在根内、落点在根外"，工作空间的
// 内容不能自己扩大允许的根 ⇒ 不给"问人"这条路，也就没有"点一次记住"可谈。
describe("decideToolCall —— 软链出去 = block（不弹 danger 框）", () => {
  it("read_file 穿链 → block，且理由说清是软链", () => {
    const r = decideToolCall(call("read_file", { path: "link/x.txt" }), ctx());
    expect(r.action).toBe("block");
    if (r.action !== "block") return;
    expect(r.reason).toMatch(/软链|junction/);
  });

  it("write_file 穿链 → block（写和读一个待遇）", () => {
    expect(
      decideToolCall(call("write_file", { path: "link/x.txt" }), ctx()).action,
    ).toBe("block");
  });

  it("对照：**不穿链**的同一个目标（绝对路径）→ request（证明上面的 block 不是恒真）", () => {
    const decision = decideToolCall(
      call("read_file", { path: join(OUTSIDE, "x.txt") }),
      ctx(),
    );
    expect(decision.action).toBe("request");
  });
});
