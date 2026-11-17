# 会话侧栏收敛 + 选空间即开会话

> 池子：**C56**（见 `PLAN.md` 的需求池）
> 状态：**详细设计已写、验收已写；3 个语义决定待拍板**（见第六节）
> 参考：`E:\agents-read\deepseek-harness\packages\client\ui-workspace`、`ui-sidebar`、`ui-conversation`
> 触发：用户 2026-11-17 的三条原话（见第一节）+ 同一条消息里挂的 DSH 截图

---

## 一、需求（池子行原文）

> **会话侧栏收敛 + 选空间即开会话**：① 侧栏会话行从三行字（标题/预览/时间 ≈69px）压成**单行 34px**（时间靠右、悬停让位给 ⋯）② 登记工作空间成功后**立刻建一个空会话并选中**（标题「新会话」），不再要求手动点组头 ＋ ③ 没有会话时输入台与发送按钮一起禁用，并给出路

用户原话（2026-11-17，一条消息三条）：

1. 「新增工作空间之后，右侧一直是可输入状态，但是因为没有新增会话导致不能提问」
2. 「左侧每一个会话的不够紧凑」
3. 「以 deepseek 为例，每次新增了工作空间之后 就默认了以当前新增的工作空间为主了 不需要再手动新增会话」

---

## 二、依据

### 2.1 DSH 的会话行：32px 单行，时间靠右

| 事实 | 位置 |
|---|---|
| 工作空间行与会话行**都是 `height: 32px`**；行内 `padding: 0 8px`，左内边距由 `--dsh-sidebar-row-padding: 12px` 减去 3px「描边内缩」再叠加缩进 | `ui-workspace/src/client/rows/Rows.module.css:1-16`、`:112-126`；`ui-sidebar/src/client/SidebarRoot.module.css:11-12` |
| 标题 14px / 行高 20px，单行省略；**没有"第一句预览"这一行** | `Rows.module.css:181-188` |
| 时间 10px / 16px、三级墨色、`margin-inline-end: -1px` 贴右 | `Rows.module.css:238-244` |
| 选中态 = hover 底色（没有任何边框/左侧竖条） | `Rows.module.css:24-26`、`:50-54` |
| 长标题不截断了事：**悬停跑马灯**（去程匀速跑到末端、停住、离开瞬回起点；两端 12px 渐隐） | `Rows.module.css:202-227` |
| 组头（工作空间行）另有一条：默认显示文件夹图标，**hover 时图标换成展开箭头** | `:156-162` |

### 2.2 DSH 的会话创建时机：**选完工作空间就建，不等第一句话**

> “Selecting a Workspace **creates the Session** needed by these controls; **the first message is not required**.”
> —— `ui-conversation/README.md:111`

同一段还写了「blank Session」（空会话）是**正式状态**：保留头部的前导与角落控件，隐藏标题、动作、工具与 View tabs。

### 2.3 我们的现状（数字都给出来）

| 位置 | 现状 |
|---|---|
| `app/components/session-list/session-list.module.css:94-107` | `.sessionItem`：`margin-bottom: 6px`、`padding: 12px 14px`、`border: 1px solid transparent` |
| 同文件 `:117-146` | 三行字：标题 13.5 / 预览 12.5（`margin-top: 3px`）/ 时间 12（`margin-top: 4px`）⇒ **有预览 ≈ 69px、无预览 ≈ 47px** |
| `app/components/session-list/session-row.tsx:146-179` | 三块 DOM：`.sessionTitle` / `.sessionPreview`（仅当 title 与 preview 都有）/ `.sessionMeta` |
| `app/page.tsx:547-554` | 选完文件夹只做 `createWorkspace` → 关对话框；**没有建会话** |
| `app/lib/use-sessions.ts:63-75` | 挂载时 `currentId = 列表第一个 ?? ""` ⇒ 新空间进来不改变当前会话 |
| `app/api/chat/route.ts:68-110` | `sessionId` 缺省回落成 `"default"`，随后 `locate` 找不到 ⇒ **404「会话不存在：default」**（这就是第 1 条的症状：能打字、按回车必报错） |
| `app/page.tsx:150-173` | `useCommandMenu({ ..., disabled: loading })` —— **输入台是否可用只看 `loading`**，与会话是否存在无关 |

---

## 三、目标形态（一条工作空间组）

```
▾ agent-learn 1        ← 组头：chevron + 名字 + 计数 [+][⋯]（hover 才现身）
   用 bash 执行 echo …  22:31   ← 会话行：单行 34px，时间靠右
   项目正式改名计划     7 天
   看看项目原来打算干啥 21 天
```

- 行高 **34px**（我们已经有 `--hit: 34px`，不另造数字）；标题占满剩余宽度、超出省略；时间常驻右侧；
- 悬停（或键盘聚焦到行内）时**时间淡出、⋯ 菜单顶上来**（同一个位置，不叠两层）；
- 状态点（呼吸/黄/绿）**绝对定位在行首左侧 5px**，不参与排版 ⇒ 有没有状态点的行标题不会错位；
- 组头保持不变（上一版已批准，C49/C51）。

