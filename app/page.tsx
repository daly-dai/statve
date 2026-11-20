"use client";

// ============================================================
// 页面 —— statve 的「组装层」
// ============================================================
// 它本身不含业务逻辑，只做三件事：
//   1. 调 hook 拿状态与行为（会话 / 工作空间 / 一次 run / 轨迹 / 输入台）
//   2. 派生展示数据（groups / turns / workspaceName 三个纯函数或 useMemo）
//   3. 组合组件并把值传下去
//
// ⚠️ 2026-11-19 拆过一刀（AGENTS 11.9：单文件 ≤ 500 行）。这一页从 727 行
// 降到下面这些组件的**组装**，四块从它身上搬走，各自独立成组件：
//   <EmptyHero>       app/components/empty-hero/    空会话的品牌行
//   <StageTabs>       app/components/stage-tabs/    「对话 / 轨迹」切换条
//   <Composer>        app/components/composer/      指令台（卡片 + 工具栏 + 底栏读数）
//   <TranscriptPane>  app/components/transcript-pane/ 转录稿那一格 + 吸底跟随
// 每一块为什么单独存在、以及拆的时候不能破的约束，都写在各自的文件头注释里。
//
// 样式：组件样式跟组件走（components/<组件>/index.module.css）；
// 页面自己的布局（三列骨架里的左右两栏 + 舞台栅格 + 决策区 + 错误横幅）
// 在 ./page.module.css；骨架与设计令牌在 ./globals.css（全局层）。
//
// ── 调用地图：页面调用的每个东西是什么、在哪、干什么 ──
//   useSessions()   app/lib/use-sessions.ts
//                   Phase 2 多会话：会话列表 + 当前会话 id。返回
//                   { sessions, currentId, select, create, rename, remove }。
//                   页面把 currentId 传给 useAgentRun —— 切换会话 = 换 id。
//   useWorkspaces() app/lib/use-workspaces.ts（C49/C51）
//                   工作空间记录：侧栏的分组依据，也就是"会话属于哪个文件夹"。
//   useAgentRun()   app/lib/use-agent-run.ts
//                   run 的全部状态 + 行为。内部封装了 fetch POST /api/chat、
//                   readStream 逐帧消费、会话历史 GET 恢复。
//                   返回 { messages, observed, loading, error, runId, model,
//                          send(text), stats, pendingApproval, pendingAsk, … }。
//   useCommandMenu() app/lib/use-command-menu.ts（C13）
//                   输入值 / 命令快照 / 过滤 / 键盘导航 / 提交。
//                   **整份返回值原样交给 <Composer>**（页面不拆开用）。
//   useTraces()     app/lib/use-traces.ts（A3）
//                   拉某个会话的轨迹文件（列表 → 按同序逐个 run）→ foldTrace
//                   折叠 → buildTraceView 排层次，交给 <TraceViewer> 渲染。
//   <Nameplate>     app/components/nameplate/ —— 左栏品牌行
//   <SessionList>   app/components/session-list/ —— 左侧会话栏
//                   （分组 / 新建 / 行内重命名 / 删除 / 工作空间菜单）
//   <SessionBar>    app/components/session-bar/ —— 右栏第一行：会话标题 + 模型名
//   <TraceViewer>   app/components/trace-viewer/ —— 轨迹 tab：竖轴记录表
//   <TaskPanel>     app/components/task-panel/ —— 任务清单（模型 todo_write 的只读展示）
//   <ApprovalDialog> app/components/approval-dialog/ —— 写/改/删工具的人工确认弹框
//   <AskUserCard>   app/components/ask-user-card/ —— 模型提问卡（A4）
//   <DirectoryBrowser> app/components/directory-browser/ —— 「新增工作空间」选文件夹
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";
import { Nameplate } from "./components/nameplate";
import { Composer } from "./components/composer";
import { EmptyHero } from "./components/empty-hero";
import { NoSessionHint } from "./components/no-session-hint";
import { StageTabs, type StageTab } from "./components/stage-tabs";
import { TranscriptPane } from "./components/transcript-pane";
import { buildTranscript } from "./lib/transcript";
import { TraceViewer } from "./components/trace-viewer";
import { SessionList } from "./components/session-list";
import { ApprovalDialog } from "./components/approval-dialog";
import { TaskPanel } from "./components/task-panel";
import { AskUserCard } from "./components/ask-user-card";
import { useAgentRun } from "./lib/use-agent-run";
import { useRunStore } from "./lib/run-store";
import { useMarkSessionRead } from "./lib/use-mark-session-read";
import { useCommandMenu } from "./lib/use-command-menu";
import { useSessions } from "./lib/use-sessions";
import { useWorkspaces } from "./lib/use-workspaces";
import { groupSessions } from "./lib/session-groups";
import { stageDataOf, stageModeOf } from "./lib/stage-mode";
import { DirectoryBrowser } from "./components/directory-browser";
import { useTraces } from "./lib/use-traces";
import { SessionBar } from "./components/session-bar";
import type { ApprovalMode } from "./services/chat/types";
import { getApprovalMode, setApprovalMode } from "./services/chat";

