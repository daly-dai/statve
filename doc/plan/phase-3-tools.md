# doc/plan/phase-3 —— Phase 3 文件增删改查（施工补记）

> 来源：PLAN.md 第六章 Phase 3 段（2026-08-26 PLAN 拆解时移入 doc/plan/）。**✅ 已实现并提交**，保留作施工历史。

## 目标

- 扩展 `ToolRegistry`：`read_file`（已有）、`write_file`（任意路径）、`edit_file`（旧串→新串替换）、`delete_file`、`grep`、`find`、`list_files`（已有）。
- 保留并强化路径沙箱（`resolveInsideWorkspace`）。
- 对应 pi：`packages/agent/src/harness/tools/{read,write,edit,edit-diff,path-utils}.ts` + `packages/coding-agent/src/core/tools/{find,grep,ls}.ts`。

## 实现前补记（AGENTS.md：先想清楚再动手）

- 新工具清单（参数见 `lib/tools/` 各工具文件）：`write_file`（任意路径 + 自动建父目录）、`edit_file`（唯一 oldText→newText 替换：找不到/多处都报错回给模型）、`delete_file`、`grep`（正则搜内容，无效正则转 isError）、`find`（文件名 `*` 通配）。全部复用 `resolveInsideWorkspace`。
- **write_note 保留并存**（已确认）：它是「只写 notes/」的低危特例，`write_file` 是通用入口——同一种能力两种危险等级，审批策略不同（教学点）。
- **edit_file 形态**（已确认）：形态 A 最简版「唯一 oldText→newText 替换」。模糊匹配（智能引号/破折号归一化，pi 的做法）和 diff 式编辑都留作扩展。
- **审批策略**（已确认）：读类（list/read/find/grep）默认放行；写类（write_note/write_file）放行但拦截「secret/秘密」文件名；**delete_file 默认 block**（演示审批机制），`ALLOW_FILE_DELETE=true` 环境变量可放行——「策略配置」的教学样例。
- **grep 细节**（已确认）：JS 正则；默认最多 50 条匹配，超出提示「共 N 条，显示前 M」；每行截断 200 字符；读文件失败（二进制等）跳过不崩。
- 暂缓：edit 模糊匹配、diff 式编辑、符号链接逃逸防护、二进制识别、并发写锁、前端删除确认弹窗（等 Phase 5/6 的交互通道）。
- **人工确认（已确认：全部写操作弹框 + 60s 超时自动拒绝）**：`write_note`/`write_file`/`edit_file`/`delete_file` 每次调用都弹框让用户当场允许/拒绝，不再依赖硬编码策略。实现：`beforeToolCall` 是 async 钩子——识别写/改/删 → SSE 推新帧 `tool_permission_request`（toolCallId/工具名/参数）→ await 挂起的 Promise（`lib/toolApproval.ts` 的 pending 注册表，globalThis 挂载防 dev 多 worker 不共享）→ 前端弹框 → `POST /api/chat/approve` 回传决定 → resolve 放行/拦截。60 秒不点自动拒绝（block 结果回给模型解释）。硬性安全策略（secret/秘密 文件名）仍不弹框直接拦。**`ALLOW_FILE_DELETE` 开关被弹框机制取代，移除**。会话/全局「记住选择」留待以后。
- 测试：Phase 6 补框架；`tools.ts` 是全项目最适合先补单测的模块（纯函数 + node:fs），届时从这里开始。

---

## 2026-11-18 追加 · `read_file` 支持按行区间读（C60）

### 一、触发：真机撞出来的，不是想出来的

用户当天那句是「**我读取自己工作空间的内容为什么还要审批**」。查轨迹
（`~/.statve/sessions/--E-codeRead-zustand--/s_2026-11-18T02-32-13-944Z_35h8mu/trace.run_2026-11-18T02-32-34-914Z_k4av02.jsonl`），
那一个会话 13 次工具调用：

| 工具 | 次数 | 弹框吗 |
|---|---|---|
| `list_files` | 1 | 不弹 |
| `read_file` | 4 | 不弹 |
| `bash` | 6 | **每一次都弹** |
| `web_fetch` | 1 | 不弹 |

**6 条 bash 全是只读命令**，而且是四类 read_file 干不动的活：

```powershell
Get-Content src/vanilla.ts | Select-Object -Skip 85   # 要从第 86 行往后读（没有 offset）
Get-Content $_.FullName | Measure-Object -Line        # 统计每个文件多少行
"=== combine.ts"; Get-Content src/middleware/combine.ts   # 一次读好几个文件
Select-String -Path tests/vanilla ...                 # 关键词搜索
```

量那个被读的文件的真实形状：`zustand/src/vanilla.ts` = **185 行 / 5,799 字符**，
而 `truncate(content, 1800)` 只给前 **61 行（33%）**，尾巴上只有一句
`... [截断 3999 字符]` —— **不说总共多少行，也不说从哪接着读**。
模型于是只能去调 `bash`，而 `bash` 在 `TOOLS_NEEDING_CONFIRM` 里（`app/api/chat/_pipeline/approval/index.ts:40`，刻意的：不做静态分析）。

