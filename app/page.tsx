"use client";

// ============================================================
// 页面 —— statve 的「组装层」
// ============================================================
// 它本身不含业务逻辑，只做三件事：
//   1. 调 useAgentRun() 拿状态和行为（消息、事件、loading、发送、清空）
//   2. 派生展示数据（phase / turn / rows 三个纯函数）
//   3. 组合组件（Nameplate / MessageRow / SessionBar / TraceViewer…）
//
// 样式：组件样式跟组件走（components/<组件>/<组件>.module.css）；
// 页面自己的布局（对话面容器 + 指令台 + 错误横幅）在 ./page.module.css；
// 骨架与设计令牌在 ./globals.css（全局层）。
//
// ── 调用地图：页面调用的每个东西是什么、在哪、干什么 ──
//   useSessions()   app/lib/use-sessions.ts
//                   Phase 2 多会话：会话列表 + 当前会话 id。返回
//                   { sessions, currentId, select, create, rename, remove }。
//                   页面把 currentId 传给 useAgentRun —— 切换会话 = 换 id。
//   useAgentRun()   app/lib/use-agent-run.ts
//                   run 的全部状态 + 行为。内部封装了 fetch POST /api/chat、
//                   readStream 逐帧消费、会话历史 GET 恢复。
//                   返回 { messages, observed, loading, error, runId, model,
//                          send(text), stats }。
//                   （2026-08-26：reset 已删——清空会话功能移除，
//                    见 nameplate 头注释）
//   useTraces()     app/lib/use-traces.ts（A3）
//                   拉某个会话的轨迹文件（列表 → 按同序逐个 run）→ foldTrace
//                   折叠 → buildTraceView 排层次，交给 <TraceViewer> 渲染。
//                   （旧的 trace-rail + trace-fold 留在仓库作回滚，页面不再渲染）
//   derivePhase()   本文件底部（纯函数）—— 根据最近一条事件推断状态灯相位
//   currentTurn()   本文件底部（纯函数）—— 从 turn_start 事件数出当前轮次
//   <Nameplate>     app/components/nameplate/ —— 页头：标志/标题/run 信息/
//                   状态灯/清空按钮
//   <SessionList>   app/components/session-list/ —— 左侧会话栏
//                   （列表 / 新建 / 行内重命名 / 删除）
//   <SessionBar>    app/components/session-bar/ —— 右栏第一行：会话标题 + 模型名
//                   （新会话不显示标题；空会话整行收起）
//   <MessageRow>    app/components/message-row/ —— 转录稿单条消息
//                   （用户/Agent 文本/工具调用行/工具结果卡片）
//   <TraceViewer>   app/components/trace-viewer/ —— 轨迹 tab：竖轴记录表
//                   （A3；顶部 tab 与它一起把原来的右侧轨迹栏收进了中间）
//   <ApprovalDialog> app/components/approval-dialog/ —— 写/改/删工具的
//                   人工确认弹框（允许/拒绝），配合 pendingApproval/approve
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";
import { Nameplate } from "./components/nameplate";
import { Transcript } from "./components/transcript";
import { buildTranscript } from "./lib/transcript";
import { TraceViewer } from "./components/trace-viewer";
import { SessionList } from "./components/session-list";
import { ApprovalDialog } from "./components/approval-dialog";
import { ApprovalModeMenu } from "./components/approval-mode-menu";
import { TaskPanel } from "./components/task-panel";
import { AskUserCard } from "./components/ask-user-card";
import { CommandMenu } from "./components/command-menu";
import { SkillChip } from "./components/skill-chip";
import { ContextMeter } from "./components/context-meter";
import { useAgentRun } from "./lib/use-agent-run";
import { useRunStore } from "./lib/run-store";
import { useMarkSessionRead } from "./lib/use-mark-session-read";
import { useCommandMenu } from "./lib/use-command-menu";
import { useSessions } from "./lib/use-sessions";
import { useWorkspaces } from "./lib/use-workspaces";
import { groupSessions } from "./lib/session-groups";
import { DirectoryBrowser } from "./components/directory-browser";
import { useStickyScroll } from "./lib/use-sticky-scroll";
import { useTraces } from "./lib/use-traces";
import { formatTokens } from "./lib/format";
import { SessionBar } from "./components/session-bar";
import type { ApprovalMode } from "./services/chat/types";
import { getApprovalMode, setApprovalMode } from "./services/chat";

