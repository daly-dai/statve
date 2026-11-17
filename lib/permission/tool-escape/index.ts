// ============================================================
// 越界判定与一次性通行证（C6 详案 4.6 / C55）—— 纯判定 + 一次性凭据
// ============================================================
// 围栏今天只在工具里"发现越界就抛错"。这一层把"越界"提前成一个可判定的事实，
// 让审批链路能在**执行前**问人 —— 而不是等工具报错之后模型自己猜。
//
// 为什么住 lib 而不是 app：**围栏（lib/tools/path-utils）要消费通行证**，而 lib 不许
// 反向依赖 app（分层第 6 条）。所以"判定 + 凭据"都是内核能力，app 只负责接线。
//
// ⭐ **判据只有一份**（2026-11-17，抄 DSH `sandbox/src/roots.ts` 的"单一推导处"）：
// `inspectPath` 是唯一算出"这个目标到底在哪"的地方；围栏（tools/path-utils）与
// 审批（app 的 decision）都调它。以前两边各写一遍"是否在根内" —— 两份实现迟早
// 漂移，而漂移的方向必然是"一边放行、一边以为是拦着"。
//
// 两条边界必须记住：
//   ① 只有"参数里带路径"的 7 个工具参与判定；`write_note`（fileName 已净化）
//      和 `bash`（命令里的路径没法静态解析）不参与。
//   ② `bash` **不判定**：它一律进入人工确认（C55 补记 14）。以前这里有一条
//      "只读命令自动放行"的粗筛 —— 2026-11-17 删掉了，理由见 `hasEscapeTraces`
//      的墓碑注释。

import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/**
 * 一个路径的三种结局。**`linked` 是这次（2026-11-17）新加的那一种**：
 * 字面路径在工作空间内，但跟到真实位置（realpath）之后出去了 —— 也就是
 * 工作空间里藏着一条软链（symlink，符号链接）/ junction（Windows 的目录联接），
 * 指向外面。
 */
export type EscapeVerdict =
  | { kind: "inside"; target: string }
  | { kind: "outside"; target: string }
  | { kind: "linked"; target: string };

/** 审批层用的分类（形状沿用 C55：`inside` 不带目标） */
export type EscapeClass =
  | { kind: "inside" }
  | { kind: "outside"; targets: string[] }
  | { kind: "linked"; targets: string[] };

/** 参与越界判定的工具 → 它的路径参数名 + 缺省值 */
const PATH_TOOLS: Record<string, { argument: string; fallback: string }> = {
  read_file: { argument: "path", fallback: "" },
  write_file: { argument: "path", fallback: "" },
  edit_file: { argument: "path", fallback: "" },
  delete_file: { argument: "path", fallback: "" },
  grep: { argument: "path", fallback: "." },
  find: { argument: "path", fallback: "." },
  list_files: { argument: "path", fallback: "." },
};

/**
 * 这次工具调用有没有越出工作空间。
 * 输入 `call` 用结构类型（只需要 name + arguments），不依赖引擎的类型。
 */
export function classifyEscape(
  call: { name: string; arguments: Record<string, unknown> },
  workspaceRoot: string,
): EscapeClass {
  const tool = PATH_TOOLS[call.name];
  if (tool === undefined) return { kind: "inside" };

  const raw = call.arguments[tool.argument];
  const input = typeof raw === "string" ? raw : tool.fallback;
  const verdict = inspectPath(workspaceRoot, input);

  return verdict.kind === "inside"
    ? { kind: "inside" }
    : { kind: verdict.kind, targets: [verdict.target] };
}

