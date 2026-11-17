# 越界 → 危险操作审批（4.6 接线）—— 改造方案

> **状态**：**一期已实现**（2026-11-11，同一分支）。单测全绿（新增 13 条，全套 849），**真机 I4 还没跑**（要一次真实模型调用）。
> **二期已并入一期**：只读 `bash` 的粗筛就在同一个决策函数里，3 条用例一起补了 —— 分两次反而要多碰一次这个文件。
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

## 七、2026-11-17 补记：按 pi / pi-web / DSH 实读结果重做三处（**上面 4.x 里被推翻的部分以本节为准**）

### 7.1 触发

用户要求"这三个方向都参考 pi-web 或 deepseek-harness"——即 **① 围栏判据（含软链）② bash 边界 ③ 审批粒度/记忆**。
三条都读了源码，结论是**我们原来三处都做得比参考实现弱**：

| 方向 | 我们原来的做法 | DSH | pi-web | 结论 |
|---|---|---|---|---|
| 围栏判据 | `resolve` + `relative` 纯字符串 | `realpathSync.native`（`packages/sandbox/sandbox/src/roots.ts`）；`fs-sandbox` 在**改文件前重新规范化**并用新目标执行（`packages/fs/fs-sandbox/src/index.ts`） | `resolveRealRoots` + `isExistingPathWithinRoots` 双侧 realpath、Windows 转小写、拒含 `..` 段（`lib/path-security.ts`） | **必须 realpath**；且只留**一份**判据（DSH「单一推导处」原则） |
| bash 边界 | 静态分析命令文本（4 条正则） | OS 级沙箱（Seatbelt / Landlock / bwrap / **windows-acl**），文件工具与 bash **共用同一套可写根**；默认拒绝，模型须带 `sandbox_permissions` + `justification` 申请提权（`packages/sandbox/sandbox/src/escalation.ts`） | 不碰 bash（Web 外壳） | **两家都没有"猜命令"这条路**；我们这条路必然漏 |
| 审批粒度 | 四档：允许 / 本会话 / 一直允许 / 拒绝，按**工具名**记忆 | 只有 `allowed-once`（`interaction/user-approval/src/index.ts`），策略只有 `ask \| never`；"不再问"是**改设置**，且有 `approval/asked` + `approval/decided` 持久审计（`user-approval/src/types.ts`） | 项目信任 + 按 target 显式允许（`lib/linked-directory.ts`） | **弹框不产生记忆**；"不想再问"改成模式开关 |

### 7.2 落地的四个决定

1. **围栏加 realpath**（`lib/permission/tool-escape`）：`canonicalize` = `realpathSync.native`；不存在的目标**逐段向上**找已存在祖先再拼回尾部；只对 `ENOENT` / `ENOTDIR` 降级，`EACCES` 一律抛（静默降级 = 又拿没跟过链的字符串去判包含）。Windows 比较前折叠大小写。
2. **判据只留一份**：`inspectPath(root, input)` 是唯一答案来源，围栏（`lib/tools/path-utils`）与审批（`_pipeline/approval`）都调它。
   - `inside` → 放行（返回**真实路径**，后续 fs 用同一个，缩小 TOCTOU 窗口）
   - `outside`（人自己写的外面路径：`..` / 别的盘 / 绝对路径）→ suggest 弹**危险**框
   - `linked`（**字面在根内、真实落点在根外**：软链 / junction）→ **block，不问**
3. **bash 一律弹框**：删掉 `lib/permission/readonly`（只读命令静态判定，约 390 行含测试）与 `hasEscapeTraces`。理由：静态解析命令里的路径必然骗人（实测 `Get-Content $env:USERPROFILE\a.txt` 被判成"只读"⇒ 自动放行 ⇒ 读到根外），而**我们做不出 DSH 那样的 OS 级沙箱**（Windows 上要发 SID/ACL）。⇒ 承认边界：**bash 由人逐次把关，不由围栏**。
4. **审批不产生记忆**：`ApprovalOutcome` 只剩 `approved | denied | timeout`；删 `lib/permission/approval-memory`（内存 + 磁盘规则）；`approve` 接口去掉 `session` / `persist`；弹框只剩「允许 / 拒绝」两档；"整轮不打断"交给页面上的**审批模式**（`suggest / bypass / never`，`globalThis` 状态，重启恢复）。
5. **审计补齐**：引擎只在 `block` / `rewrite` 时发 `tool_permission` ⇒ **"越界被批准"在轨迹里原本是空档**。现在 `handleToolApproval` 在越界获批时补一条 `action: "allow"` + `reason` 的 `tool_permission`（DSH 对应 `approval/decided`），两个折叠器（`app/lib/trace-fold.ts`、`app/lib/trace-steps`）按 `reason` 区分"普通放行"与"越界放行"；拒绝理由也带上目标列表（原来只说"用户拒绝了"，模型下一轮照原样再试）。

### 7.3 与上文冲突、作废的部分

- **4.5 的"二期"不存在了**：它写的是"只读 bash 命中越界痕迹才转弹框"——现在是 bash **一律**弹框，二期并入一期。
- **4.6 边界 ②（bash 粗筛会误报）**作废：没有粗筛了，误报问题消失，换来的是"每次都问"的摩擦。
- **5.2 第 5 条**（`Get-Content C:\Users\25082\.env` → 弹框）现在是**必然**弹框（所有 bash 都弹）。

### 7.4 新增的已知边界（继续写着，别假装没有）

