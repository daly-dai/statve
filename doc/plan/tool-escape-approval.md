# 越界 → 危险操作审批（4.6 接线）—— 改造方案

> **状态**：**已定案**（本文 ④ 详细设计 + ⑤ 验收 已写）。池子里是 `未开始` —— 还没排进任何迭代。
> **来源**：C6 的详案 `doc/plan/workspace.md` 的 **4.6 节**。那一节写的是"该有什么行为"，本文写的是"**代码长什么样、按什么顺序接**"。
> **为什么单独开一份**：4.6 的三个纯函数早已落地并测过（27 条），但**接线**在 4.15 的 commit 切分里没有落点（见 2.3）。它牵着 `lib/tools` 的围栏、审批决策、SSE 帧、approve 路由、前端弹框五处，规模足够独立成一项，而不是"顺手接一下"。

---

## 一、需求（池子行原文）

> **C55** · **越界 → 危险操作审批接线（4.6）**：模型读写工作空间外的文件时，从"围栏直接抛错"改成"**先问人**"—— 危险样式弹框、列出绝对路径、批准后**一次性**放行；只读 `bash` 命中越界痕迹时不再静默自动放行。
>
> —— 池子行见 `PLAN.md` 的**需求池** C55。

## 二、依据

### 2.1 现状实读（2026-11-11，带位置）

| 事实 | 位置 |
|---|---|
三个纯函数已存在且已测：`classifyEscape` / `hasEscapeTraces` / `createEscapePermits` | `app/lib/tool-escape/index.ts`（27 条用例） |
围栏**只有一处**：越界即 `throw new Error("路径越界：…")` | `lib/tools/path-utils/index.ts:21` `resolveInsideWorkspace` |
围栏被 **8 个工具**调用（read / write / edit / delete / grep / find / list / write-note） | 各 `lib/tools/*/index.ts` |
工具工厂的签名今天只有 `workspaceRoot`，凭据无处可传 | `createReadTool(workspaceRoot)` 等 8 处 |
审批决策是纯函数，`request` 不带任何"危险"信息 | `app/api/chat/_pipeline/approval/index.ts` |
只读 `bash` 在 `confirmOrRequest` 里**直接 return allow**（这就是安全洞） | 同上，`confirmOrRequest` 第 122-128 行 |
挂起表把 `toolCallId → resolve` 联系起来，但只存 `toolName` | `lib/toolApproval.ts` `PendingApproval` |
SSE 帧 `tool_permission_request` 只有 `toolCallId / toolName / args` | `app/api/chat/_pipeline/frames.ts` |

### 2.2 行为契约（4.6 原文，摘录）

| 审批模式 | 越界时 |
|---|---|
`bypass`（YOLO） | **block**（"这次不问你" ⇒ 答案只能是"不行"） |
`never` | **block** |
`suggest`（默认） | **request** + 帧里带 `danger: { kind: "outside-workspace", targets }` |

- 放行靠**一次性通行证**（one-shot permit：批准一次、只够用一次）：**不记忆**、不写"一直允许"、下一次同样越界还会弹。
- `bash` **不参与**越界判定（命令里的路径静态解析必然骗人：引号、变量、管道），只做**粗筛**：命中痕迹 ⇒ 不再自动放行、转普通弹框，**批准即执行**（宽松，不拦）。

### 2.3 为什么会漏（记下来，别重演）

`doc/plan/workspace.md` 的 4.15 把工作切成 10 个 commit，第 4 个是"越界分类 + 单测"，而接线只写进 5.1 的备注「下一步接线时才做」—— 那个"下一步"**没有落到任何 commit 上**。教训：**"纯函数 + 单测"不是一项功能的终点；接线要有自己的 commit 位。**

## 三、原状态格存档（从 C6 拆出来的理由）

C6 池子原文只要求：**应用内目录浏览器选一个文件夹 + 每个会话必须挂已登记工作空间**。这两条都已完成。
4.6 是详案里"围栏改变之后的连带后果"，**不在 C6 那句话的射程内** ⇒ 拆为 C55，C6 按原文范围标 `已交付`。

## 四、详细设计

### 4.1 全景数据流（一次越界写）