/**
 * 目标路径的最终裁决：它在工作空间的里面、外面，还是"看起来在里面、其实是条链"。
 *
 * ⭐ 为什么要 realpath（2026-11-17 补，抄 pi-web `lib/path-security.ts` 与
 * DSH `sandbox/src/roots.ts`）：
 *   - 只做字符串解析时，`<根>/link/secret.txt` 里的 `link` 是不是软链、
 *     指向哪，**字符串永远不知道**；而这个判断错了的后果是"围栏以为自己在拦"。
 *   - 两个参考项目都先把路径**规范化（canonicalize）**再判包含，而且 DSH 把
 *     "规范化根"收敛到**一处**，让文件围栏和 bash 沙箱不可能各推一份、各错一处。
 *   - Windows 上还要按**大小写不敏感**比较（同一个目录 `E:\work` 与 `e:\work`
 *     是同一条）；`realpath` 返回的是磁盘上的规范大小写，天然对齐。
 *
 * `linked` 与 `outside` 分开，是因为**两者该有不同的处置**：
 *   - `outside`：模型自己写下的路径（`..` / 别的盘 / 绝对路径）→ 可以问人
 *     （弹框里显示的就是它，人看得懂自己在批准什么）。
 *   - `linked`：路径**看起来**在工作空间里，真正落点却在外面 → 不问、直接拒。
 *     理由：工作空间里的内容（比如一个仓库）**不能自己扩大允许的根**
 *     （pi-web `linked-directory.ts` 的原则）。今天也没有"记住这条链可信"的
 *     持久白名单，每次都问 ⇒ 只会训练用户无脑点「仍要执行」。
 */
export function inspectPath(
  workspaceRoot: string,
  input: string,
): EscapeVerdict {
  const root = canonicalize(workspaceRoot);
  // 字面路径（`..` 已折叠）—— 用它区分"人写的就是外面"和"只有跟链才到外面"
  const literalRoot = resolve(workspaceRoot);
  const lexical = resolve(literalRoot, input);
  const target = canonicalize(lexical);

  if (isWithin(root, target)) return { kind: "inside", target };
  // ⚠️ 这里必须拿**字面根 vs 字面路径**比，不能用 `isInside`：
  // `isInside` 会先把 lexical 也规范化 —— 那等于拿真实落点跟自己比，
  // 结果恒为"外面"，`linked` 就永远判不出来（2026-11-17 实测踩过）。
  return isWithin(literalRoot, lexical)
    ? { kind: "linked", target }
    : { kind: "outside", target };
}

/**
 * 一次性放行凭据：人批准一条越界之后，只放行**这一条**。
 * 不做 "本会话允许" 也不写持久规则 —— 越界不该被记住（详案 4.6 ③）。
 */
export type EscapePermits = {
  grant(targets: string[]): void;
  consume(target: string): boolean;
};

export function createEscapePermits(): EscapePermits {
  const granted = new Set<string>();

  return {
    grant(targets) {
      for (const target of targets) granted.add(resolve(target));
    },
    consume(target) {
      const normalized = resolve(target);
      if (!granted.has(normalized)) return false;
      granted.delete(normalized);
      return true;
    },
  };
}

/**
 * 目标是否落在工作空间内 —— **按真实位置判**（与 `inspectPath` 同源）。
 * 两边都会先 `canonicalize`，所以"根自己是个软链"也不会误判。
 */
export function isInside(workspaceRoot: string, target: string): boolean {
  return isWithin(canonicalize(workspaceRoot), canonicalize(target));
}

/**
 * 纯字符串包含判定（两个入参必须**已经同源规范化**：都是 realpath，或都是字面路径）。
 * 单独拆出来，是因为 `inspectPath` 需要拿"字面根 vs 字面路径"再判一次 ——
 * 那一次要的正是"没跟过链"的答案。
 */
function isWithin(root: string, target: string): boolean {
  const rel = relative(foldCase(root), foldCase(target));
  // Windows 跨盘符时 relative() 会把绝对路径原样返回 ⇒ isAbsolute(rel) 必须一起判
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// ------------------------------------------------------------
// 路径规范化（canonicalize）
// ------------------------------------------------------------

/** 真实位置；不存在时退到"最深的已存在祖先 + 剩余尾部" */
function canonicalize(path: string): string {
  return realpathOrParent(resolve(path));
}

/**
 * `realpath` 拿不到（目标还不存在，比如要新建文件）时，**逐段向上**找到第一个
 * 存在的祖先、对它取 realpath，再把尾部拼回去。
 *
 * ⚠️ 只对 `ENOENT` / `ENOTDIR` 降级。权限类错误（EACCES / EPERM）**必须抛**：
 * 静默退回字面路径 = 拿一个没跟过链的字符串去判包含 —— 那正是这次要堵的洞。
 */
function realpathOrParent(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw e;

    const parent = dirname(path);
    // 已经到盘符根/文件系统根还不存在 ⇒ 只能认字面路径
    if (parent === path) return path;
    return join(realpathOrParent(parent), basename(path));
  }
}

/** Windows 路径大小写不敏感：比较前统一折叠（其它平台原样） */
function foldCase(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
