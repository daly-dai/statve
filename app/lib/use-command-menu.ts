"use client";

// ============================================================
// useCommandMenu —— 命令面板 + 输入控制台（C13 前端重构，2026-09-01）
// ============================================================
// 从 page.tsx 拆出（用户吐槽"前端一坨，该封装 hook 没封装"）：
// page 曾把命令面板全套状态 + 过滤 + 键盘导航 + pick + submit 的命令
// 分支堆在组件里（550+ 行）。本 hook 收走"输入框 + 命令面板"这一整块：
//   - input 状态（输入框内容，命令就在输入框里输入，天然同源）
//   - 命令快照（slashCatalog：页面加载 fetch 一次，按键只过滤不重查）
//   - 面板开关 / 高亮 / 过滤 / 键盘导航（↑↓/Enter/Esc/失焦关闭）
//   - pickCommand（填回参数 / 直接执行 / /export 门面触发下载）
//   - submit（命令硬边界校验 + 普通消息回落）
// 依赖注入（不直接 import use-agent-run，保持 hook 可复用可测）：
//   onRunCommand / onSend / onError / sessionId / disabled。
// 未来 C14 @ 文件匹配复用同一套"输入浮层"交互模式。
// ============================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { fetchCommands, downloadSessionFile } from "@/app/services/chat";
import {
  isSlashCommandLine,
  parseSlashName,
  validateSubmission,
} from "@/lib/commands/parse";
import type { CommandDescriptor } from "@/lib/commands";
import { filterCommands } from "@/app/lib/command-panel";
import {
  draftOf,
  dropDraft,
  setDraft,
  type Drafts,
} from "@/app/lib/draft-store";
import {
  eraseDraft,
  readAllDrafts,
  writeDraft,
} from "@/app/lib/draft-store/storage";

type UseCommandMenuOptions = {
  /** 执行命令（use-agent-run 的 runCommand：POST /api/chat/command + 刷新历史） */
  onRunCommand: (line: string) => Promise<boolean>;
  /** 普通消息发送（use-agent-run 的 send：走 SSE run）——路径回落/非命令形态 */
  onSend: (text: string) => void;
  /** 报错（未知命令横幅；page 传给 use-agent-run 的 setError） */
  onError: (message: string) => void;
  /** 当前会话 id（/export 门面下载用） */
  sessionId: string;
  /** 禁用提交（run 进行中 loading；textarea 同时 disabled） */
  disabled: boolean;
};