export default function Home() {
  // 会话栏（Phase 2）：列表 + 当前会话 id。currentId 传给 useAgentRun，
  // 切换会话 = 换 currentId，聊天区随之清空并加载对应历史。
  // refresh 额外用于"run 结束后列表保鲜"（见下方 commandRunning effect）
  const {
    sessions,
    currentId,
    select,
    create,
    discardEmpty,
    rename,
    remove,
    refresh,
    // C67 起页面要它：列表还没回来时右栏**什么都不画**（否则"没有会话"那句话会闪一下）
    loading: sessionsLoading,
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
  //   loading   请求进行中（按钮禁用、状态灯判断都用它）
  //   error     请求/流式错误信息（显示在输入框上方横幅）
  //   runId     本次 run 的唯一 id（停止按钮要用它）
  //   model     本次用的模型名（标题行展示）
  //   send(text)  发送一次 run：fetch → readStream 逐帧消费 → applyFrame
  //   stats       会话级累计统计（轮次 / 工具 / token 数，服务端从会话文件算出）
  //   pendingApproval / pendingAsk  挂起的工具确认与模型提问（决策区弹框用）
  //   toolOutputs  bash 命令的实时输出（toolCallId → 文本）；stop(runId) 停止当前 run
  //   todos        任务清单（Phase 5）：模型 todo_write 更新，前端只读展示
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

  // 输入台在 run 进行中不可用。
  // ⚠️ C67 起这里**不再看"有没有会话"**：那种情况页面根本不渲染输入台（右栏只留
  // 一句话，见 stageModeOf）。原来那句 `|| !hasSession` 修的是 2026-09 的
  // "新增了工作空间但还没会话时，回车打到 `sessionId=""` 上 ⇒ 404「会话不存在」" ——
  // 现在连输入框都没有，这条 404 无从发生。
  const composerDisabled = loading;

  // 输入控制台 + 命令面板（C13 拆出 hook，2026-11-19 整份交给 <Composer>）：
  // input 状态/快照/过滤/键盘导航/pick/submit 的命令分支全在 hook 里，
  // 页面既不拆开用、也不往下透传单个字段。
  const command = useCommandMenu({
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
  const [tab, setTab] = useState<StageTab>("chat");
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
  // 新会话（一条消息都没有）连 tab / 空态品牌行都不显示。
  const showTabs = hasConversation(sessions, currentId, messages.length);
  // 空会话：输入台居中 + 提示"先开个会话"（判据和 tab 的显隐是同一个，
  // 所以只算一次 —— 两个 `!showTabs` 各写各的迟早会漂）
  const emptyStage = !showTabs;

  // 右栏现在有三种模式（C67）：加载中 / 无会话 / 有会话。两个纯函数把分支从
  // Home 的圈复杂度里拿走 —— 它们只是查表，不该占组件主体的预算。
  const stageMode = stageModeOf(currentId, sessionsLoading);
  const stageData = stageDataOf(stageMode, showTabs);

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
          data-tabs={stageData.tabs}
          data-empty={stageData.empty}
          data-nosession={stageData.nosession}
        >
          {/* C67：无会话（且会话列表已加载完）时右栏只留一句话 —— 输入台根本不渲染。
              加载中 visible=false ⇒ 什么都不画，避免这句话闪一下。 */}
          <NoSessionHint visible={stageMode === "no-session"} />
          {stageMode === "session" ? (
            <>
              {/* 1. 会话标题行（右栏第一行）：标题 + 模型名。
              新会话（标题空 / 还是「新会话」）不显示标题，只留右边 —— 规则在组件里。 */}
              <SessionBar
                label={labelOfSession(sessions, currentId)}
                model={model}
              />
              {/* A3 顶部 tab：对话 / 轨迹。指令台在 .stage 的最后一行，两个 tab
              共用它——切到轨迹也照样能发消息（B17④ 的常驻输入框）。
              ⚠️ 新会话不显示 tab（没有对话也没有轨迹可看，显示切换器只是噪音）。 */}
              <StageTabs value={tab} onChange={setTab} hidden={!showTabs} />

              {/* 两个 tab 共用同一个 1fr 槽位——所以这里必须二选一。
              代价：切走再回来，转录稿的滚动位置会丢（组件卸载了）。
              一期先接受；要保住就得两个都挂着用 visibility 藏，不值当。 */}
              {tab === "chat" ? (
                <TranscriptPane
                  turns={turns}
                  streaming={loading}
                  toolOutputs={toolOutputs}
                  liveSince={liveSince}
                  compacting={compacting}
                  command={{
                    running: commandRunning,
                    feedback: commandFeedback,
                  }}
                />
              ) : (
                <TraceViewer
                  fold={traces.fold}
                  runs={traces.runs}
                  loading={traces.loading}
                />
              )}

              {/* 任务面板（Phase 5）：钉在输入台上方，与输入框同列宽（830 居中）。
              只读展示（todo 唯一写者是模型）；头部常驻显示进度，展开看明细；
              sessionId 用于关闭状态按会话隔离（Reasonix 式，纯前端 localStorage）。
              B17②：key={currentId} —— dismissed 是 useState 初始值，只在挂载时
              读 localStorage；切会话不重挂载会停留在旧会话的关闭标记（A 关了
              面板 B 也被藏掉）。key 变 = 强制重挂载 = 重新读。 */}
              <div className={styles.todoBar}>
                <TaskPanel
                  key={currentId}
                  todos={todos}
                  sessionId={currentId}
                />
              </div>

              {/* 错误横幅：提到提问卡/输入框之外，两种状态下都可见 */}
              {error && (
                <div className={styles.alarm} role="alert">
                  <span className={styles.alarmTag}>运行失败</span>
                  <span>{error}</span>
                </div>
              )}

              {/* 底部决策区（B17④）：审批/提问卡占位，输入台留在 DOM 里但被藏起来。
              "为什么不能卸载输入台 / 为什么用 absolute + visibility" 的完整理由
              住在 app/components/composer/ 的文件头（约束 ②）——这里不重复一份。 */}
              <div className={styles.decisionHost}>
                {pendingApproval && (
                  <div className={styles.decisionBar}>
                    <ApprovalDialog
                      request={pendingApproval}
                      onApprove={approve}
                    />
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
                  <EmptyHero visible={emptyStage} />
                  <Composer
                    command={command}
                    approval={{
                      mode: approvalMode,
                      onChange: switchApprovalMode,
                    }}
                    run={{ loading, runId, stop }}
                    stats={stats}
                    contextPressure={contextPressure}
                    empty={{ visible: emptyStage, workspaceName }}
                    state={{
                      disabled: composerDisabled,
                      covered: Boolean(pendingApproval) || Boolean(pendingAsk),
                    }}
                  />
                </div>
              </div>
            </>
          ) : null}
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

// ============ 展示数据的推导（纯函数，跟着页面走） ============

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
