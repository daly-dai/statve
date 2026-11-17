// ============================================================
// SessionManager —— 会话目录级操作（Phase 2 多会话）
// ============================================================
//
// 布局（唯一一处拼法在 `lib/session/paths`）：
//   <根>/<工作空间键>/<会话目录>/session.jsonl
//                                  /trace.<runId>.jsonl
//
// 本模块管「会话本身」：list / create / rename / delete / locate。
// 对话读写不在这里——那是 JsonlSessionStore 的事（每请求新建）。
//
// 为什么方法都自己扫目录、不留内存索引（2026-11-11）：
//   索引会与磁盘漂移（删了目录索引还在 / 手工放进来的会话查不到），而这里
//   一次 readdir 的量级是「几十个项目 × 几十个会话」，代价远小于"两个真相"。
//
// 为什么列表要扫**所有**项目目录：会话不再有"当前工作区"这个概念 ——
//   侧栏是按工作空间分组的全量列表，所以 `list()` 天然是全局的。
// ============================================================

import {
  readFile,
  readdir,
  rename as renameFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "../../types";
import { messageText } from "../../message";
import { config } from "../../config";
import { JsonlSessionStore } from "../store";
import {
  encodeSegment,
  isValidSessionId,
  projectDir,
  sessionDir,
  sessionLogPathIn,
} from "../paths";

/**
 * 新会话的默认标题（2026-11-17 用户定）。
 * 用户发出第一条消息后由 `adoptFirstMessageAsTitle` 换成那句话；
 * 所以这个字符串同时是"默认名"，也是"还可以被自动改名"的判据。
 */
export const DEFAULT_SESSION_TITLE = "新会话";

/** 自动标题最多几个字（侧栏一行本来就会省略，这里只挡"整段话塞进文件头"） */
const TITLE_MAX_CHARS = 30;

export type SessionSummary = {
  id: string;
  title?: string;
  /** 文件最后修改时间（毫秒），用作「最近活跃」排序与展示 */
  updatedAt: number;
  /** 首条用户消息的文本（截断），列表里给个上下文提示 */
  preview?: string;
  /** 会话所属工作空间的 canonical 路径（来自会话头），分组就靠它 */
  cwd: string;
};

/** 一个会话在磁盘上的三样东西：目录、主日志、工作空间路径 */
export type SessionLocation = {
  dir: string;
  logPath: string;
  cwd: string;
};

export class SessionManager {
  /** 会话根（`config.paths.sessions`），下面一层是工作空间键、再一层是会话目录 */
  constructor(private readonly root: string) {}

  /** 扫全部分组列出所有会话，按最近活跃倒序 */
  async list(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];

    for (const found of await scanSessions(this.root)) {
      const summary = await summarizeSessionFile(found);
      // 坏会话跳过，不挂掉整个列表（半创建的目录 / 手工放进去的垃圾）
      if (summary) summaries.push(summary);
    }

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 新建空会话：先写临时目录再整体改名；title 不传就用默认名；返回生成的 id */
  async create(input: { cwd: string; title?: string }): Promise<string> {
    const id = generateSessionId();
    const targetDir = sessionDir(this.root, input.cwd, id);
    // 临时目录与目标同在「项目目录」下 ⇒ rename 是同一文件系统内的原子操作。
    // 为什么要原子：半创建的会话目录 = 列表里一条打不开的会话（有目录、没头）。
    const tempDir = join(
      projectDir(this.root, input.cwd),
      `.tmp-${encodeSegment(id)}-${Math.random().toString(36).slice(2, 8)}`,
    );

    // 复用 JsonlSessionStore 写头：文件不存在时 loadOrCreate 会建目录 + 写头。
    // 实例用完即弃（没有消息可读），这只是「借它的写头逻辑」。
    new JsonlSessionStore({
      filePath: sessionLogPathIn(tempDir),
      cwd: input.cwd,
      sessionId: id,
      // 2026-11-17 用户定：新会话就叫「新会话」，等第一条消息发出去再改成那句话
      title: input.title?.trim() || DEFAULT_SESSION_TITLE,
    });

    await renameFile(tempDir, targetDir);
    return id;
  }

  /** 重命名：只改文件第一行（头）的 title，其余行不动 */
  async rename(id: string, title: string): Promise<void> {
    const location = await this.locate(id);
    if (!location) throw new Error(`会话不存在：${id}`);

    const raw = await readFile(location.logPath, "utf8");
    const lines = raw.split("\n");
    if (!lines[0]?.trim()) {
      throw new Error(`会话文件为空：${id}`);
    }
    const header = JSON.parse(lines[0]) as SessionEntry;
    if (header.type !== "session") {
      throw new Error(`会话文件头损坏：${id}`);
    }
    // title 为空串 = 清除显示名，回退用 preview/id
    lines[0] = JSON.stringify(
      title.trim()
        ? { ...header, title: title.trim() }
        : { ...header, title: undefined },
    );

    await writeLinesAtomically(location.logPath, lines);
  }

  /**
   * 把「用户说的第一句话」变成标题（2026-11-17 用户定）。
   *
   * 新会话默认叫「新会话」；用户发出第一条消息之后，标题换成那句话——
   * 侧栏就不用再看到一片「新会话」。
   *
   * 三个条件全满足才改，缺一不可（改错了就是把用户起过的名字盖掉）：
   *   ① 会话里**还没有任何消息**（这是第一条）；
   *   ② 头里的 title 为空，或仍是默认的「新会话」（用户手动改过名 ⇒ 不动）；
   *   ③ 替进来的文本非空。
   *
   * 返回 `true` = 改了。**不抛业务错误**（找不到会话 / 文件坏了就返回 false）：
   * 它挂在发消息的路径上，标题改不动不该让这次对话失败。
   */
  async adoptFirstMessageAsTitle(id: string, text: string): Promise<boolean> {
    const title = oneLine(text, TITLE_MAX_CHARS);
    if (!title) return false;

    try {
      const location = await this.locate(id);
      if (!location) return false;

      const lines = (await readFile(location.logPath, "utf8")).split("\n");
      if (!lines[0]?.trim()) return false;

      const entries = lines
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as SessionEntry);
      // ① 已经有消息了 ⇒ 这不是"第一句话"
      if (entries.some((entry) => entry.type === "message")) return false;

      const header = entries[0];
      if (header.type !== "session") return false;
      // ② 用户起过名字 ⇒ 不动
      const current = header.title?.trim();
      if (current && current !== DEFAULT_SESSION_TITLE) return false;

      lines[0] = JSON.stringify({ ...header, title });
      await writeLinesAtomically(location.logPath, lines);
      return true;
    } catch {
      return false;
    }
  }

  /** 删除整个会话目录（含全部轨迹）。会话层不再需要知道轨迹布局：目录就是边界 */
  async delete(id: string): Promise<void> {
    const location = await this.locate(id);
    if (!location) throw new Error(`会话不存在：${id}`);
    // force: 目录已空/只剩轨迹也能删干净；recursive: 轨迹与日志一起走
    await rm(location.dir, { recursive: true, force: true });
  }

  /**
   * 删除**某个工作空间下的全部会话**（删工作空间的连带动作）。
   *
   * 为什么要有它（2026-11-11 用户定："所有会话必须有对应的工作空间，粗暴一点"）：
   * 删工作空间必须是"记录 + 它名下的会话一起走"—— 否则删完的记录会被下一次
   * bootstrap 又补回来（盘上还有会话的 cwd），删了等于没删。
   *
   * 返回删掉的会话数（界面要用它说"共删除 N 个会话"）。
   */
  async deleteSessionsWithCwd(cwd: string): Promise<number> {
    let deleted = 0;

    for (const found of await scanSessions(this.root)) {
      const location = await readLocation(found);
      if (!location || location.cwd !== cwd) continue;
      await rm(location.dir, { recursive: true, force: true });
      deleted += 1;
    }

    return deleted;
  }

  /**
   * 只在「一条对话消息都没有」时删除。
   * 返回 `true` = 真删了；`false` = 里面已经有内容，**一个字节不动**。
   *
   * 什么时候用（2026-11-17 用户定）：「新增工作空间会自动开一条会话」，
   * 用户**切换走**的那一刻，如果这条会话还是空的，就把它删掉 ——
   * 侧栏不留一条"没人说过话"的会话。
   *
   * 为什么服务端要再判一次（客户端明明知道当前会话是不是空的）：客户端的视图可能
   * 是**过期的**（会话还没加载完 / 另一个标签页刚在里面说过话），而删除不可逆 ——
   * 所以判据以**磁盘**为准，这就是"fail-closed"（拿不准就不删）。
   */
  async deleteIfEmpty(id: string): Promise<boolean> {
    const location = await this.locate(id);
    if (!location) throw new Error(`会话不存在：${id}`);
    // 有内容 ⇒ 一个字节不动（这是本方法存在的全部意义）
    if (await hasMessages(location.logPath)) return false;
    await this.delete(id);
    return true;
  }

  /**
   * 按 id 找会话（扫所有项目目录，拿目录名与 `encodeSegment(id)` 比）。
   * 为什么用编码比而不是读头里的 id：编码是**单射**的，比一次字符串就知道
   * 是不是同一个会话；读头则要为每个候选都开文件。
   */
  async locate(id: string): Promise<SessionLocation | undefined> {
    const dirName = encodeSegment(id);

    for (const found of await scanSessions(this.root)) {
      if (found.dirName !== dirName) continue;
      return readLocation(found);
    }
    return undefined;
  }
}