---

## 四、详细设计

### 4.1 会话行：从三行到单行

| 属性 | 现在 | 改后 | 为什么 |
|---|---|---|---|
| 行骨架 | `block`（三个 div 堆叠） | `display: flex; align-items: center; gap: 8px` | 单行需要横向排列 |
| 行高 | 无（由内容撑开） | `min-height: var(--hit)`（34px） | 用现成 token，不新增尺寸 |
| 内外距 | `padding: 12px 14px`、`margin-bottom: 6px` | `padding: 3px 8px 3px 14px`、`margin-bottom: 1px` | 左边 14px 给状态点让位；底部 1px 只做视觉呼吸 |
| 标题 | 13.5px，`padding-right: 32px`（给 ⋯ 留位） | 13px，`flex: 1 1 auto; min-width: 0`（不需要给 ⋯ 留位，因为 ⋯ 在时间那一格） | — |
| 时间 | 第三行（`margin-top: 4px`） | 同一行，`margin-left: auto`，12px，`--ink-faint` | 省一整行（≈19px） |
| 预览 | 第二行 | **删掉**（连同 `.sessionPreview` 类） | 省一整行（≈17px）；见 4.2 的语义说明 |
| 状态点 | 时间左边、8px | 绝对定位，6px | 不参与排版、不抢视线 |
| ⋯ 菜单 | `top: 10px; right: 10px` | `top: 50%; right: 6px; translateY(-50%)` | 行变矮，垂中 |

一行的高度估算：`3 + 20(标题行高) + 3 + 2(边) ≈ 28`，`min-height: 34px` 兜底 ⇒ **34px**。对比今天 47–69px ⇒ 同样高度能多看到 **1.4–2 倍**会话。

### 4.2 「预览」那一行为什么可以删

`.sessionPreview` 只在 **`title` 与 `preview` 同时存在**时渲染（`session-row.tsx:155`）。
而标题的取值本来就有回退链：`session.title ?? session.preview ?? "未命名会话"`（`:152`）。

⇒ 删掉预览行的实际损失只有一种情况：**已经手动改过名、又想看第一句话**。
一开聊就自动显示首句的会话（没改名的那批，绝大多数）**一点信息都不丢**。

### 4.3 空会话：标题留空，只改回退文案

- **不把 `title` 写成「新会话」**。写死的话，这一行会永远叫「新会话」——因为标题一旦存在就不再回退到首句，用户还得手动改名。
- 做法：`title` 留空（服务端 `title?: string` 本来就允许，`app/api/sessions/route.ts:44-46`），只把**回退文案**从「未命名会话」改成「新会话」（`session-row.tsx:153` 一处）。
- 结果：空会话显示「新会话」；用户一开口，标题仍为空 ⇒ 自动显示首句。**两个好处都拿到**，且不需要改名。

### 4.4 选工作空间 → 立刻建会话

```ts
// app/page.tsx 的目录浏览器 onPick（现在只做前三行）
const workspace = await createWorkspace(path);   // 登记记录
if (workspace) {
  await create(workspace.id);                    // ① 建空会话（use-sessions.create）
                                                 //    内部会 setCurrentId + refresh
  setBrowserOpen(false);                         // ② 成功才关对话框
}
```

`use-sessions.create(workspaceId)` 现状：`POST /api/sessions` → `setCurrentId(data.id)` → `refresh()`（`app/lib/use-sessions.ts:81-95`）。
所以**不需要新增接口**，只加一次调用。

失败分支（必须写清，否则又是"点了没反应"）：

| 分支 | 现在的行为 | 改后 |
|---|---|---|
| 登记失败（409 已登记 / 400 路径不对 / 500） | 对话框不关，显示原因 | **不变** |
| 登记成功、建会话失败 | —— | 对话框**照常关掉**（空间已经登记好了，留在对话框会让人以为登记也失败），错误横幅由 `useSessions.create` 的失败分支给出；侧栏该组显示「在这里开第一个会话」 |
| 登记成功、建会话成功 | —— | 关对话框 + 新会话被选中 + 输入台立刻可用 |

### 4.5 没有会话时的输入台门禁

三处一起改（只改一处会留下"按钮亮着但按了报错"）：

| 位置 | 现在 | 改后 |
|---|---|---|
| `useCommandMenu({ disabled })`（`page.tsx:172`） | `loading` | `loading \|\| !currentId` |
| `<textarea disabled>`（`page.tsx:490`） | `loading` | `loading \|\| !currentId` |
| 发送按钮 `disabled`（`page.tsx:516`） | `!input.trim()` | `!input.trim() \|\| !currentId` |

文案（两处，都要能照着做）：

- 输入框占位：有会话 → 现在的「给它一个目标，例如：读取 agent-notes.md 并总结要点」；无会话 → **「先在工作空间里开一个会话，再给它目标」**；
- 底栏右侧提示：无会话 → **「还没有会话：点左侧工作空间组头的 ＋，或新增一个工作空间（会自动开会话）」**。

