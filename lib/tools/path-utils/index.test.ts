// ============================================================
// path-utils —— 路径沙箱（A2 第一个测试）
// ============================================================
// 为什么先测它：resolveInsideWorkspace 是所有文件工具的"围栏"，
// 越界拒绝是安全底线——这个坏了，write/read/edit 全都不安全。
//
// ⭐ 2026-11-17（C55 补记 14）：判据挪进 `lib/permission/tool-escape` 的
// `inspectPath`（realpath 之后再看包含），围栏只负责"消费凭据 / 抛错"。
// 所以这个文件里出现了**真文件系统**的用例（mkdtemp + junction）：
// "穿软链越界"这条没法用假路径测。
// ============================================================

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEscapePermits } from "../../permission/tool-escape";
import { resolveInsideWorkspace, stringArg } from ".";

// 用虚拟 workspace 根（不碰真实文件系统，纯路径逻辑）
const ROOT = resolve("C:/fake/workspace");

describe("stringArg —— 可选字符串参数的兜底", () => {
  it("字符串直接返回", () => {
    expect(stringArg("abc", "fallback")).toBe("abc");
  });

  it("空串/纯空白回退到 fallback", () => {
    expect(stringArg("", "fallback")).toBe("fallback");
    expect(stringArg("   ", "fallback")).toBe("fallback");
  });

  it("非字符串回退到 fallback", () => {
    expect(stringArg(undefined, "fallback")).toBe("fallback");
    expect(stringArg(null, "fallback")).toBe("fallback");
    expect(stringArg(123, "fallback")).toBe("fallback");
  });
});

describe("resolveInsideWorkspace —— 路径沙箱", () => {
  it("工作区内的相对路径正常解析", () => {
    expect(resolveInsideWorkspace(ROOT, "a.txt")).toBe(resolve(ROOT, "a.txt"));
  });

  it("嵌套相对路径正常解析", () => {
    expect(resolveInsideWorkspace(ROOT, "notes/x.md")).toBe(
      resolve(ROOT, "notes/x.md"),
    );
  });

  it("'.' 解析为工作区根本身", () => {
    expect(resolveInsideWorkspace(ROOT, ".")).toBe(ROOT);
  });

  it("工作区内的绝对路径放行（resolve 后仍在根内）", () => {
    const inside = resolve(ROOT, "sub/file.txt");
    expect(resolveInsideWorkspace(ROOT, inside)).toBe(inside);
  });

  it("'..' 越界抛错", () => {
    expect(() => resolveInsideWorkspace(ROOT, "../x")).toThrow(/路径越界/);
  });

  it("深层 '..' 越界抛错", () => {
    expect(() => resolveInsideWorkspace(ROOT, "a/../../x")).toThrow(/路径越界/);
  });

  it("根外的绝对路径抛错", () => {
    expect(() => resolveInsideWorkspace(ROOT, "C:/outside/x")).toThrow(
      /路径越界/,
    );
  });

  // ⚠️ **跨盘符**（C33，2026-09-21 补）：Windows 上 `relative()` 表达不出跨盘符相对路径时，
  // 会把 target **原样返回**（一个绝对路径），而绝对路径不以 `..` 开头 ⇒ 旧判定放行。
  // **老用例碰不到它**：上面那条 `C:/outside/x` 与本夹具 `ROOT` **同盘**（都是 C:），
  // 所以这条路径从来没被走过 —— 测试覆盖的形状和真实越界的形状不一样。
  //
  // 夹具为什么是真的（不是编的）：本机的工作区在 **E:**（`<仓库>/workspace`），
  // 而用户的技能根在 **C:**（`~/.agents/skills`）—— 2026-09-16 真机撞出的正是这两个盘：
  // 只读、**免审批**的 `read_file` 读到了 `C:\Users\…\.agents\skills\…`。
  it.skipIf(process.platform !== "win32")(
    "跨盘符的绝对路径抛错（C33：另一盘的文件也出不去）",
    () => {
      expect(() => resolveInsideWorkspace(ROOT, "E:/outside/x")).toThrow(
        /路径越界/,
      );
    },
  );

  // 2026-11-17 改：以前这里要求 `sub/..` **抛错**（"rel 为空但 input 含 .."防御）。
  // 现在它解析成**工作区根本身** —— 因为 `..` 在 `resolve()` 里已经被折叠，
  // 它指不到任何根外的东西；把"读根目录"当越界既没有安全收益，又让审批层
  // （认为 inside、不弹框）和围栏（抛错）说出两套话。
  it("'sub/..' 折叠成工作区根本身（不是越界）", () => {
    expect(resolveInsideWorkspace(ROOT, "sub/..")).toBe(ROOT);
  });
});