⇒ **审批弹框不是审批策略的问题，是「读」这个动作被逼进了需要审批的那条路。**

### 二、复盘：这个缺陷是怎么活下来的

三处证据，指向同一个形态：

1. **池子里从来没有它的一行** —— `PLAN.md` 的 Phase 3 段只写「`read_file`（**已有**）」（就是本文开头「目标」那句），一个「已有」把设计和评审都跳过了。
2. **`1800` 在任何文档里都搜不到** —— `git grep -n "1800" -- doc PLAN.md` **零命中**。它是魔数（magic number，指没有出处、也解释不了为什么是这个值的具体数字）。
3. **单测把它固化成了规格** —— `lib/tools/read/index.test.ts:42` 那条用例的名字就叫「超过 1800 字符截断并提示」。测试守住了实现，却没守住要求。

**判据（写给以后）**：需求没写下来时，单测守的是「代码现在怎样」，不是「它该怎样」。所以
**「已有」是审查盲区** —— 新功能有详案、有验收、有真机单；继承来的工具三样都没有，于是它可以让一个只给 33% 的读工具活三个月。

### 三、一手依据（pi，主参考，commit `890f920`）

pi 的读工具是 `packages/coding-agent/src/core/tools/read.ts`（**16,508 字节**）
+ 专门的 `truncate.ts`（**8,750 字节**）；我们是 `lib/tools/read/index.ts`（**1,562 字节**）。

| 能力 | pi 怎么做 | 出处 |
|---|---|---|
| 参数 | `path` + `offset`（**1 数起**的起始行）+ `limit`（最多几行） | `read.ts:14-18` |
| 上限 | **2000 行 / 50KB，先到先停** | `truncate.ts:1-2`（`DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`） |
| 续读提示 | `[Showing lines 1-2000 of 5799. Use offset=2001 to continue.]`；若因字节超限，括号里补 `(50KB limit)`；若用户给 `limit` 截断而文件还有，换成 `[N more lines in file. Use offset=X to continue.]` | `read.ts:328-338` |
| 越界 | `Offset 9999 is beyond end of file (185 lines total)` | `read.ts:312` |
| 单行超字节 | 不给内容，直接给兜底写法（`sed -n '…p' 文件 \| head -c …`） | `read.ts:318-322` |
| 工具指导语 | `Use read to examine files instead of cat or sed.` | `read.ts:22` |
| 超大文件 | 用 `createReadStream` 分块选行，只存能显示的那几行 | `read.ts:61`、`139-226` |
| 图片 | 描述里写明支持 jpg/png/gif/webp/bmp，当附件发 | `read.ts:239` |
| **行号** | **不加**（全文无 `padStart` / 行号拼装，2026-11-18 核对） | — |

### 四、详细设计（定案）

**已拍板**（用户 2026-11-18）：范围 = `offset`/`limit` + 续读提示 + 越界报错；上限**全抄** pi 的 2000 行 / 50KB。

**① 参数** —— 三个，仍是「一个对象参数」（`execute(args)`），不触发 `max-params` 的化简：

```ts
properties: {
  path:   { type: "string", description: "文件路径：工作空间内用相对路径；需要工作空间外时用绝对路径（会走一次人工确认）。" },
  offset: { type: "number", description: "从第几行开始读（1 数起）。默认 1。" },
  limit:  { type: "number", description: "最多读几行。默认读到上限（2000 行 / 50KB）。" },
}
```

**② 上限**：`MAX_LINES = 2000`、`MAX_BYTES = 50 * 1024`，先到先停。50KB ≈ 12–13k tokens（token ≈ 模型的最小文本单位，英文/代码大致 4 字符 1 个；中文更费）。抄这个数**不是因为它神圣**，而是它已经在参考项目里跑过、且量级上对得上：一次少走一段路，又不会一口气把上下文吃光。

**③ 不加行号（明确决定）**：`edit_file` 是「唯一 oldText→newText」，用不着行号；而行号一旦进了模型看到的正文，它回填 oldText 时**会把行号一起带上**，匹配必然失败。pi 也没加。`grep` 回 `路径:行号:匹配行` 是另一回事 —— 那是搜索结果，不是文件内容。

**④ 截断提示（照 pi 的三句）**：
- 因行数或字节超限 → 正文后接 `\n\n[Showing lines A-B of N. Use offset=C to continue.]`（因字节时 `A-B` 后补 `(50KB limit)`）
- 用户给了 `limit` 被截断、文件还有 → `\n\n[N more lines in file. Use offset=C to continue.]`
- 读完了 → **什么都不加**

**⑤ 越界报错**：`offset` 大于总行数 → 抛 `Offset ${offset} is beyond end of file (${N} lines total)`；`offset < 1` 或非整数 → 收敛成 1（照 pi 的 `Math.max(0, offset - 1)`），不另造错误分支。

**⑥ 8MB 护栏（我们加的一条，pi 不需要）**：先 `stat`，`size > 8 * 1024 * 1024` → 抛错「文件 N MB，超过 `read_file` 的 8MB 上限；请用 `bash` 分块读取（`Get-Content -TotalCount` / `-Skip`）」。理由：我们是**一次 `readFile` 进内存**，一个 1GB 的单行文件会把 Node 打爆；pi 为此写了 90 行流式选行（`read.ts:139-226`），这一层我们**不做**（见 ⑨）。