> 为什么选"禁用"而不是 DSH 那种"整张卡变成工作空间选择器"：那是把**目录浏览器从模态搬进输入框**的结构改动（见 `chat-surface-dsh-alignment.md` 4.7 的"不抄清单"），成本比这一整条 C56 还大。做完 4.4 之后，"没有会话"几乎只剩「一个工作空间都没有」这一种场景，不值得为它改输入台结构。

### 4.6 文件级改动清单

| 文件 | 改什么 | 量 |
|---|---|---|
| `app/components/session-list/session-row.tsx` | 单行三兄弟（点/标题/时间）；删 `.sessionPreview` 块；回退文案「新会话」 | ~25 行 |
| `app/components/session-list/session-list.module.css` | 行骨架/高度/内外距；`.sessionMeta` → `.sessionTime`；删 `.sessionPreview`；状态点绝对定位；⋯ 垂中；悬停时时间淡出 | ~60 行 |
| `app/page.tsx` | `onPick` 加建会话；三处 disabled；两处文案 | ~20 行 |
| （不改）`app/lib/use-sessions.ts`、`app/api/sessions/route.ts`、`app/lib/session-groups` | 都不需要动 —— 这是本方案刻意的收窄 | 0 |

### 4.7 边界（不解决，但必须写着）

1. **删掉某组最后一个会话后不自动补**：删干净是用户的意思；组里留「在这里开第一个会话」那行虚线按钮即可。⇒ 于是"每个工作空间至少一个会话"**不是**不变量，「没有会话」这个状态依然存在，4.5 的门禁不是死代码。
2. **选一个已登记过的文件夹（409）不切焦点**：仍然留在对话框显示「这个文件夹已经登记过」。切焦点是另一件事（要读它最近的会话并选中），等有人提再单独做。
3. **行高固定 34px 之后，长标题只靠省略号**：DSH 那套悬停跑马灯（`Rows.module.css:202-227`）先不做 —— 它是"锦上添花"，且要写逐帧脚本（`reduced-motion` 要另走一跳）。标题完整文本用 `title` 属性兜底。
4. **多标签页/多窗口**：另一个窗口删了这个工作空间，本窗口点发送会拿到 404 —— 与今天同款，不在本项范围内。
5. **自动建会话会让"空会话"变多**：每加一个工作空间就多一条「新会话」。这是 DSH 的形态（blank Session 是正式状态），代价是侧栏会短暂出现空行 —— 用户开口后它会变成首句。

---

## 五、验收

### 5.1 单测

本项**没有新增纯函数**（分组逻辑 `app/lib/session-groups` 已经在，且不需要改）。
所以单测只有一条"护栏"：

| 用例 | 位置 | 钉住什么 |
|---|---|---|
| 分组不为空组造会话（已有） | `app/lib/session-groups` 现有 12 条 | 本项**不许**为了"每组都有会话"去伪造数据 |

> 若最后决定把"选空间即建会话"做成**纯函数**（比如 `shouldCreateSessionOnPick`），则按"实现与单测同目录"补 `index.test.ts`。默认方案是一次 `create()` 调用，不为此造函数。

### 5.2 静态检查

`tsc --noEmit` = 0；`eslint lib app` = 0；改到的文件过 `prettier --check`。

### 5.3 视觉与真机（必须自己看，不能只靠 `tsc`）

1. 起 `pnpm dev`，浏览器打开 `/`；
2. **侧栏计数**：同一屏（视口高 742px 的默认窗口）能看到的会话条数，改造前 vs 改造后各截一张 —— 目标 **≥ 1.5 倍**；
3. **单行完整性**：长标题（>30 字）不换行、不撑破侧栏（侧栏 `grid-template-columns: minmax(0,1fr)` 的横向溢出问题曾出现过，见 `session-list.module.css:9-13` 注释）；悬停时时间淡出、⋯ 出现在同一位置；
4. **新增工作空间**：点侧栏 ＋ → 选一个空文件夹 → 对话框关闭 → **侧栏立刻出现该组 + 一条「新会话」且它是选中态** → 直接在输入框打字发送 → 正常开始一次 run；
5. **无会话门禁**：把该工作空间删掉（组头 ⋯ → 删除）→ 输入框与发送按钮都禁用、占位文案与底栏提示变成 4.5 那两句；**按 Enter 不再触发 404**。

### 5.4 出口判据

- `tsc` / `eslint` / `prettier` 三项 0；
- 5.3 五条全过（截图留档）；
- **红线零改动**：`git diff --name-only` 不含 `lib/agent/index.ts`；
- 全量单测绿（当前基线 **818 / 60 文件**）。

---

## 六、⚠️ 缺什么才能开工（需要你拍板）

1. **2a 单行 vs 两行**：删掉预览行（34px/行）还是保留预览（≈50px/行）？**建议：单行**。
2. **4.3 空会话命名**：「标题留空 + 回退文案改『新会话』」（建议）还是真的把 title 写成「新会话」？
3. **4.4 失败分支**：建会话失败时**照常关对话框**（建议，因为空间已登记成功）还是留在对话框里报？
4. **顺序**：C55 那 39 个文件还没提交 —— 先把 C55 提交掉，再开分支做 C56？（建议：是）