export function useCommandMenu({
  onRunCommand,
  onSend,
  onError,
  sessionId,
  disabled,
}: UseCommandMenuOptions) {
  // ---- 输入内容（C59：按会话存，显示值是派生出来的）----
  // 以前是 `const [input, setInput] = useState("")` —— 一份跟会话无关的页面级状态，
  // 于是"在 A 打一半切到 B"那段字会跟着人跑到 B、按发送就发错会话。
  // 现在：`drafts[sessionId]`，**换会话不需要任何"清空/恢复"的 effect**。
  // （把不可能的状态变成画不出来的：一份"不属于任何会话的输入"根本不存在了。）
  const [drafts, setDrafts] = useState<Drafts>({});
  // ⚠️ 必须包一层 useMemo：直接写 `draftOf(drafts, sessionId)` 会让 React Compiler
  // 放弃分析整个 hook（它无法确认这个跨模块调用是纯的，而 `input` 又是下面几个
  // useCallback 的依赖 ⇒ 报一串 "Existing memoization could not be preserved"）。
  // 实测：内联 `drafts[sessionId] ?? ""` 或包 useMemo 都能过，这里选后者 ——
  // 保住"取草稿"只有一个实现（那个实现有单测）。
  const input = useMemo(() => draftOf(drafts, sessionId), [drafts, sessionId]);

  // 挂载后把盘上的草稿一次读进内存 —— 之后切会话再也不用读盘（纯派生）。
  // ⚠️ 只能用 effect：localStorage 在服务端不存在（Next 对 use client 组件也会预渲染），
  //    所以首帧渲染不出草稿、读进来后会再渲染一次（草稿"跳出来"一下）。
  //    改成在 useState 初始化函数里读会撞 hydration 不一致（服务端 HTML 里输入框是空的）。
  useEffect(() => {
    // `{ ...盘, ...内存 }`：别覆盖首帧里用户已经敲下的字
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部存储（localStorage）只能在客户端读得到，读不到就没有可派生的值；同 use-sessions 的 loading 那处，见池子 C46
    setDrafts((local) => ({ ...readAllDrafts(), ...local }));
  }, []);

  /** 写当前会话的草稿：内存 + 盘（空串 = 删键，不留空壳） */
  const writeInput = useCallback(
    (next: string) => {
      setDrafts((state) => setDraft(state, sessionId, next));
      writeDraft(sessionId, next);
    },
    [sessionId],
  );

  /** 清掉当前会话的草稿（发送成功 / 命令执行完） */
  const clearInput = useCallback(() => {
    setDrafts((state) => dropDraft(state, sessionId));
    eraseDraft(sessionId);
  }, [sessionId]);

  /**
   * 会话被删 → 它的草稿一起扔掉（内存 + 盘）。用户 2026-11-17 定的：
   * 「草稿不给会话保命：没发出去就该删」。注意参数是**被删的那个 id**，不是当前会话。
   */
  const forgetDraft = useCallback((id: string) => {
    setDrafts((state) => dropDraft(state, id));
    eraseDraft(id);
  }, []);
  // ---- 命令快照（slashCatalog，Reasonix）：加载一次，按键只过滤 ----
  const [commands, setCommands] = useState<CommandDescriptor[]>([]);
  // 快照是否加载成功：失败/未完成时跳过前端命令校验、直接交后端判
  // （review 修复：快照不可用时不能拿空名单误杀合法 /compact）
  //
  // ⚠️ 记的是"**哪个会话**的快照已经到位"，不是一个布尔值（2026-11-11）：
  // 技能清单随工作空间变，换会话必须重取；用布尔值就得在 effect 顶部
  // 同步 setState 去复位，而那是 React 明确不建议的写法（eslint 直接报
  // react-hooks/set-state-in-effect）。
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
  const commandsLoaded = loadedSessionId === sessionId;
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  const commandMenuRef = useRef<HTMLDivElement>(null); // 失焦关闭判定用
  const inputRef = useRef<HTMLTextAreaElement>(null); // 聚焦/自适应高度用

  // 快照跟着会话走：换会话 = 换工作空间 = 换技能清单，必须重取
  useEffect(() => {
    // 还没选中会话（页面刚起 / 刚删干净）时没有"这个会话的命令清单"可拉 ——
    // 以前这里照样发一次 `?sessionId=`，服务端 400，控制台留两条红字
    if (!sessionId) return undefined;
    // 会话可能在请求途中又被切走：用 cancelled 丢弃过期响应（否则慢响应会把
    // 上一个会话的技能名单盖到新会话上）
    let cancelled = false;
    fetchCommands(sessionId)
      .then((r) => {
        if (cancelled) return;
        setCommands(r.commands);
        setLoadedSessionId(sessionId);
      })
      .catch(() => {
        /* 命令面板不可用不阻塞聊天（命令快照是增强，不是依赖）；
           保持 commandsLoaded=false：提交时跳过前端校验交给后端判 */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 输入框随内容长高（上限由 CSS 的 max-height 兜住）
  useEffect(() => {
    const box = inputRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [input]);

  // ---- 过滤（slashCatalog 快照只过滤不重查）----
  const commandPrefix = input.startsWith("/") ? input.slice(1) : "";
  const filteredCommands = useMemo(
    // 模糊匹配（子序列）：打 `cr` 能出 `code-review` —— 见 app/lib/command-panel
    () => (commandMenuOpen ? filterCommands(commands, commandPrefix) : []),
    [commands, commandMenuOpen, commandPrefix],
  );

  /**
   * 行首挂着一个**技能**吗 —— R4-1 的 chip 数据源（`⌘ 名字 ×`）。
   *
   * ⭐ 不存 state、**直接从 `input` 推**：单一事实源。存 state 的话，迟早出现
   * "你手动删掉了 `/名字`、chip 还挂在那儿"这类不同步 —— 而这类 bug 没人会想到去查 chip。
   */
  const armedSkill = useMemo(() => {
    const parsed = parseSlashName(input);
    if (parsed === null) return null;
    const descriptor = lookupCommand(commands, parsed.name);
    return descriptor?.source === "skill" ? descriptor : null;
  }, [input, commands]);

  /** 点 chip 的 ×：只摘掉行首那个 `/名字`（+ 紧跟的一个空格），**保留你后面打的要求** */
  const clearArmedSkill = useCallback(() => {
    writeInput(input.replace(/^\/\S+\s?/, ""));
    inputRef.current?.focus();
  }, [input, writeInput]);

  /**
   * textarea onChange：更新输入 + 命令形态（/ 开头、行首无空格）弹面板。
   *
   * ⚠️ 面板只在**还在打名字**时开（C8 T6）：名字打完之后（出现空白）就收起。
   * 不加这条的话，选中技能后输入框是 `/code-review `，你接着打「帮我评审」——
   * 每一个字都会重新弹出一个空面板（名字已经不匹配任何东西了），纯属打扰。
   */
  const handleInputChange = useCallback(
    (value: string) => {
      writeInput(value);
      const prefix = value.startsWith("/") ? value.slice(1) : "";
      setCommandMenuOpen(isSlashCommandLine(value) && !/\s/.test(prefix));
      setCommandActiveIndex(0);
    },
    [writeInput],
  );

  /** 选中命令：接受参数（/model gpt-4o）→ 填回输入框补参数；
   *  无参数命令（/compact）→ 直接执行（验收：选 /compact → 压缩卡片出现） */
  const pickCommand = useCallback(
    (command: CommandDescriptor) => {
      setCommandMenuOpen(false);
      if (command.supportsInlineArgs) {
        writeInput(`/${command.name} `);
        inputRef.current?.focus();
        return;
      }
      clearInput();
      // /export 门面模式（DSH session-log-export）：命令只校验（handler
      // 不产文件），runCommand 业务成功后触发独立 GET 下载会话 JSONL。
      if (command.name === "export") {
        void onRunCommand(`/${command.name}`).then((ok) => {
          if (ok) downloadSessionFile(sessionId);
        });
        return;
      }
      void onRunCommand(`/${command.name}`);
    },
    [onRunCommand, sessionId, writeInput, clearInput],
  );

  /** 提交（表单 / 回车都走这里）：命令硬边界校验 + 普通消息回落。
   *  用原始文本判命令形态（行首空格是退出符，trim 会吃掉它） */
  const submit = useCallback(() => {
    if (!input.trim() || disabled) return;
    const raw = input;
    clearInput();
    setCommandMenuOpen(false);
    if (isSlashCommandLine(raw)) {
      // 先解析：/ 开头但解析不出名字 = 路径（/foo/bar）、只有斜杠（/）、
      // 大写/数字开头——都不是命令，按普通消息发（详案补记1：
      // "name 含 /（路径）→ 不拦截"，review 修复：ok:true 含"按普通
      // 消息发"语义，不能一律 runCommand）。
      const parsed = parseSlashName(raw);
      if (parsed === null) {
        onSend(raw.trim());
        return;
      }
      // ⭐ **提交分流（C8 T6）**：名字落在**技能**上 → 走聊天（正文交给宿主的手势
      //    注入那条路），不走命令接口。判据取快照里的 `source`，**不另存 state** ——
      //    所以"面板选的"和"手打的"走的是同一条判断，不会分叉。
      if (lookupCommand(commands, parsed.name)?.source === "skill") {
        onSend(raw.trim());
        return;
      }
      // 命令形态 → 硬边界（codex SubmissionValidation）：名字未注册
      // 报错不进模型（`/copmact` 不能当正文发给模型）。
      // 快照未就绪（加载中/失败）时跳过前端校验，直接交后端判——
      // 空名单会误杀合法命令（review 修复）
      if (commandsLoaded) {
        const names = new Set(
          commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
        );
        const check = validateSubmission(raw, names);
        if (!check.ok) {
          // ⚠️ 文案必须说「命令**或技能**」—— 这是 **C8 T5 引入的缺陷**，2026-09-17
          //    T8 验收第 ⑥ 条当场抓到的：T5 把技能也注册进了这份名单
          //    （`source: "skill"`），于是 `/` 后面**既可能是命令也可能是技能**；
          //    而这句话是 **C13 时代**写的（那时只有 3 个内置命令），没跟着改 ——
          //    用户打的是个**技能**名，却被告知"**命令**"不对（用户原话：
          //    「如果是匹配不到技能 为什么是命令匹配不到」）。
          // ⚠️ 后端 `app/api/chat/command/route.ts` 里还有**同一句话的另一份**，
          //    **改要一起改**。为什么不做成一个共享函数：`app/lib/command-panel`
          //    的头注释写着「**文案是 UI 的事，不是数据的事**」（那是它的边界声明），
          //    而为一句文案新建模块又是 §10.8 说的"假设的 seam"。所以就地改，
          //    并在两边互相指向 —— 代价是**这两句没有测试守着**（前端是 hook、
          //    按 §8.4 不写 jsdom 测试；后端 route 没有测试基建），**不假装测过**。
          onError(`未知命令或技能：/${check.name}，输入 / 看清单`);
          return;
        }
      }
      void onRunCommand(raw);
      return;
    }
    onSend(raw.trim());
  }, [
    input,
    disabled,
    commandsLoaded,
    commands,
    onSend,
    onError,
    onRunCommand,
    clearInput,
  ]);

  /** textarea onKeyDown：面板打开时 ↑↓ 移高亮 / Enter 选中 / Esc 关闭；
   *  否则回车发送（Shift+Enter 换行；中文输入法选词的回车不算发送） */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (commandMenuOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setCommandActiveIndex((i) =>
            Math.min(i + 1, filteredCommands.length - 1),
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setCommandActiveIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setCommandMenuOpen(false);
          return;
        }
        if (
          e.key === "Enter" &&
          !e.shiftKey &&
          !e.nativeEvent.isComposing &&
          filteredCommands.length > 0
        ) {
          e.preventDefault();
          pickCommand(filteredCommands[commandActiveIndex]);
          return;
        }
        // 无匹配的命令形态 → 落到下方发送逻辑（submit 会报未知命令）
      }
      if (e.key !== "Enter" || e.shiftKey) return;
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      submit();
    },
    [
      commandMenuOpen,
      filteredCommands,
      commandActiveIndex,
      pickCommand,
      submit,
    ],
  );

  /** textarea onBlur：焦点移到补全面板内（点命令项）不算失焦；移出则关闭 */
  const handleBlur = useCallback((e: FocusEvent<HTMLTextAreaElement>) => {
    if (!commandMenuRef.current?.contains(e.relatedTarget as Node)) {
      setCommandMenuOpen(false);
    }
  }, []);

  return {
    input,
    inputRef,
    commandMenuOpen,
    commandActiveIndex,
    setCommandActiveIndex, // CommandMenu onActiveChange（onMouseEnter 移高亮）
    commandMenuRef,
    filteredCommands,
    /** 行首挂着的技能（有值就渲染 R4-1 的 chip） */
    armedSkill,
    clearArmedSkill,
    handleInputChange,
    handleKeyDown,
    handleBlur,
    pickCommand,
    submit,
    /** C59：会话被删时把它的草稿一起扔掉（页面在删会话的三条路径上调） */
    forgetDraft,
  };
}

/**
 * hook 返回的那一整套值（2026-11-19 加）。
 *
 * 为什么导出这个类型：`<Composer>` 要把整套接线原样收下来（14 个字段，
 * 逐个列成 props 只会更长），所以 props 里写 `command: CommandMenuState`。
 * 用 `ReturnType` 而不是手写一遍：手写就和 hook 会漂移 —— 加一个字段忘了同步，
 * 类型不会报错，运行时是 undefined。
 */
export type CommandMenuState = ReturnType<typeof useCommandMenu>;

/** 按名字或别名找一条（快照里主名唯一；别名只认不显 ← codex ALIAS_COMMANDS） */
function lookupCommand(
  commands: CommandDescriptor[],
  name: string,
): CommandDescriptor | undefined {
  return commands.find(
    (command) =>
      command.name === name || (command.aliases ?? []).includes(name),
  );
}