export default function Home() {
  // 会话栏（Phase 2）：列表 + 当前会话 id。currentId 传给 useAgentRun，
  // 切换会话 = 换 currentId，聊天区随之清空并加载对应历史。
  // refresh 额外用于"run 结束后列表保鲜"（见下方 loading 跳变 effect）
  const {
    sessions,
    currentId,
    select,
    create,
    discardEmpty,
    rename,
    remove,
    refresh,
  } = useSessions();

  // 工作空间（C51）：侧栏的分组依据。它就是"会话属于哪个文件夹"的唯一来源 ——
  // 会话头里的 cwd 与这里的 path 相等，所以两边必须来自同一个规范化路径。
  const {
    workspaces,
    error: workspaceError,
    setError: setWorkspaceError,
    create: createWorkspace,
    rename: renameWorkspace,
    remove: removeWorkspace,
    open: openWorkspace,
  } = useWorkspaces();

  // 分组是纯函数算的（app/lib/session-groups，node 可测），页面不做逻辑
  const groups = useMemo(
    () => groupSessions(sessions, workspaces),
    [sessions, workspaces],
  );

  // 「选文件夹」对话框：打开时清掉上一次的错误（否则旧的红字会挂在新对话框里）
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserBusy, setBrowserBusy] = useState(false);

  // hook：一次 run 的观测状态和行为。页面从这里拿数据，不再自己发 fetch。
  //   messages  转录稿消息（当前会话历史 + 本次 run 新增）
  //   observed  带到达时间戳的事件流（右侧时间线的原始素材）
  //   loading   请求进行中（按钮禁用、状态灯判断都用它）
  //   error     请求/流式错误信息（显示在输入框上方横幅）
  //   runId     本次 run 的唯一 id（铭牌展示，来自 run 帧）
  //   model     本次用的模型名（铭牌展示）
  //   send(text)  发送一次 run：fetch → readStream 逐帧消费 → applyFrame
  //   stats       会话级累计统计（轮次 / 工具 / token 数，服务端从会话文件算出）
  //               A3 起显示在输入台底栏（原先长在 <TraceRail> 底部）
  //   pendingApproval  挂起的工具确认（写/改/删弹框用）；approve(allow) 回传决定
  //   toolOutputs  bash 命令的实时输出（toolCallId → 文本）；stop(runId) 停止当前 run
  //   todos        任务清单（Phase 5）：模型 todo_write 更新，前端只读展示
  //   （2026-08-26：reset 已删——清空会话功能移除，见 nameplate 头注释）
  const {
    messages,
    loading,
    error,
    runId,
    model,
    send,
    stats,
    pendingApproval,
    approve,
    pendingAsk,
    answerAsk,
    toolOutputs,
    todos,
    stop,
    compacting,
    runCommand,
    commandFeedback,
    commandRunning,
    contextPressure,
    setError,
  } = useAgentRun(currentId);

  // 输入台能不能用：没有会话就**不能发**（以前只看 loading，于是"新增了工作空间
  // 但还没会话"时输入框照样能打字，回车打到 `sessionId=""` 上 ⇒ 404「会话不存在」）。
  const hasSession = Boolean(currentId);
  const composerDisabled = loading || !hasSession;

  // 输入控制台 + 命令面板（C13 拆出）：input 状态/快照/过滤/键盘导航/
  // pick/submit 的命令分支全在 hook 里，页面只接线（use-command-menu.ts）。
  const {
    input,
    inputRef,
    commandMenuOpen,
    commandActiveIndex,
    setCommandActiveIndex,
    commandMenuRef,
    filteredCommands,
    armedSkill,
    clearArmedSkill,
    handleInputChange,
    handleKeyDown,
    handleBlur,
    pickCommand,
    submit,
  } = useCommandMenu({
    onRunCommand: runCommand,
    onSend: send,
    onError: setError,
    sessionId: currentId,
    disabled: composerDisabled,
  });

  /**
   * 丢掉"建了没用"的当前会话（就是新增工作空间时自动建的那条）。
   *
   * 什么时候调：**离开它之前** —— 切到别的会话、在当前工作空间里新建会话、
   * 或者又新增了一个工作空间。判据只有"这条会话现在一条消息都没有"；
   * 服务端 `?ifEmpty=1` 会以磁盘为准再确认一次（有内容一个字节都不动）。
   */
  const discardUntouched = useCallback(() => {
    if (!currentId || messages.length > 0) return;
    void discardEmpty(currentId);
  }, [currentId, messages.length, discardEmpty]);

  // 审批模式（B1-②）：页面挂载时读服务端当前值；切换调接口（运行时生效，
  // 重启恢复 config 默认）。参考项目都有此入口（pi /settings、DSH /permission）
  const [approvalMode, setApprovalModeState] =
    useState<ApprovalMode>("suggest");

  useEffect(() => {
    getApprovalMode()
      .then((r) => setApprovalModeState(r.mode))
      .catch(() => {
        /* 接口失败保持默认 suggest */
      });
  }, []);

  const switchApprovalMode = useCallback((mode: ApprovalMode) => {
    setApprovalMode(mode)
      .then(() => setApprovalModeState(mode))
      .catch(() => {
        /* 切换失败保持原状 */
      });
  }, []);

  const transcriptRef = useRef<HTMLDivElement>(null); // 转录稿容器，新消息到达时滚到底

  // ---- 滚动跟随（吸底）----
  // 2026-08-26 修：原来每次 messages/observed 更新都强制 scrollToEnd——
  // 流式每来一个 delta 就把滚动轴拽到底，用户想翻上面的历史做不到。
  // 现在用 useStickyScroll 判定"用户是否停靠底部"：停靠才自动滚，
  // 用户滚上去看历史就停止跟随，滚回底部自动恢复（标准聊天 UX）。
  // 判定逻辑封装在 hook（阈值 48px 也在里面），这里只剩两行组装。
  // （轨迹那一份跟随随 <TraceRail> 一起搬进了 <TraceViewer>——它自己持有
  //   滚动容器，自己用同一个 hook，页面不必再管。）
  const followTranscript = useStickyScroll(transcriptRef);

  // 消息 → 回合（纯函数，逐帧重算；messages 引用没变就不重算）
  const turns = useMemo(() => buildTranscript(messages), [messages]);

  // 本轮 run 的本机起点（过程组头那个计时器用）。和侧栏用的是同一个字段：
  // `startRun` 写、刷新后为空 —— 因为刷新后本来也没有 run 在连（C27 还没做）。
  const liveSince = useRunStore((s) => s.runStarted[currentId]);

  // 当前会话属于哪个工作空间（空会话时把它显示在输入框卡片顶部 —— 只读）
  const workspaceName = useMemo(
    () =>
      groups.find((group) =>
        group.sessions.some((session) => session.id === currentId),
      )?.title,
    [groups, currentId],
  );

  useEffect(() => {
    if (followTranscript) scrollToEnd(transcriptRef.current);
  }, [messages, followTranscript]);

  // 列表保鲜（2026-08-26 修，2026-09-02 B22 升级）：
  // 会话列表只在 挂载/新建/重命名/删除 时刷新，聊天后不刷 → 停在旧快照：
  // 会话跑完仍是旧预览/旧时间。B22 前用「当前会话 loading 跳变」判断——
  // 只覆盖前台会话；B22 多会话并行后，后台会话跑完当前页面无感。
  // 现在订阅 store：任一会话桶 run 结束（loading true→false，含 done/error/
  // 停止/网络断）或命令执行完 → refresh。刷新幂等，多触发只是多一次 GET。
  const prevCommandRunningRef = useRef(commandRunning);
  useEffect(() => {
    if (prevCommandRunningRef.current && !commandRunning) {
      refresh(); // 命令改写了会话文件（/clear 清空、/compact 压缩）→ 列表保鲜
    }
    prevCommandRunningRef.current = commandRunning;
  }, [commandRunning, refresh]);

  useEffect(() => {
    // zustand subscribe：任何桶的 run 收尾（loading 熄灭）都刷新列表。
    // 为什么不用 done 帧事件：覆盖 error/停止/网络断等没有 done 帧的收尾
    return useRunStore.subscribe((state, prev) => {
      const anyRunEnded = Object.keys(state.runs).some((id) => {
        const was = prev.runs[id];
        const now = state.runs[id];
        return was?.loading === true && now?.loading === false;
      });
      if (anyRunEnded) refresh();
    });
  }, [refresh]);

  // A3：顶部 tab（对话 / 轨迹）。轨迹只在 tab 打开时才拉数据——没打开就
  // 不请求（useTraces 的 enabled）；`live` 让它在本轮 run 进行中轮询，
  // run 一结束 effect 重跑，自动补一次完整加载。
  const [tab, setTab] = useState<"chat" | "trace">("chat");
  const traces = useTraces(currentId, {
    enabled: tab === "trace",
    live: loading,
  });

  // 状态点（C56 第二轮）：**当前会话的结局，只要发生在这个页面里就算"看过"** ——
  // 切回来不亮，再切走也不复活。为什么必须是 effect 见 hook 自己的注释。
  useMarkSessionRead(currentId);

  // 右栏标题行（2026-11-17）：会话标题 + 模型名，规则都在 <SessionBar> 里
  // （新会话不显示标题）。运行状态**不**写在这里 —— 行首那个点表达的是
  // "我还没看见的结局"，而当前会话按规则不点（`app/lib/session-dot`）。
  // 新会话（一条消息都没有）连 tab 都不显示。
  const showTabs = hasConversation(sessions, currentId, messages.length);

  return (
    <div className="app">
      <div className="deck">
        {/* 左栏：品牌行 + 工作空间栏（2026-11-17：页头只属于左栏，右栏从顶部开始） */}
        <div className={styles.leftColumn}>
          <Nameplate />
          {/* 左侧工作空间栏（C49/C51）：分组 / 组头新建会话 / 组头菜单三件事 */}
          <SessionList
            groups={groups}
            workspaces={workspaces}
            currentId={currentId}
            onSelect={(id) => {
              // 离开一条空会话（自动建的那条）之前先把它丢掉，侧栏不留噪音
              if (id !== currentId) discardUntouched();
              select(id);
            }}
            onCreateSession={(workspaceId) => {
              // 换一条会话 = 也要离开当前这条；空的话一起丢掉
              discardUntouched();
              // 新会话没有对话可看：tab 会隐藏，那就必须回到"对话"视图，
              // 否则会停在上一个会话的"轨迹"里、而 tab 又不见了。
              setTab("chat");
              create(workspaceId);
            }}
            onRename={(id, title) => {
              rename(id, title);
            }}
            onDelete={(id) => {
              // B22：删会话 = 服务端删除 + 本地清桶（abort 在跑流，帧不再写）
              useRunStore.getState().deleteRun(id);
              remove(id);
            }}
            onCreateWorkspace={() => {
              setWorkspaceError(null);
              setBrowserOpen(true);
            }}
            onRenameWorkspace={(workspace, title) => {
              renameWorkspace(workspace.id, title);
            }}
            onOpenWorkspaceFolder={(workspace) => {
              openWorkspace(workspace.id);
            }}
            onDeleteWorkspace={(workspace) => {
              // 删工作空间 = 记录 + 它名下的会话一起删（用户 2026-11-11 定的"粗暴"语义），
              // 所以删完必须重拉会话列表，否则侧栏还挂着已经不存在的行
              removeWorkspace(workspace.id).then((deleted) => {
                if (deleted === null) return;
                refresh();
              });
            }}
          />
        </div>

        <main
          className={styles.stage}
          data-tabs={showTabs ? undefined : "none"}
          data-empty={emptyAttr(showTabs)}
        >
          {/* 1. 会话标题行（右栏第一行）：标题 + 模型名。
              新会话（标题空 / 还是「新会话」）不显示标题，只留右边 —— 规则在组件里。 */}
          <SessionBar
            label={labelOfSession(sessions, currentId)}
            model={model}
          />
          {/* A3 顶部 tab：对话 / 轨迹。指令台在 .stage 的最后一行，两个 tab
              共用它——切到轨迹也照样能发消息（B17④ 的常驻输入框）。
              ⚠️ 2026-11-17：**新会话不显示 tab**（没有对话也没有轨迹可看，
              显示切换器只是噪音）。用 data-hidden 归零而不是不渲染，
              原因是 .stage 按行排栅格，少一个子元素会让内容整体错一行。 */}
          <div
            className={styles.tabs}
            role="tablist"
            data-hidden={showTabs ? undefined : ""}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "chat"}
              className={`${styles.tab}${tab === "chat" ? ` ${styles.tabOn}` : ""}`}
              onClick={() => setTab("chat")}
            >
              对话
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "trace"}
              className={`${styles.tab}${tab === "trace" ? ` ${styles.tabOn}` : ""}`}
              onClick={() => setTab("trace")}
            >
              轨迹
            </button>
          </div>

          {/* 两个 tab 共用同一个 1fr 槽位——所以这里必须二选一。
              代价：切走再回来，转录稿的滚动位置会丢（组件卸载了）。
              一期先接受；要保住就得两个都挂着用 visibility 藏，不值当。 */}
          {tab === "chat" ? (
            <div
              className={styles.transcript}
              ref={transcriptRef}
              data-role="transcript"
            >
              <div className={styles.reel}>
                {/* C57：转录稿按**回合**渲染（一次对话 = 一个回合），不再一条消息一行。
                    折叠规则、工具行、最终回答的切法都在 <Transcript> / app/lib/transcript 里；
                    页面只负责两件事：把消息折成回合（纯函数）、告诉它这一轮还在不在跑。 */}
                <Transcript
                  turns={turns}
                  streaming={loading}
                  toolOutputs={toolOutputs}
                  liveSince={liveSince}
                />
                {/* 上下文压缩进行中（B2）：后端在调模型生成摘要，给用户明确反馈，
                  而不是让 transcript 停在原地像卡住 */}
                {compacting && (
                  <div className={styles.compacting} role="status">
                    <span className={styles.compactingLabel}>
                      上下文超出上限
                    </span>
                    <span>正在压缩上下文，请稍候…</span>
                  </div>
                )}
                {/* C13 命令执行状态：渲染在消息流末尾（跟 compacting 同位置），
                  不叠在输入框上。执行中提示 / 无变化的兜底结果文案
                  （压缩成功时卡片即反馈，文案为空） */}
                {commandRunning && (
                  <div className={styles.compacting} role="status">
                    <span className={styles.compactingLabel}>命令</span>
                    <span>正在执行，请稍候…</span>
                  </div>
                )}
                {commandFeedback && (
                  <div className={styles.compacting} role="status">
                    <span>{commandFeedback}</span>
                  </div>
                )}
                {/* 待确认卡片（B1-④）已从消息流移到底部决策区（2026-08-26，
                  用户要求"像 askUser 悬浮在输入框位置"）——见下方 decisionBar */}
              </div>
            </div>
          ) : (
            <TraceViewer
              fold={traces.fold}
              runs={traces.runs}
              loading={traces.loading}
            />
          )}

          {/* 审批模式切换搬进输入台卡片（C57，见 .consoleActions）—— 它属于
              "发送这次 run 用什么信任档"，跟发送按钮是一组，不再是独立一行。 */}

          {/* 任务面板（Phase 5）：钉在输入台上方，与输入框同列宽（830 居中）。
              只读展示（todo 唯一写者是模型）；头部常驻显示进度，展开看明细；
              sessionId 用于关闭状态按会话隔离（Reasonix 式，纯前端 localStorage）。
              B17②：key={currentId} —— dismissed 是 useState 初始值，只在挂载时
              读 localStorage；切会话不重挂载会停留在旧会话的关闭标记（A 关了
              面板 B 也被藏掉）。key 变 = 强制重挂载 = 重新读。 */}
          <div className={styles.todoBar}>
            <TaskPanel key={currentId} todos={todos} sessionId={currentId} />
          </div>

          {/* 错误横幅：提到提问卡/输入框之外，两种状态下都可见 */}
          {error && (
            <div className={styles.alarm} role="alert">
              <span className={styles.alarmTag}>运行失败</span>
              <span>{error}</span>
            </div>
          )}

          {/* 底部决策区（B17④：输入框常驻 + 覆盖层，替换原三选一）。
              B17④ 动机：原结构 pendingApproval ? 审批卡 : pendingAsk ?
              提问卡 : 输入框——审批/提问出现时输入框整个卸载，卡关闭后
              重建 → 焦点/IME/滚动丢失（输入框虽是 loading 禁用的，命令
              面板也随 console 一起卸载）。
              改法：输入框永远在 DOM；审批/提问卡需要时文档流占位（视觉
              与改造前完全一致——卡片仍占决策区、上面内容被推挤），输入框
              absolute + visibility:hidden 藏起（DOM/ref 保留，卡关闭即恢复）。
              两卡天然互斥（串行 run 同时只会等一个请求）→ && 各自独立，
              无需优先级判断。 */}
          <div className={styles.decisionHost}>
            {pendingApproval && (
              <div className={styles.decisionBar}>
                <ApprovalDialog request={pendingApproval} onApprove={approve} />
              </div>
            )}
            {pendingAsk && (
              <div className={styles.decisionBar}>
                <AskUserCard ask={pendingAsk} onAnswer={answerAsk} />
              </div>
            )}
            {/* 输入台容器（C57）：**结构固定** —— 空会话 ↔ 有对话只换 data-empty 与
                CSS，绝不换父级（换父级会重挂 textarea，焦点和没发出去的字一起丢；
                DSH 在 EmptyHero.tsx 顶部专门写了这条）。 */}
            <div className={styles.composerArea}>
              {emptyHero(!showTabs)}
              <form
                className={`${styles.console}${
                  pendingApproval || pendingAsk
                    ? ` ${styles.consoleCovered}`
                    : ""
                }`}
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <div className={styles.consoleFrame}>
                  {/* 空会话：工作空间落在卡片内部的顶部左侧 —— 纯文本（位置先占住；
                      以后要能切换，把它换成 button + 菜单，排版不用动） */}
                  {workspaceRow(!showTabs, workspaceName)}
                  {/* C13 命令补全面板：贴输入框上方浮起；键盘导航在 textarea
                    onKeyDown 处理（焦点始终在输入框，只移高亮项）。
                    display:contents —— 包裹 div 不生成盒模型，不占 consoleFrame
                    grid 的子项位（否则 popup 会把两列布局撑成两行），
                    popup 的 absolute 定位祖先仍是 consoleFrame。 */}
                  {commandMenuOpen && (
                    <div ref={commandMenuRef} className={styles.commandLayer}>
                      <CommandMenu
                        commands={filteredCommands}
                        activeIndex={commandActiveIndex}
                        onActiveChange={setCommandActiveIndex}
                        onPick={pickCommand}
                      />
                    </div>
                  )}
                  {/* C8 T6 · R4-1：行首挂着一个技能 → 框内上沿一个可点的标签。
                    放在 textarea **之前**：consoleFrame 是两列 grid，它 grid-column
                    1/-1、自然落在第一行，textarea 与右侧按钮仍在第二行 */}
                  {armedSkill && (
                    <SkillChip
                      name={armedSkill.name}
                      onClear={clearArmedSkill}
                    />
                  )}
                  <textarea
                    className={styles.consoleInput}
                    ref={inputRef}
                    rows={1}
                    value={input}
                    onChange={(e) => handleInputChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleBlur}
                    placeholder={composerPlaceholder(hasSession)}
                    disabled={composerDisabled}
                    autoFocus
                  />
                  {/* 工具栏（三层里的第三层）：左 = 这次 run 用什么信任档，
                      右 = 占位圆环 + 发送/停止。整行横跨卡片（grid-column 1/-1）。 */}
                  <div className={styles.consoleActions}>
                    <ApprovalModeMenu
                      mode={approvalMode}
                      onChange={switchApprovalMode}
                    />
                    <div className={styles.consoleActionsRight}>
                      <ContextMeter pressure={contextPressure} />
                      {/* 发送按钮在 run 进行中「变身」为停止按钮：
                      位置永远不变（操作跟随视线），角色随 loading 切换。
                      stop 需要 runId（来自 SSE run 帧），未到时短暂不可点 */}
                      {loading ? (
                        <button
                          className={styles.consoleStop}
                          type="button"
                          onClick={() => stop(runId)}
                          disabled={!runId}
                          aria-label="停止"
                          title="停止这次运行"
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            aria-hidden="true"
                          >
                            <rect
                              width="10"
                              height="10"
                              rx="1.5"
                              fill="currentColor"
                            />
                          </svg>
                        </button>
                      ) : (
                        <button
                          className={styles.consoleSend}
                          type="submit"
                          disabled={!input.trim() || !hasSession}
                          aria-label="发送"
                          title="发送（Enter）"
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                {/* 输入台底栏（A3，参考 DSH）：左 = 会话级读数，右 = 操作提示。
                  读数原本长在 <TraceRail> 底部，轨迹栏下线后搬到这里——
                  这样"会话跑了多少"在任何 tab 下都看得见。 */}
                <div className={styles.statusBar}>
                  <span className={styles.statusStats}>
                    {stats.turns} 轮 · {stats.tools} 工具 ·{" "}
                    {formatTokens(stats.tokens)} token
                  </span>
                </div>
              </form>
            </div>
          </div>
        </main>
      </div>

      {/* 「新增工作空间」：选一个文件夹 → 登记成记录。只读对话框，见组件头注释。
          关闭即卸载（条件渲染）：每次打开都是干净实例，不需要"打开时复位"的 effect。 */}
      {browserOpen ? (
        <DirectoryBrowser
          busy={browserBusy}
          error={workspaceError}
          onClose={() => setBrowserOpen(false)}
          onPick={async (path) => {
            setBrowserBusy(true);
            const workspace = await createWorkspace(path);
            if (workspace) {
              // 新增工作空间 = 换一条会话：先丢掉当前那条空的
              discardUntouched();
              // ⭐ 立刻在这个新工作空间里开一条会话并选中（2026-11-17 用户定）：
              // 不开的话用户会停在"空间建好了、却没地方可以说话"的空档里。
              // 这条会话若一直没消息，会在离开时/下次打开页面时被清掉（判据在服务端）。
              await create(workspace.id);
              // 成功才关：失败（409 已登记 / 400 路径不对）留在对话框里显示原因
              setBrowserOpen(false);
            }
            setBrowserBusy(false);
          }}
        />
      ) : null}
    </div>
  );
}