## 七、实施记录（2026-11-17，本轮只做"会话归属"这一半）

### 7.1 最终语义（用户 2026-11-17 逐句确认）

| 场景 | 行为 |
|---|---|
| 新增工作空间 | 同时**新建一条会话并选中**它 |
| 已有的工作空间点组头 ＋ | 新建一条会话并选中它 |
| 新会话的**默认标题** | 「新会话」（写进会话头的 `title`，不是显示兜底） |
| 用户发出**第一条**消息 | 标题自动改成**那句话**（压成单行、超 30 字截断）；之后不再自动改 |
| 空会话 + **用户切换会话** | 展开见 7.2 —— 就在切换这一刻删掉它 |
| 用户手动改过名 | 自动标题**不动**它（人起的名字优先） |
| 没有任何会话（如一个工作空间都没有） | 输入框与发送按钮**一起禁用**，占位文案说清"先开一个会话" |

### 7.2 "没有数据"的判据与删除时机

- **判据**：会话文件里 `type === "message"` 的条目数 = 0（`todo` / `compaction` 条目不算对话）。
- **时机**：只在一个地方 —— **离开当前会话之前**（`app/page.tsx` 的 `discardUntouched()`）：
  切到别的会话、在当前组新建会话、又新增一个工作空间，这三种都算"离开"。
- **服务端兜底**：`DELETE /api/sessions?id=…&ifEmpty=1` 会**以磁盘为准**再判一次；
  有内容就返回 `deleted:false`、**一个字节都不动**。客户端视图过期也不会误删。
- **不做**（用户没要求，且会造回"没会话"的死角）：挂载时清扫、关页面时清扫。

### 7.3 与第四节原方案的差异（以本节为准）

| 原来写的 | 实际落地 | 为什么 |
|---|---|---|
| 4.3「空会话：标题留空，只改回退文案」 | **标题写「新会话」，首条消息后自动改名** | 用户拍板：要的是"发出去之后改标题"，不是"留空靠兜底" |
| 4.5「没有会话时输入台禁用」 | 一致 | 用户第 1 条抱怨的就是"能输入但问不了" |
| 4.7 边界第 1 条「不自动补会话」 | 一致 | 删干净是用户的意思；组里留"在这里开第一个会话" |
| （没写） | 新增：`empty` 删除只在**切换**时发生 | 用户澄清："切换的时候就移除掉" |

### 7.4 改了哪些文件

| 文件 | 改动 |
|---|---|
| `lib/session/manager/index.ts` | `DEFAULT_SESSION_TITLE`；`create` 默认标题；`adoptFirstMessageAsTitle`（三个前置条件）；`deleteIfEmpty`；`writeLinesAtomically`（把 rename 里那段原子写抽出来复用） |
| `lib/session/manager/index.test.ts` | +12 条（删除入口 4 条 + 默认标题/自动改名 6 条 + 既有闭环 2 条） |
| `app/api/sessions/route.ts` | `DELETE` 支持 `?ifEmpty=1` |
| `app/api/chat/route.ts` | 跑之前调 `adoptFirstMessageAsTitle`（改不动就算了，不影响这次对话） |
| `app/services/sessions/{index,types}.ts` | `discardEmptySession` + `DiscardResult` |
| `app/lib/use-sessions.ts` | `discardEmpty(id)`：删成功后**本地立刻去掉那一行**（避免"行还在、点进去 404"） |
| `app/page.tsx` | 新增工作空间后建会话；`discardUntouched()` 接三个"离开"入口；输入台三处 disabled + 两句文案（提到模块层，避免顶破圈复杂度） |
| `app/components/session-list/session-row.tsx` | 标题与预览**相同时不再重复渲染预览**（自动标题会让两者相等，原来会同一行话显示两遍） |

### 7.5 真机验收（浏览器，dev server `localhost:3000`）

| 步骤 | 结果 |
|---|---|
| 侧栏 ＋ → 输入 `%TEMP%\statve-live-ws` → 加为工作空间 | 侧栏立刻出现该组，**计数 1**，组下一条「新会话」并**处于选中态**；输入台可用（占位是"有会话"那版） ✅ |
| 直接发一句「只回答一个问题：1+1 等于几？不要调用任何工具。」 | 侧栏那一行标题**变成这句话**（超长会截断）；答案正常返回 ✅ |
| 点组头 ＋ 新建会话 | 出现新的「新会话」并被选中（计数 2） ✅ |
| 点回有数据的那条会话 | 「新会话」**立刻从侧栏消失**，服务端 `/api/sessions` 只剩 1 条，磁盘上那条会话目录也被删掉 ✅ |
| 清理 | 删掉测试工作空间（连带它的会话），临时目录已删；`zustand` / `hooks` 两个真实工作空间一个字节没动 ✅ |

> 验证用的是**用户自己起着的那个 dev server**（PID 22820，端口 3000）。没有重启它、没有动它的数据根。

### 7.6 已知边界（本轮）