// ------------------------------------------------------------
// 生产环境的单例
// ------------------------------------------------------------
/**
 * 会话根来自 `config.paths.sessions`（唯一配置入口）。
 * 为什么放这里而不是每个路由各 new 一个：根只有一个，"会话在哪"的答案也只该
 * 有一份；测试要换根时直接 `new SessionManager(临时目录)`，不碰这个单例。
 * ⚠️ 必须写在 class 之后：class 声明有 TDZ（暂时性死区），写在前面会 ReferenceError。
 */
export const sessionManager = new SessionManager(config.paths.sessions);

// ------------------------------------------------------------
// 模块级纯函数
// ------------------------------------------------------------

/** 会话 id 合法性：只允许字母/数字/下划线/连字符。
 *  为什么必须校验：id 会拼进文件路径，不校验就能用 `../../x` 越界读写
 *  ——这是 tools.ts 路径沙箱（resolveInsideWorkspace）的精神在会话层的补课。 */
export { isValidSessionId };

export function generateSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `s_${stamp}_${random}`;
}

/** 扫出来的一层：会话目录 + 目录名（比 id 用） */
type FoundSession = {
  dir: string;
  dirName: string;
  logPath: string;
};

/** 会话根 → 所有「看起来像会话目录」的位置。读不到目录就返回空（还没建过会话） */
async function scanSessions(root: string): Promise<FoundSession[]> {
  const found: FoundSession[] = [];

  for (const projectPath of await listProjectDirs(root)) {
    const entries = await readdir(projectPath, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      // `.tmp-*` 是 create() 中途的临时目录：它不是会话，别列也别匹配
      if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) continue;
      found.push({
        dir: join(projectPath, entry.name),
        dirName: entry.name,
        logPath: sessionLogPathIn(join(projectPath, entry.name)),
      });
    }
  }

  return found;
}