// ============ 输入台文案（纯函数，跟着页面走） ============

// 为什么提到模块层：写进 JSX 的三元会把 Home 的圈复杂度顶到 eslint 上限（20），
// 而这两句就是常量，跟组件状态无关。
function composerPlaceholder(hasSession: boolean): string {
  return hasSession
    ? "给它一个目标，例如：读取 agent-notes.md 并总结要点"
    : "先在工作空间里开一个会话，再给它目标";
}

/**
 * 会话的显示标签（**和侧栏那一行的标签同一条链**：标题 ?? 首条消息 ?? 空）。
 * 提到模块层是为了不把 `find + 可选链` 的分支记到 Home 的圈复杂度上。
 */
function labelOfSession(
  sessions: { id: string; title?: string; preview?: string }[],
  id: string,
): string {
  const found = sessions.find((item) => item.id === id);
  if (!found) return "";
  return found.title ?? found.preview ?? "";
}

/**
 * 这个会话有没有"对话"可看 —— 决定右栏顶部的「对话 / 轨迹」tab 要不要出现。
 *
 * 判据两条任一成立即可：
 *   ① 本次打开后已经加载/产生了消息；
 *   ② 列表里这条会话已有首条消息的预览（服务端事实，进页面就有，不会闪）。
 * 都没有 ⇒ 这是新会话，tab 没有意义（没有对话也没有轨迹）。
 */