1. **在空会话里打了字但没发送就切走** ⇒ 那条会话会被删，**草稿丢失**。草稿本来就不落盘，但删会话让它更没有回头路。
2. **跨标签页**：A 标签刚建了会话、B 标签切走时不会删它（B 不知道它）；B 若恰好选着它并切走，服务端会以磁盘为准 —— 空就删。
3. **标题 30 字封顶**：更长的第一句话会截断带省略号；用户可随时手动改名。
4. **密度（C56 的另一半）没做**：会话行仍是三行字（47–69px），预览行也还在。这一轮只做"会话归属"，UI 密度按原计划留给下一轮。
5. **输入框的内容不跟会话走**（2026-11-17 用户定为**新功能**，不是 bug）：在 A 打了一半字切到 B，那段字会留在框里、按发送会用 B 的 sessionId 发出去。已入池 **C59**（`doc/plan/chat-surface-dsh-alignment.md` 四.12），"离开会话时清空输入框"**不做** —— C59 落地后输入框是"按会话派生的值"，这三处入口不需要再手动清。

## 八、状态点判定（第二轮，2026-11-17）：从「phase 投影」改成「未读结局」

> **这一节推翻 4.1 那一版状态点的判定方式**（渲染形态不变）。原因、依据、模型、判据、验收都记在这里。

### 8.1 第一版错在哪

第一版的判据是 `!current && phase !== "idle"` —— 一个**纯投影**：点的样子直接由 run 阶段算出来。

用户在真机上给的判据（2026-11-17 原话整理）：
1. 我在当前会话 ⇒ 当前会话**不展示**状态。
2. 只有当我切到别的会话、且之前那条**还在跑**时，才该点亮。
3. 切回一条**已经跑完**的会话 —— 成功或失败 —— 点就该**隐藏**；之后再切走，那个点也应该**彻底消失**。
4. 只有"运行中"这一种：切回来不展示，切出去**还要**展示进行中。

失败**只发生在结局态**（`done` / `error`）上 —— 因为 `lastOutcome` 是**存量**（`app/lib/run-fold/index.ts:111` 注释原话「上次 run 正常结束（绿点依据；**保持到下次 startRun**）」）：

| 场景 | 第一版 | 要求 |
|---|---|---|
| 我看着它跑完 → 切到 B | 亮蓝点 | 不亮（我已经看见了） |
| 后台跑完 → 切回 A（点灭）→ 再切到 B | **又亮蓝点** | 永不亮 |

⇒ 缺的东西是「**这个结局我看过没有**」。它不可能从 `phase` 里推导出来 —— 必须另存。

### 8.2 依据：两家参考项目是同一个模型（一手源码）

| | DSH（`E:\agents-read\deepseek-harness`） | pi-web（`E:\agents-read\pi-web`） |
|---|---|---|
| 数据 | 每会话一条记录 `{completedTurn, failed, readTurn, manualUnread}`（`packages/client/ui-session-status/src/index.ts:20-22`） | 一个 `Set<sessionId>`（`UNREAD_SESSIONS_STORAGE_KEY`，`components/SessionSidebar.tsx:311`） |
| 点亮 | Host 收到 `turn/end` 就记（`index.ts:47-50`），**不看你在不在看** | 上一刻在跑、此刻不在跑、且不是当前会话（`:1025-1049`） |
| 熄灭 | 把"读到第几轮"推到"跑到第几轮"（`:76-77`），之后 `completedTurn > readTurn` 永远为假 | 选中该会话即删（`:1076-1084`）；它又开始跑也删（`:1046`） |
| 判定 | `manualUnread \|\| (id !== viewing && completedTurn > readTurn)`（`src/client/status.ts:188-189`） | 集合里有没有这个 id |
| 红点 | `unread && failed`（`status.ts:194`）—— **只有未读时才是红** | 不区分成败 |
| 优先级 | 等确认（黄）> 在跑（转圈）> 未读（蓝/红）（`ui-workspace/.../rows/Rows.tsx:384-438`） | 等输入（黄）> 在跑（转圈）> 未读 > 时间（`components/SessionTree.tsx:583-610`） |
| 历史 | 不认领：README「Existing history starts read」；`index.ts:44-46` 注释「a `turn/end` replayed from a restored log reaches no listener」 | 不认领：初始集合为空 |

**一句话**：点 = 「**有一条你没看见的事**」。事有两种 —— **正在发生**（在跑 / 卡住等你）与 **你离开之后才有的结局**。前者的判据是"此刻的事实"，后者是"**跑到第几次** vs **你看到第几次**"。

### 8.3 模型（本项目的算术）

每条会话一条记录，**住浏览器内存，不进 `RunState`**：

```ts
type ReadingRecord = {
  endedSeq: number;   // 最近一次 run 收尾的序号（0 = 本页面里还没跑完过）
  failed: boolean;    // 那次 run 是不是失败
  readSeq: number;    // 你"看到"到第几次的结局（0 = 一次都没看过）
};
```