**⑦ bash 的指导语补一句（同一功能的两半，缺一半就退回原点）**：在 `lib/tools/bash/index.ts` 的 `guidelines` 里加 ——
> 读文件用 `read_file`，不要用 `Get-Content` / `cat` / `sed`：它支持按行区间读，而且不弹审批（`bash` 每次都请你点允许）。

这是 pi `read.ts:22` 那句的原意。按 C34 的判据它该住在 **bash 自己的文件**里：它回答的是「用哪个工具」，不是 `read_file` 的形状。

**⑧ 单测跟着改（不是「顺带修绿」）**：`index.test.ts` 里那条「超过 1800 字符截断并提示」**必须删掉**换成新规格 —— 它就是这个缺陷被固化的地方。

**⑨ 明确不做**：图片读取（`C12` 的 `read_image` 一行）、流式分块选行（pi 的 `139-226`，等真有大文件需求再说）、二进制识别、行号。

### 五、验收（4 + 1 条，都能一次跑出来）

1. **185 行 / 5.8KB** 的文件（`vanilla.ts` 的真实形状）：一次读完，输出里**不出现** `[Showing lines`
2. `offset=86`：从第 86 行开始；读到文件尾 ⇒ 末尾**不加**提示
3. **2,500 行**文件：给 2,000 行 + `[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]`
4. `offset=9999`（对 185 行文件）：报错含 `beyond end of file (185 lines total)`
5. 文件 > 8MB：报错含 `8MB`，且**不**抛内存错

**回归（真机，这条才是判据的本体）**：同一句「我如果想学习这个源码该从哪里入手」再跑一遍，`bash` 调用数应明显低于现在的 6 次 —— 反弹框的次数就是这条验收的读数。

### 六、⚠️ 还缺什么才能开工

**技术上不缺**（三格齐：依据 = §三 的 pi 一手行号；设计 = §四；验收 = §五）。

**流程上缺一步**：它还没进迭代。用户 2026-11-18 定「**先入池并补详案**」，所以现在停在这里 —— 池子那一行状态是 `未开始`，代码一行没动。

### 七、2026-11-19 实施记录（C60 落地）

**commit `1af3433`**（分支 `feat/c60-read-file-range`，合回 `main` 时是 no-ff 合并提交）。落点：
`lib/tools/read/window/index.ts`（新，纯逻辑）+ `lib/tools/read/index.ts`（改写）+ 两份 `index.test.ts`
+ `lib/tools/bash/index.ts` 的 `guidelines` 加第四条。

**三处刻意不照抄 pi**（每处都有原因，不是记不住）：

| 处 | pi 怎么做 | 我们怎么做 | 为什么 |
|---|---|---|---|
| 行数 | 两套：切片按 `\n` 切（末尾带换行的文件得 186），计数又去掉末尾空行（185） | 一个 `splitLines` 出两种数 | pi 那两个数可能对不上（`A-B` 用的是切片的、`of N` 用的是计数的）；同源就不会对不上 |
| 提示措辞 | `(50.0KB limit)`（`formatSize` 给一位小数） | `(50KB limit)` | 与本文 §四④ 的措辞一致 |
| 单行超限兜底 | `sed -n 'Np' 文件 \| head -c …` | `Get-Content '<路径>' -TotalCount N \| Select-Object -Last 1 \| ForEach-Object { $_.Substring(0,2000) }` | 我们的 `bash` 跑的是 PowerShell，`sed` 那条命令**必然失败** |

**补了两个 pi 没写、但省略会出问题的边界**：① `offset` 非整数 / 小于 1 → 收敛成 1（不另造错误分支）② 空文件 → 空正文、不报错（0 行的文件问第 1 行不是错误）。

**真机读数（2026-11-19 11:38，同一工作空间 `E:\codeRead\zustand`）**：

| | 11-18（改前） | 11-19（改后） |
|---|---|---|
| `bash` 调用（每次都弹框） | **6** | **0** |
| `read_file` 调用 | 4 | **14**（每文件一次） |
| `vanilla.ts`（185 行） | 只给前 61 行（33%） | `startLine:1 / endLine:185 / totalLines:185`（整份） |

`limit` 被真的用过一次：`src/middleware/persist.ts`（402 行）那次是 `{"limit":120}`，拿到 `[281 more lines in file. Use offset=121 to continue.]` 后没续读 —— 那个任务是扫一遍找亮点，够了。**`offset` 一次没用**（如实记录：本任务不需要钻深，不是提示没生效）。

**一个不该误读的观察**：轨迹里 5 条一模一样的续读提示不是读了 5 次，是 `message_update` 每次把累积消息整份重存 —— 这正是池子 **C21**（轨迹瘦身）要治的毛病。

**验收对号（§五 五条 + 真机回归）**：①②③④⑤ 见 `lib/tools/read/index.test.ts` 的 10 条与 `window/index.test.ts` 的 12 条；真机回归如上表。