1. **bash 出不出得去，取决于人看不看**：命令里 `cd ..`、读别的盘、`$env:` 展开，围栏一概不管 —— 只有弹框里那行命令能让人拦住。这是基线，不是 bug。
2. **软链没有白名单**：`linked` 一律拒，连"这个链可信"的持久授权也没有（pi-web 有 `linked-directory` 的 target 级授权，我们没做）。⇒ 工作空间里若真有一条指向外面的链，模型只能改走**绝对路径**（那会弹危险框、显示真实目标）。
3. **一次性凭据跨请求仍靠 `globalThis`**（沿 4.6 边界 ①），dev 多 worker 时可能丢凭据。
4. **越界弹框在真机上"够不着"**（2026-11-17 实测撞到，见 7.5）：模型**根本不肯**发起越界调用 —— 原话「`read_file` 只能读安全工作区内的相对路径……即使你同意我也不绕」。原因是我们自己的工具说明（`RegisteredTool.guidelines`）把围栏写成"绝对"。⇒ 危险弹框作为**安全网**没能在真机上验到；想让它可触发，得改工具说明（"越界会向你确认，可以提出请求"）—— 那是**产品行为**改动，留给用户拍板。
5. **bash 无 OS 级沙箱**：DSH 能把 bash 关进 Seatbelt / Landlock / windows-acl，我们做的是"逐次问人"。差距要写在这里：**人不在场时 bash 没有第二道门**（拒绝即停，不会"先关起来再执行"）。
6. **「额外授权目录」不做**（2026-11-17 用户明确"暂时不需要"）：也就是不能把某个外部文件夹登记成"额外根"、之后不再逐次弹框。参考机制见 DSH 的 extra roots（`packages/sandbox/sandbox/src/roots.ts`）与 pi-web 的 linked-directory target 级授权（`lib/linked-directory.ts`）。将来真需要时再单独入池 —— 它与本文件不冲突，因为**根是策略、审批是一次性的**。

### 7.5 真机验收记录（2026-11-17，dev server + 浏览器）

验到的：

1. 起 `pnpm dev`（`localhost:3000`）→ 建工作空间 `E:\work-space\agent-learn\workspace` → 新会话。
2. 发「用 bash 执行 echo c55-two-buttons」→ 弹卡，**只有「Y 允许 / N 拒绝」两个按钮 + 一行去向提示**（截图确认；旧的四档按钮没回来）→ 点允许 → 命令执行成功（`bash ✓ 成功`，2 行输出）→ 模型复述 `c55-two-buttons` ✅
3. 轨迹文件正常写出（`trace.run_*.jsonl`，事件序列无异常）。

没验到的（就是 7.4 ④）：

4. 越界弹框：先让模型**写** `C:\Users\25082\.statve\c55-outside.txt`、再明确授权它**读** `C:\Users\25082\.statve\workspaces.json` —— 两次都**拒绝发起工具调用**（"超出我的权限范围 / 即使你同意我也不绕"）。⇒ 危险样式、绝对路径列表、一次性凭据这一整条链，本轮**只有单测**，没有真机证据。
5. 收尾清理：删掉测试工作空间（级联删 1 个会话），`workspaces.json` 回到 `{"version":1,"workspaces":[]}`（数据根没留垃圾）。

### 7.6 本轮单测变化

- 新增：junction 夹具的真文件系统用例（`tool-escape` 5 条 + `path-utils` 4 条；含"报错**不**说出链指向哪"这条防绕过用例）、bash 一律弹框 5 条、软链 block 3 条、Windows 大小写 1 条。
- 删除：`approval-memory`（8 条）、`readonly`（约 30 条）、`hasEscapeTraces`（2 条）、"记忆放行"3 条、"只读 bash 粗筛"3 条。
- 总数 849 → **818**（60 文件）。

### 7.7 2026-11-17 补记：改工具说明之后，越界弹框**真机验到了**（C55 收尾）

用户 2026-11-17 拍板（选项 B）：**只改 7 个带路径工具的描述 + `path` 参数说明** ——
从"只能读工作区内"改成"默认在工作空间内；确实需要外面时，可以用绝对路径提出
（会先向人确认，且只放行这一次）"。**围栏与审批逻辑一行没动**。

为什么必须改文案：7.4 ④ 记过 —— 模型原话「`read_file` 只能读安全工作区内的相对路径……
即使你同意我也不绕」，于是危险卡片**永远没有机会出现**，这条链只有单测没有真机证据。

真机（同一台机器、同一个 dev server `localhost:3000`，工作空间 = 一个临时文件夹）：

1. 让它读工作空间外的 `C:\Users\25082\.statve\workspaces.json`
   → **危险卡片正常出现**：红色描边、列出**绝对路径**、只有「仍要执行 / 拒绝」两个按钮 ✅
2. 点「仍要执行」→ 读到内容并原样贴出（JSON 内容正确、确实是那个文件）✅
3. **再让它读同一个文件** → **又弹一次**（一次性凭据确实不记忆）→ 点「拒绝」
   → 工具回「用户拒绝了这次越界到工作空间之外的调用（`C:\…\workspaces.json`）」，
   模型据实转述、并说明"每次都要单独确认" ✅

⇒ **7.4 第 4 条与 7.5 第 4 条描述的"够不着"已被本节取代**；5.2 那 5 条真机验收现在**全部有证据**。

副作用（写着，观察）：模型会更愿意"试着用绝对路径"，可能多弹几次框 ——
文案里用"确实需要"压住了"探索性越界"，但压不死。若以后觉得太烦，再收一次口径。