- **不进 `RunState` 的理由**：`RunState` 是**帧折叠出来的**（谁能跑出来、能重放）；"人看没看见"不是折叠的产物，它是产品状态。
- **序号**：`run-store` 里一个模块级自增计数器，`startRun` 起步时取一个（两个会话同时在跑也不会撞）。
- **刷新即归零**（只住内存）：`endedSeq` 只可能来自**本页面里真实跑过的 run**，刷新后它必然归零；只把"未读"单独持久化，会造出"这条会话根本没在跑、却挂着上次的点"的**半截状态**。要做持久化是两个数一起存、外加"跨刷新算不算逃过一眼"的决策 —— 另开一项。

### 8.4 判据（一个纯函数）

`app/lib/session-dot/index.ts`：

```ts
export function sessionDotFor(input: {
  phase: RunPhase;                     // 实时阶段（run-fold 的 deriveRunPhase）
  isCurrent: boolean;                  // 右栏显示的是不是它
  record: ReadingRecord | undefined;   // 没有记录 = 没跑完过
}): "none" | "running" | "waiting" | "done" | "error"
```

```
isCurrent                                    → none   ← 规则 1：当前会话永不点（比两家都严，见 8.8）
phase ∈ {waiting-approval, waiting-ask}      → waiting
phase === running                            → running
endedSeq > readSeq                           → failed ? error : done
否则                                          → none
```

- **`done` / `error` 这两个 phase 值不参与点**：它们只说明"上次结局是什么"，不说明"你看没看见"。结局一律走 `endedSeq > readSeq`。（`RunPhase` 不动，仍然给别处用。）
- **"看过"= 推进 `readSeq`**，不是"清标记"：一个动作同时满足规则 3（再切走也不亮）和规则 4（跑的时候切回来不点、切走又点）。

### 8.5 写 / 推进时机（只有四处）

| # | 在哪 | 干什么 | 为什么在这里 |
|---|---|---|---|
| 1 | `run-store.startRun` 起步 | `endingSeq = ++runCounter` | 一次 run 一个序号，同会话重跑也不会与上一轮相同 |
| 2 | `run-store.startRun` 的 `finally` | **无条件**写 `{endedSeq, failed}` | 这是 run 收尾的**唯一**出口（done / error / 用户停止 / 网络断 全走它，见 `app/lib/run-store.ts:150-159`） |
| 3 | 同上，`failed` 怎么算 | `failed = lastOutcome !== "done"` | 结局只有成败两种，**没有"不知道"**：流被掐断时 `lastOutcome` 仍是 `none` ⇒ 记失败（第一版这里是 `idle`，等于零信号） |
| 4 | `use-mark-session-read`（`page.tsx` 调用一次） | 当前会话若 `endedSeq > readSeq` ⇒ `readSeq = endedSeq` | 两条触发都要：**切到它** 与 **它在当前会话里跑完**（后者不是 id 变化，只靠"切会话"会漏） |

两个易踩的点：

- **不会闪**：`isCurrent → none`，所以推进之前那一刻当前会话本来就不显示点。
- **不会循环**：`markRead` 在没有推进空间时**原样返回 state**（引用不变 ⇒ 不重渲、effect 不再触发）。
- 我们**不需要** DSH 那道"正文真的收到那一轮才算已读"的校验（`src/client/acknowledge.ts:44-47`）：`endedSeq` 只可能来自本页面真实跑过的 run，那条 run 的 messages 就在同一个桶里 —— 切回去时内容一定在。（唯一会缺内容的是冷会话，而冷会话没有记录。）

### 8.6 文件级改动清单

| 文件 | 改动 |
|---|---|
| `app/lib/session-dot/index.ts` | **新增**：`ReadingRecord` / `EMPTY_READING` / `recordRunEnd` / `advanceRead` / `sessionDotFor` |
| `app/lib/session-dot/index.test.ts` | **新增**：8.7 的 16 行场景表 + 4 条记录算术 |
| `app/lib/run-store.ts` | state 加 `reading`；`markRead`；`startRun` 里序号 + `finally` 写记录；`deleteRun` 连记录一起删；投影 hook `useSessionReading` |
| `app/lib/use-mark-session-read.ts` | **新增**（平铺，无单测）：一个 effect，把"当前会话的已读位置"推上去 |
| `app/page.tsx` | 调 `useMarkSessionRead(currentId)`；顺带改掉「状态不写在这里 —— 会话行首那个点已经表达」这句已不成立的注释 |
| `app/components/session-list/session-row.tsx` | 取 `record` + `sessionDotFor`，按 `dot` 渲染；`phaseTitle` → `dotTitle`（文案见 8.7） |
| `app/components/session-list/session-list.module.css` | `data-phase` → `data-dot`（它不再是 `RunPhase` 了），两个 waiting 选择器并成一个；**尺寸/颜色/动画一个像素都不动** |

### 8.7 验收

**单测**（`app/lib/session-dot/index.test.ts`，每条用例名 = 真机上真会发生的场景）：