```
POST /api/chat
 ├─ permits = createEscapePermits()                    每请求一份（不跨消息残留）
 ├─ toolContext = { workspaceRoot, skillsRoots, permits }
 │      └─ 8 个文件工具工厂闭包捕获 permits
 └─ runPipeline
      └─ 模型要 write_file path="E:\other\x.md"
            │
            ├─ 钩子 beforeToolCall → handleToolApproval
            │    ├─ ① blockSecretWrite（secret 永远先拦，不弹框）
            │    ├─ ② classifyEscape(call, workspaceRoot)
            │    │      ├─ inside  → 走原有三条：只读 bash / 记忆 / 弹框
            │    │      └─ outside → 按模式：bypass=block / never=block / suggest=request+danger
            │    └─ request → 推帧（带 danger）+ 注册挂起（挂 grant 闭包）
            │
            └─ 用户点「仍要执行」→ POST /api/chat/approve（**另一个请求**）
                   └─ 从 globalThis 挂起表找到该项 → pending.grant() → resolve("approved")

  工具执行：resolveInsideWorkspace(root, "E:\other\x.md", permits)
      ├─ 围栏外 → permits.consume(目标) 命中 → **放行这一次**（并删除）
      └─ 未命中 → 照旧 throw "路径越界"
```

**关键接缝**：`permits` 活在 chat 请求的闭包里，而"批准"来自另一个 HTTP 请求。两者靠 `toolApprovals`（挂在 `globalThis` 上的挂起表）里的 `grant` 闭包相接 —— 这是本设计**唯一**不可省掉的跨请求桥。

### 4.2 判定顺序（三条硬规矩，写错就静默放行）

| 顺序 | 规矩 | 反了会怎样 |
|---|---|---|
1 | `blockSecretWrite` **先于**越界判定 | 写 `.env` 会被降级成"可以问人"，secret 的"永不弹框直接拦"就废了 |
2 | 越界判定**先于**记忆放行（`isPersistApproved` / `isSessionApproved`） | 之前点过"一直允许 write_file"，越界写就**不再弹框** —— 违反"越界每次都问" |
3 | `bypass` 模式下越界 = **block** | 写成 allow 等于 YOLO 把围栏也关了 |

### 4.3 接口契约（签名即契约）

```ts
// lib/tools/path-utils/index.ts
export function resolveInsideWorkspace(
  workspaceRoot: string,
  input: string,
  permits?: EscapePermits,   // 新增：越界时先消费一次性凭据
): string

// 8 个文件工具工厂（read/write/edit/delete/grep/find/list/write-note）
export function createReadTool(workspaceRoot: string, permits?: EscapePermits): RegisteredTool
// ……其余同名改法

// lib/tools/index.ts
export type ToolContext = {
  workspaceRoot: string;
  skillsRoots: string[];
  permits?: EscapePermits;   // 新增
};

// app/api/chat/_pipeline/approval/index.ts
export type ApprovalContext = {
  sessionId: string;
  approvalDir: string;
  workspaceRoot: string;     // 新增：越界判定的基准
  getApprovalMode: () => "suggest" | "bypass" | "never";
  isReadOnlyBash: (command: string) => boolean;
  isPersistApproved: (dir: string, toolName: string) => Promise<boolean>;
  isSessionApproved: (sessionId: string, toolName: string) => boolean;
};

export type ApprovalDecision =
  | ToolDecision
  | { action: "request"; danger?: EscapeDanger };   // 新增 danger

export type EscapeDanger = { kind: "outside-workspace"; targets: string[] };

// app/api/chat/_pipeline/frames.ts
| {
    type: "tool_permission_request";
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    danger?: EscapeDanger;   // 新增
  }

// lib/toolApproval.ts
export type PendingApproval = {
  toolName: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  grant?: () => void;        // 新增：人批准后发放一次性凭据
};
```

### 4.4 逐文件改动清单