// ============================================================
// 软链 / junction（C55 补记 14）：字面在根内、真实落点在根外
// ============================================================
describe("resolveInsideWorkspace —— 穿软链的越界", () => {
  let base = "";
  let workspace = "";
  let outside = "";

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "statve-fence-"));
    workspace = join(base, "ws");
    outside = join(base, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    // junction = Windows 目录联接（不需要管理员权限）
    symlinkSync(outside, join(workspace, "link"), "junction");
    mkdirSync(join(workspace, "real"));
    symlinkSync(join(workspace, "real"), join(workspace, "alias"), "junction");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("⭐ 穿链到根外 → 抛错，而且说清是「软链」（模型才知道该怎么改）", () => {
    expect(() => resolveInsideWorkspace(workspace, "link/x.txt")).toThrow(
      /软链|junction/,
    );
  });

  it("⭐ 报错**不说**链指向哪（否则照着路径重发一次就绕过了这条规则）", () => {
    let message = "";
    try {
      resolveInsideWorkspace(workspace, "link/x.txt");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(outside);
  });

  it("穿链但落点在根内 → 放行，且返回**真实路径**（执行时用的就是它）", () => {
    expect(resolveInsideWorkspace(workspace, "alias/x.txt")).toBe(
      join(workspace, "real", "x.txt"),
    );
  });

  it("越界凭据不能替软链开锁：批准过的目标 ≠ 链的落点就不会被消费", () => {
    const permits = createEscapePermits();
    permits.grant([join(outside, "other.txt")]);
    expect(() =>
      resolveInsideWorkspace(workspace, "link/x.txt", permits),
    ).toThrow(/软链|junction/);
    // 凭据还在（没被这条调用白白吃掉）
    expect(permits.consume(join(outside, "other.txt"))).toBe(true);
  });
});

// ============================================================
// 一次性通行证（C55）：人批准过的越界，只放行这一次
// ============================================================
// 真实场景：用户在工作空间里干活，模型要读一个工作区外的文件；弹框之后
// 用户点「仍要执行」—— 围栏必须**恰好放行这一条**，而且只能用一次。
describe("resolveInsideWorkspace —— 越界 + 一次性通行证", () => {
  const OUTSIDE = resolve("C:/other/secret.txt");

  it("没有凭据：越界照旧抛错（回归）", () => {
    expect(() => resolveInsideWorkspace(ROOT, OUTSIDE)).toThrowError(/越界/);
  });

  it("有凭据：第一次放行，**第二次**同一目标仍然抛错（一次性）", () => {
    const permits = createEscapePermits();
    permits.grant([OUTSIDE]);

    expect(resolveInsideWorkspace(ROOT, OUTSIDE, permits)).toBe(OUTSIDE);
    // 凭据已被消费 ⇒ 模型再调一次同样的越界，还得重新问人
    expect(() => resolveInsideWorkspace(ROOT, OUTSIDE, permits)).toThrowError(
      /越界/,
    );
  });

  it("凭据只对**批准的路径**生效：别的越界目标照样抛错", () => {
    const permits = createEscapePermits();
    permits.grant([OUTSIDE]);

    expect(() =>
      resolveInsideWorkspace(ROOT, resolve("C:/other/other.txt"), permits),
    ).toThrowError(/越界/);
  });
});