| # | 场景 | phase | current | ended/read | 期望 |
|---|---|---|---|---|---|
| 1 | 我在 A，A 在跑 | running | ✔ | 0/0 | none |
| 2 | A 跑着，我切到 B | running | ✘ | 0/0 | running |
| 3 | A 还在跑，切回 A | running | ✔ | 0/0 | none |
| 4 | 再切走（还在跑） | running | ✘ | 0/0 | running |
| 5 | A 后台跑完（成功） | done | ✘ | 1/0 | done |
| 6 | 切回 A | done | ✔ | 1/0 | none |
| 7 | **再切走** | done | ✘ | 1/1 | **none** |
| 8 | **我看着它跑完再切走** | done | ✘ | 1/1 | **none** |
| 9 | A 后台跑失败 | error | ✘ | 1/0 | error |
| 10 | **切回 A 再切走** | error | ✘ | 1/1 | **none** |
| 11 | A 后台等我批准 | waiting-approval | ✘ | 0/0 | waiting |
| 12 | 我看一眼没批就走 | waiting-approval | ✘ | 0/0 | waiting |
| 13 | 等批准 → 超时失败 | error | ✘ | 1/0 | error |
| 14 | 我在 A 点停止再切走 | done | ✘ | 1/1 | none |
| 15 | 后台断流（无 done/error 帧） | idle | ✘ | 1/0 | error |
| 16 | 序号往前滚过（看到第 1 次、第 2 次跑完） | done | ✘ | 2/1 | done |

记录算术：`recordRunEnd` 只改 `endedSeq`/`failed`、不动 `readSeq`；`advanceRead` 推到 `endedSeq` 且**幂等**（同一个记录调两次返回同一引用）。

**悬停文案**：running「正在执行」· waiting「等你确认」· done「跑完了，你还没看」· error「失败了，你还没看」。

**静态与回归**：`tsc --noEmit` 0 · `pnpm lint` 0 · 全量单测全绿（当前 828 条）。

**真机（浏览器，用你自己起着的 dev server）**：

| 步骤 | 期望 |
|---|---|
| 1 | 在 A 发一句 → **立刻**切到 B | A 出现转圈 |
| 2 | 等 A 的 run 结束 | A 的点变蓝（成功）或红（失败）—— **不是消失** |
| 3 | 切回 A | 点消失（当前会话永远不点） |
| 4 | 再切到 B | A **没有点**（彻底消失，规则 3） |
| 5 | 在 A 发一句、**留在 A** 看它跑完，再切到 B | A 没有点（规则 3 的另一半） |
| 6 | 重发一条，让它在 A 里失败（断网 / 故意出错），留在 A 看完，再切走 | A 没有红点 |

> 第 6 步顺带验 8.5 的第 3 条：**没收到 done 帧要记成失败**。造这个失败**不能靠断网**（见下面的实测事实），要用可控的请求失败 —— 具体做法见 8.7.1 的补验表。

#### 8.7.1 真机实测（2026-11-17，dev server `localhost:3000`，网络这一轮恢复了）

用一段 2000 字散文（生成够久）在测试会话 A 里跑，**0.6s 后切走**，然后每 500ms 采一次那一行的点：

| 时刻 | `data-dot` | 可见证据 |
|---|---|---|
| t=1.1s → 15.2s | `running` | `animation: dot-spin`、宽 **10px** 的环、背景透明 |
| t=15.7s | `done` | 背景 **`rgb(47, 75, 153)`**（=`--pen-user`）、宽 6px、`title="跑完了，你还没看"` |

| 步骤 | 实测 |
|---|---|
| ① 发一句，立刻切走 | 后台那一行**转圈**（上面两行）✅ |
| ② 等它结束 | 变成**蓝点**，**不是消失** ✅ |
| ③ 切回 A | 无点（当前会话）✅ |
| ④ 再切走（2s 后复查） | **无点** —— 规则 3 ✅ |
| ⑤ 在 A 里看着它跑完（发「3×7」，13s 采样）→ 切走 | 13s 里**全程没点**；切走后仍然没点 ✅（**第一版的 bug 正在这里**：会亮蓝点）|
| ⑥ 删掉测试会话（⋯ → 删除 → 行内确认） | 侧栏与 `/api/sessions` 都回到用户的 2 条；`deleteRun` 连阅读记录一起删，无异常 ✅ |

**黄点与红点也补验了**（用户追问「浏览器验收了吗」之后补的两条）：

| 场景 | 怎么造出来的 | 实测 |
|---|---|---|
| **黄点**（等确认） | 让它调 `bash`（审批模式=建议 ⇒ bash 必弹）。真出现审批卡（`Y允许` / `N拒绝`）后**切走** | `data-dot="waiting"`、`title="等你确认"`、**`rgb(176, 116, 27)`**（=`--pen-signal`）、6px；后台稳定 3.2s+ ✅ |
| **红点**（失败结局） | 用 Playwright 路由把 `POST /api/chat` **拖 6 秒后 abort**（控制台就一条 `net::ERR_FAILED @ /api/chat`，等价于服务端 5xx / 连接被掐）→ 发一句 → **立刻切走** | t=1.2–5.8s `running`（转圈）→ **t=6.3s `error`**、`title="失败了，你还没看"`、**`rgb(163, 45, 31)`**（=`--pen-error`）、6px ✅；切回 → 灭；再切走 → 不复亮 ✅ |