function hasConversation(
  sessions: { id: string; preview?: string }[],
  id: string,
  messageCount: number,
): boolean {
  if (messageCount > 0) return true;
  const found = sessions.find((item) => item.id === id);
  return Boolean(found?.preview);
}

// ============ 状态推导（纯函数，跟着页面走） ============

/**
 * 空会话的几个"小零件"。都拆成模块级函数而不是写在 JSX 里 ——
 * 一是 Home 的圈复杂度已经很紧（ESLint complexity ≤ 20），
 * 二是这三样只在空会话出现，放在一起读着更清楚。
 */

/** 空会话才有 `data-empty`（给 CSS 换布局用；undefined 表示不写这个属性） */
function emptyAttr(hasChat: boolean): string | undefined {
  return hasChat ? undefined : "";
}

/** 空会话的品牌行：输入框卡片上方居中 */
function emptyHero(empty: boolean) {
  if (!empty) return null;
  return (
    <div className={styles.hero}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          s
        </span>
        <span className={styles.brandName}>statve</span>
      </div>
    </div>
  );
}

/** 空会话："这条会话属于哪个工作空间" —— 纯文本，落在输入框卡片内部顶部左侧 */
function workspaceRow(empty: boolean, name: string | undefined) {
  if (!empty || name === undefined) return null;
  return (
    <div className={styles.wsRow}>
      <span className={styles.wsMark} aria-hidden="true">
        ▸
      </span>
      <span className={styles.wsName}>{name}</span>
    </div>
  );
}

function scrollToEnd(box: HTMLDivElement | null) {
  box?.scrollTo(0, box.scrollHeight);
}