| # | 文件 | 改什么 | 期 |
|---|---|---|---|
1 | `lib/tools/path-utils`（+test） | `resolveInsideWorkspace` 收 `permits?`，越界时先 `consume` | 一期 |
2 | 8 个 `lib/tools/*/index.ts` | 工厂加第 2 个参数并下传围栏 | 一期 |
3 | `lib/tools/index.ts` | `ToolContext.permits`，注册表发给 8 个工厂 | 一期 |
4 | `app/api/chat/_pipeline/context/index.ts` | 每请求 `createEscapePermits()` 塞进 `toolContext` | 一期 |
5 | `app/api/chat/_pipeline/approval`（+test） | `ApprovalContext.workspaceRoot`；接 `classifyEscape`；`request` 带 `danger` | 一期 |
6 | `app/api/chat/_pipeline/frames.ts` | 帧加 `danger?` | 一期 |
7 | `lib/toolApproval.ts` | `PendingApproval.grant?` | 一期 |
8 | `app/api/chat/route.ts` | 推帧带 `danger`；注册挂起时挂 `grant` | 一期 |
9 | `app/api/chat/approve/route.ts` | 允许时先 `grant?.()` 再 resolve | 一期 |
10 | `app/lib/use-agent-run.ts` + `app/components/approval-dialog` | 帧类型 + 危险样式 / 绝对路径 / 「仍要执行」 | 一期 |
11 | `app/api/chat/_pipeline/approval`（+test） | 只读 bash 分支加 `hasEscapeTraces` 粗筛 | **二期** |

### 4.5 两期切分（怕工作量大就只做一期）

| 期 | 内容 | 闭环了什么 | 规模 |
|---|---|---|---|
**一期** | 上表 1–10 | I4 的 1–5 条：越界弹框、列绝对路径、拒绝/允许、批准后**真的能执行**、再试仍弹 | 10 文件（8 个是机械传参） |
**二期** | 上表 11 | I4 第 6 条：只读 `bash` 不再静默放行 | 1 文件 + 3 条用例 |

> 一期的价值远大于二期：**没有它，"越界审批"只是三个没人调用的纯函数**；二期堵的是另一个面（只读命令读外面文件）。

### 4.6 已知边界（不解决，但必须写着）

1. **凭据靠 `globalThis` 挂起表跨请求**：dev server 若多进程（worker 不同），approve 与 run 可能落在不同进程 ⇒ 凭据丢失，症状是"批准了仍报越界"。本地单进程开发不受影响。沿用 `toolApproval.ts` 既有取舍。
2. **`bash` 粗筛会误报**：命令里出现 `C:\` 但其实是工作区内的绝对路径 ⇒ 多弹一次框。代价是摩擦，不是错。
3. **一次批准只覆盖"这一次工具调用的那些目标"**：模型若在另一条消息里再越界，照旧弹。
4. **不做**回收站/白名单目录/按目录授权（另一个迭代）。

## 五、验收

### 5.1 单测（预计 14–17 条）

| 层 | 用例 | 条数 |
|---|---|---|
`path-utils` | 有凭据 → 放行；**第二条**同一目标 → 抛错（一次性）；无凭据 → 抛错 | 3 |
`approval` | 越界 × 三种模式（suggest=request+danger / bypass=block / never=block）；界内不受影响；**secret 优先于越界**；越界**无视**"一直允许"记忆 | 6 |
`approval`（二期） | 只读 + 无痕迹 → allow；只读 + `C:\` → request；只读 + `..` → request | 3 |
`frames` / 类型 | `danger` 原样透传（可并入 approval 用例） | 1 |
`permits` | 已存在（一次性 + 路径规范化） | （已有 2） |

### 5.2 真机（沿用详案 I4）

1. 工作空间 = `E:\work-space\agent-learn\workspace`，让模型写 `C:\Users\25082\test.txt` → **弹框**、显示绝对路径
2. 拒绝 → 失败；允许 → **写入成功**
3. 同一个越界再试 → **仍然弹**（不记忆）
4. 同一目标第二次（同一次 run 内再调一次）→ **又弹**（凭据只用一次）
5. （二期）`Get-Content C:\Users\25082\.env` → **弹框**

### 5.3 出口判据

`tsc --noEmit` 0 · `eslint` 0 · 单测全绿 · 上表 5.2 全过 · **`git diff` 不含 `lib/agent/index.ts`**（红线零改动）

## 六、⛔ 缺什么才能开工

- [ ] **排进迭代**：本项还没排期（池子里 `未开始`）。要么并进 I2 收尾，要么开 I3
- [ ] **一期 / 二期拆不拆**：如果只做一期，I4 要改成 5 条 + 1 条遗留
- [ ] **前端危险样式的具体形态**：按 `AGENTS.md` 第 11.8 条，动弹框前要 `skill(frontend-design)` + 读 `app/components/approval-dialog` 现有形态，产出「继承 / 改动」两栏再动手（不能凭"我觉得危险一点好"改）