⇒ 8.5 第 3 条（**"没收到 done 帧就记失败"**）在真机上成立了：那一次 run 根本没拿到 `done` 帧，红点亮起来了。第一版这里会停在 `idle`、什么都不亮。

**顺手记一条实测事实（以后别再想当然）**：用 `context.setOffline(true)` 掐网**不会**让本地 SSE 报错 —— 流只是**停住**，`running` 一直挂着；网络恢复后 done 帧照常到达、点变蓝。所以"断流 → 失败"的触发条件是**请求真的失败 / 连接被重置**（`fetch` reject 或 reader 抛错），不是"网卡没了"。验证这一条必须制造真实的失败，不能靠断网。

**四态样式探针**（按属性名建临时节点读 computed style，验的是改名后选择器还对得上）：

| `data-dot` | 背景 | 宽 | 动画 |
|---|---|---|---|
| `running` | 透明（环） | 10px | `dot-spin 0.9s` |
| `waiting` | `rgb(176, 116, 27)` = `--pen-signal` | 6px | 无 |
| `done` | `rgb(47, 75, 153)` = `--pen-user` | 6px | 无 |
| `error` | `rgb(163, 45, 31)` = `--pen-error` | 6px | 无 |

## 八·补：高亮与点距（2026-11-17 用户看真机后提的两条）

**用户原话**：① 状态点和会话标题没有间隔 ② 高亮状态下的会话应该是整行都高亮，现在是加了内边距和边框，应该从左到右整行都高亮、不需要边框。

**病根（量出来的，不是猜的）**：

| 症状 | 原因 |
|---|---|
| 点和标题贴着 | 点是 `position: absolute; left: 8px`（宽 6px ⇒ 占 8–14），而行 `padding-left: 14px` ⇒ 标题正好从 14 开始，**间隔 = 0** |
| 高亮像一块带边的小卡片 | 三层叠加：`.sessionList` 左右各 6px 内边距 + `workspace-group > .body` 左缩进 12px ⇒ 色的左沿在侧栏 18px 处；行自己还有 `border: 1px solid transparent` + `border-radius` ⇒ 看着是"药丸" |

**继承 / 改动**（§11.8 那两栏；原型 `workspace/prototype-workspace.html` 是基准）：

| | 内容 |
|---|---|
| **继承** | 单行 34px、左侧"点 + 标题 + 时间靠右"的排布、四态配色与转圈动画、行缩进（会话挂在组名下）、hover 用 `--feed-hover`、当前项用 `--plate` |
| **改动** | ① 高亮的**画法**：原型 `.row.on` 是"面 + `--line` 细环 + 圆角"，而原型**没有**会缩进 12px 的组容器 ⇒ 照抄到我们这个结构上就变成"内缩的小卡片"。用户要的是**色带贴边**，所以在 `.sessionItem` 上加 `margin-left: -12px` 吃掉组缩进、把 `.sessionList` 的左右 6px 也去掉，并删掉 `border` / `border-radius`。② 点的水平位置从 8px 挪到 **18px**，标题的 `padding-left` 从 14px 改成 **32px** ⇒ 留出 8px 间隔。③ 顺带的后果：hover 也变成满宽（不这样的话，悬停是窄块、当前是满宽，同一条列表里两种宽度会显得错位）。 |

**实测（浏览器，`localhost:3000`）**：

| 判据 | 实测 |
|---|---|
| 当前行背景跨度 | 左沿 **0px**、右沿 **0px**（侧栏 263px，行 263px）✅ |
| 边框 / 圆角 | `border-width: 0px`、`border-radius: 0px` ✅ |
| 状态点位置（6px 的结局点） | 18 → 24 ✅ |
| 点与标题的间隔 | 标题左沿 32 ⇒ **8px** ✅（转圈态：环 16–26，间隔 6px） |
| 有 / 无状态点的标题对齐 | 两者标题左沿都是 **32** ✅（点是绝对定位，不参与排布） |
| 行高 | 34px（没变）✅ |
| 横向溢出 | 1440 / 1440 ✅ |

### 8.8 不做的（都拍了，写在前面免得被当遗漏）

1. **失焦 / 切到后台 → 当前会话的未读重新出现**（DSH 有：`status.ts:178` 的 `viewing` 要求 `visible && hasFocus`；pi-web 没有）。**不做**：我们的"当前"就是"右栏显示的是哪条"，加了焦点判断会让"只是切窗口回个消息"变成满屏点。
2. **持久化 / 跨标签页同步**：见 8.3，只住内存。
3. **手动「标记为未读」**（两家都有，DSH 还带快捷键 `Shift+Cmd+U` / `Ctrl+Shift+U`）：**没做**，要的话按流程入池再开一项。
4. **组头计数 / 页签徽标**（pi-web 把未读数画在组头和 favicon 上）：与 C56「删掉一切计数」的拍板冲突，不做。
5. **当前会话连"在跑"也不点**（规则 1 比两家都严 —— 两家都会为在跑的当前会话点）：**保持严的这一版**，因为当前会话的运行状态在右栏有别的表达（停止按钮 / 输入台禁用）。