async function listProjectDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

/** 读会话头拿工作空间路径；头坏了就没有「地点」可言，返回 undefined 让调用方跳过 */
async function readLocation(
  found: FoundSession,
): Promise<SessionLocation | undefined> {
  const header = await readHeader(found.logPath);
  if (!header) return undefined;
  return { dir: found.dir, logPath: found.logPath, cwd: header.cwd };
}

async function readHeader(
  logPath: string,
): Promise<Extract<SessionEntry, { type: "session" }> | undefined> {
  try {
    const raw = await readFile(logPath, "utf8");
    const firstLine = raw.split("\n").find((line) => line.trim());
    if (!firstLine) return undefined;
    const header = JSON.parse(firstLine) as SessionEntry;
    return header.type === "session" ? header : undefined;
  } catch {
    return undefined;
  }
}

/** 读一个会话文件，压成列表用的一条摘要。坏文件返回 null（不挂掉整个列表） */
async function summarizeSessionFile(
  found: FoundSession,
): Promise<SessionSummary | null> {
  try {
    const raw = await readFile(found.logPath, "utf8");
    const mtime = await stat(found.logPath).then((s) => s.mtimeMs);

    let id: string | undefined;
    let cwd: string | undefined;
    let title: string | undefined;
    let preview: string | undefined;

    for (const line of raw.split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as SessionEntry;
      if (entry.type === "session") {
        id = entry.id;
        cwd = entry.cwd;
        title = entry.title;
        continue;
      }
      // 预览是单行展示：messageText 保留结构（模型/摘要用），
      // 这里把换行压成空格再截断，避免会话列表出现换行。
      if (
        entry.type === "message" &&
        preview === undefined &&
        entry.message.role === "user"
      ) {
        preview = truncate(messageText(entry.message).replace(/\n/g, " "), 60);
      }
    }

    // 没有头 = 不是会话（半创建目录 / 别的什么东西），不列
    if (!id || !cwd) return null;

    return {
      id,
      cwd,
      ...(title ? { title } : {}),
      updatedAt: mtime,
      ...(preview ? { preview } : {}),
    };
  } catch {
    return null;
  }
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}…`;
}

/** 压成单行并截断（标题只能占一行：换行会把侧栏那一行撑破） */
function oneLine(input: string, max: number): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return truncate(flat, max);
}

/**
 * 原子替换整个会话文件：先写同目录 `.tmp`，再 rename 覆盖。
 *
 * 为什么必须原子：写回是「全量读 → 改首行 → **全量写回**」，实测最大会话 124KB。
 * 直接 writeFile 到目标路径时，若进程在写回中途被杀——**dev server 随改代码反复
 * 重启，这个窗口天天出现**——文件会被截断成半截 JSON，会话永久损坏。同目录内的
 * rename 在同一文件系统上是原子的：任何时刻崩溃，要么看到完整旧内容、要么看到
 * 完整新内容，最坏只留一个 `.tmp` 残骸。
 */
async function writeLinesAtomically(
  logPath: string,
  lines: string[],
): Promise<void> {
  const tmpPath = `${logPath}.tmp`;
  await writeFile(tmpPath, lines.join("\n"), "utf8");
  await renameFile(tmpPath, logPath);
}

/**
 * 会话文件里有没有**对话消息**（`compaction` / `todo` 不算：没有消息时它们也不存在）。
 *
 * ⚠️ 读坏 / 解析失败时返回 `true`（= 当作"有内容"）：清理是可选动作，宁可不删。
 */
async function hasMessages(logPath: string): Promise<boolean> {
  try {
    const raw = await readFile(logPath, "utf8");
    for (const line of raw.split("\n").filter(Boolean)) {
      if ((JSON.parse(line) as SessionEntry).type === "message") return true;
    }
    return false;
  } catch {
    return true;
  }
}
