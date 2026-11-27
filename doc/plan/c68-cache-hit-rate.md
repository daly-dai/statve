# C68 · 缓存命中量可见

> **需求池那一行在 `PLAN.md`；本文件不写状态。**
> 2026-11-24 建。**这是"前置分析 + 实施方案"，不是实施记录**（还没动代码）。

## 一、需求（池子行原文）

**缓存命中量可见**：把 provider 返回的缓存命中 / 未命中 token 解析进统一 `Usage` 并显示出来（DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，以及 OpenAI 风格的 `prompt_tokens_details.cached_tokens`）

## 二、依据

### 2.1 我们现在的代码（一手）

| 位置 | 现在是什么 |
|---|---|
| `lib/types.ts:118-122` | `Usage = { input, output, totalTokens }` —— **只有三个数，没有缓存概念** |
| `lib/deepseekModel/index.ts:434-445` | `toUsage(u)`：`prompt_tokens → input`、`completion_tokens → output`、`total_tokens → totalTokens` |
| `lib/deepseekModel/index.ts:330-333` | 流式：`chunk.usage` 一出现就 `acc.usage = toUsage(chunk.usage)` |
| `lib/deepseekModel/index.ts:593-597` | 非流式：**另写了一遍**同样的三行映射（与 `toUsage` 重复） |
| `lib/deepseekModel/index.ts:793` / `:816` | `data.usage` 与流 chunk `usage` 的**类型也各写了一遍**，都只有三个字段 |
| `app/lib/trace-steps/index.ts:266` | 消费方之一：`state.model.tokens = event.message.usage.totalTokens` |
| `app/lib/trace-fold.ts:128` | 消费方之二：轨迹行标注 `${message.usage.totalTokens} tok` |

⇒ **响应里本来就有的命中数，我们一个字节都没读。** 现在讨论"改系统提示词会不会废掉前缀缓存、代价是不是 10×"，**全是纸面推论**。

### 2.2 provider 到底给了什么

| 家 | 字段 | 说明 |
|---|---|---|
| **DeepSeek**（我们在用） | `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | **自动**磁盘缓存；命中价约未命中价的 **1/10**（$0.014 vs $0.14 / 百万 token）；**64 token 起**才缓存；**只有从第 0 个 token 起完全相同才算命中**，中间差一个字符后面全废；TTL **几小时到几天**；存储免费、按用户隔离 |
| OpenAI 风格（Kimi / 智谱 / MiniMax 等） | `usage.prompt_tokens_details.cached_tokens` | 只给"命中多少"，未命中 = `prompt_tokens − cached_tokens` |

来源：[DeepSeek 官方公告](https://api-docs.deepseek.com/news/news0802.md) · [Kimi 定价与缓存](https://platform.kimi.ai/docs/pricing/chat) · [智谱上下文缓存](https://docs.bigmodel.cn/cn/guide/capabilities/cache) · [火山方舟缓存](https://docs.volcengine.com/docs/ark/context-cache?lang=zh) · [MiniMax prompt caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching) · [Qwen 显式缓存](https://www.alibabacloud.com/help/en/model-studio/explicit-cache-qwen4)

**顺带一条对判断很有用的事实**：国产 9 家主流里 8 家支持上下文缓存，且**绝大多数是自动的**（不用改代码）。所以"有没有缓存"不是风险；**"前缀稳不稳"才是**。

### 2.3 这个指标到底用来干什么

它不只是一个省钱数字，它是一个**"前缀稳定性"的体检指标**：

- 前缀缓存按「从第 0 个 token 起连续相同」计。**改系统提示词 = 整段会话（系统 + tools + 全部历史）按全价重算 ≈ 一次 10× 的输入成本。**
- 所以只要盯 `cachedInput / input` 这个比例：
  - 长期 **> 90%** ⇒ 前缀稳定，正常（DeepSeek 官方说即使不做优化，历史数据平均也能省 50%+）
  - 突然掉到低位 ⇒ **有东西在每轮改变前缀**，去查是谁（日期？技能清单？工具规矩？）
- 这正是 2026-09-14 那个 bug 的形状：`timeStyle:"short"` 让系统提示词**每分钟变一次** ⇒ 前缀缓存一次都命中不了，而当时**没有任何数字能发现它**，靠读代码才找到。

## 三、详细设计

### 3.1 数据字段（内核）

`lib/types.ts` 的 `Usage` 增一个**可选**字段：

```ts
export type Usage = {
  input: number;
  output: number;
  totalTokens: number;
  /**
   * 输入里有多少 token 命中了 provider 的前缀缓存。
   * **缺席 = "这家 provider 没报"**，不等于 0 命中 —— 所以是 `?`，且宁可不写也不写 0。
   */
  cachedInput?: number;
};
```

**为什么叫 `cachedInput` 而不是 `cacheHitTokens`**：`Usage` 在 `lib/`（内核），字段名不许带 provider 概念。`cachedInput` 读作"输入中被缓存的那部分"，DeepSeek 和 OpenAI 两种形状都能映射进来。

**为什么不另存 miss**：`miss = input − cachedInput`，存两个数会让它们可能互相矛盾（两个事实源）。

### 3.2 解析：两处 → 一处

现在流式和非流式各写一遍映射（`:332` 与 `:593-597`），类型也各写一遍（`:793` / `:816`）。这次**顺手收成一个**：

```ts
/** 两种 provider 形状的并集：DeepSeek 分开报，OpenAI 风格挂在 details 里 */
type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

function cachedInputOf(u: OpenAiUsage): number | undefined {
  return u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
}

function toUsage(u: OpenAiUsage): Usage {
  const cached = cachedInputOf(u);
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
    ...(cached !== undefined ? { cachedInput: cached } : {}),   // ← 没有就不写
  };
}
```

非流式的 `:593-597` 改成 `toUsage(data.usage ?? {})`。

⚠️ **`...(cached !== undefined ? … : {})` 这个写法是硬要求**，不是风格：`lib/deepseekModel/index.test.ts:368` 用 `toEqual({input:10,output:5,totalTokens:15})` 断言 —— 无条件写 `cachedInput: 0` 会让那条测试变红，而且**语义上也错**（"不知道"被写成"零命中"）。

### 3.3 落盘：**不用写任何代码**

`message_end` 事件携带的是**整条 `AssistantMessage`**，`usage` 在里面。所以：

- 会话 JSONL 的 assistant 条目 → 自动带上 `cachedInput`
- 轨迹 `trace.<runId>.jsonl` 的 `message_end` → 自动带上 `cachedInput`

⇒ `app/lib/trace*` **一行都不用改**。这是"选对了数据形状"省下来的工作。

### 3.4 界面显示：做（2026-11-24 用户改判）

原来这一节写的是「一期只到数据层，显示归 C5」。用户随后定：**显示也做** —— 原话「先做C68 显示也做 然后我们在做注入就有了更直接的数据依据了」。

⇒ 这一项从"数据层铺垫"升级成**一个有界面的功能**，必须走 `AGENTS.md` 11.8 那道门。

**demo 演进**（都在 `workspace/`，都是过期即弃的工地）：

| 文件 | 用途 |
|---|---|
| `prototype-c68-cache-hit.html` | 第一版：三个候选位置并排（A 回合尾 / B 圆环面板 / C 轨迹逐笔） |
| `prototype-c68-cache-panel-v2.html` | 第二版：圆环旁**常驻百分比**的两种放法 + ≥75% 警示态 + 停止态三种处理 |
| **`prototype-c68-cache-panel-v3.html`** | **最终形态**（2026-11-27 用户确认「可以」）：累计口径四行 + 两种停止态 + 常驻读数 |

**用户 2026-11-25 拍板：只做 B**（圆环面板）。A / C 不做：

- **A（回合尾）** —— 它会给每一轮加一段读数，日常不需要；
- **C（轨迹逐笔）** —— 跟 A 信息重复，且跟 A 同样是"每轮都看"的东西。

B 的判据：**默认不打扰，点开才看**；而圆环本来就是"token 账本"，命中率是账本的另一半。

### 3.4.1 ⚠️ 口径改判：取最后一笔 → **累计**（2026-11-27）

第一版实现是「**取最后一条 assistant 的 usage**」，理由是"一轮里最后一笔的 input 已经把前面都算进去了 ≈ 这一轮的总账"。

**这个理由是错的。** 用真实会话量出来（`s_…11-20T02-37-39-013Z` 第一次提问）：

| | 最后一笔 | 13 笔累加 |
|---|---|---|
| input | 25,238 | **201,343** |
| output | 964 | 6,727 |

**差 8 倍。** 原因：一轮里模型被调用 13 次（思考→调工具→再思考），每一笔都**重新读了一遍完整历史**。最后一笔只代表"最后一次请求有多长"，代表不了"这一轮花了多少"。

⇒ 最终口径改为**累计**（从最后一条 `user` 消息起），理由与四条细则见 `app/lib/cache-stats/index.ts` 文件头。

### 3.4.2 停止态：不是"没有用量"，而是"最后一笔未计入"

用户在 11-26/27 连问两次，把这件事问清楚了。真实数据（`s_…11-18T08-36-34` 第 1 轮，第 16 行）：

```
assistant  input=7,326  output=271  stop=toolUse
  └ toolResult
assistant  input=0      output=0    stop=aborted    ← 只有这一笔是 0
```

三条事实：

1. usage 只在**流的最后一个 chunk** 回报（`stream_options.include_usage`）⇒ 中止 = 那个 chunk 永远不来；
2. 中止那条消息的 `usage` 是**全 0 的占位**，不是"没花钱"（输入可能已经 prefill 过）；
3. 但**同一轮前面完成的每一笔、以及之前所有轮次，都完整落盘**（`lib/agent/index.ts:243-254` 的"安全停下并交出完整档案" + `_pipeline/index.ts:176-178` 批量落盘）。

⇒ 面板分三态：**正常** / **已停止但有钱**（前几笔之和 + 小字「已停止 · 最后一笔未计入」）/ **已停止且一笔都没完成**（「已停止 · 本轮无数据」）。

**顺带修掉一个真 bug**：中止分支原来写死 `usage: EMPTY_USAGE`，把 `acc.usage`（如果 usage chunk 恰好先到了）扔了 —— 改成 `acc.usage ?? EMPTY_USAGE`。

### 3.5 风险

| 风险 | 处理 |
|---|---|
| 老测试被 `toEqual` 卡住 | 3.2 的"没有就不写"已经处理；改完跑全量 |
| 有的网关会在 `usage` 里塞**别的**缓存字段名 | 一期只认这两种（DeepSeek + OpenAI 风格）；不认识就当没报，**不猜** |
| `cachedInput > input`（provider 自己报错） | 不校验、不修正，**原样落盘** —— 数据层不该悄悄改 provider 的话。验收里加一条"看到这种数据要能认出来" |

## 四、验收（怎么算做完）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | **三种响应形态都映射对**：DeepSeek（`prompt_cache_hit_tokens`）/ OpenAI 风格（`prompt_tokens_details.cached_tokens`）/ 都没有 | 单测三条，直接喂 `toUsage` |
| 2 | **没有就不写字段**（不是写 0） | 单测：`expect("cachedInput" in usage).toBe(false)` |
| 3 | **现有三字段一字不动** | 老测试全绿（`lib/deepseekModel` 整包 + `lib` 全量） |
| 4 | 非流式与流式**走同一个映射** | 代码上只剩一个 `toUsage`；两处调用 |
| 5 | ⭐ **真机**：同一个会话第二轮请求的 `cachedInput` ≈ 第一轮的 `input + output`（这是**上限**，实际只会少不会多） | DeepSeek 官方场景 1「下一轮能命中上一轮的上下文缓存」。发两条消息，看会话 JSONL。⚠️ **第一轮本身可能不是 0**：缓存按**前缀**索引（同一用户内）、**不按会话**，所以同一天跑过的提示词会被命中 —— 判据是"第二轮 ≳ 第一轮之和"，**不是**"第一轮必须 0" |
| 6 | `tsc --noEmit` / `pnpm lint` / 全量单测 | 常规三件套 |

第 5 条是**唯一能证伪"我们以为缓存命中"的判据** —— 前四条都只证明"解析写得对"，只有它证明"数字是真的"。

## 五、已拍板

1. **字段名 `cachedInput`**（2026-11-25）—— 已落进 `lib/types.ts`（可选字段，缺席 = provider 没报）
2. **显示位置：只做 B**（圆环面板）—— A / C 不做，理由见 3.4
3. ~~取哪条 usage：最后一条 assistant~~ → **改判为「累计」**（2026-11-27），理由见 3.4.1
4. **停在界面上的两种说法**（2026-11-27）—— 见 3.4.2：不是"无用量"，是"最后一笔未计入"

## 六、实施记录（2026-11-27 定稿）

分支 `feat/c68-cache-hit-rate`（从 `main` 拉）。

| 文件 | 改了什么 |
|---|---|
| `lib/types.ts` | `Usage` 加可选 `cachedInput` + 一段"缺席 ≠ 0"的理由 |
| `lib/deepseekModel/index.ts` | ① 新增 `OpenAiUsage`（两种形状的并集）、`cachedInputOf`、`toUsage` 归一；非流式改用 `toUsage`（原来手抄了一遍）；两处 raw 类型收成一处 ② **中止分支改成 `acc.usage ?? EMPTY_USAGE`**（原来写死 EMPTY_USAGE，会把已到的 usage 扔掉） |
| `lib/deepseekModel/index.test.ts` | +4 条：DeepSeek 形状 / OpenAI 形状 / 都没报 ⇒ 键不存在 / 非流式同一条路 |
| `app/lib/cache-stats/index.ts` | **新增纯函数**：`cacheStatsOf(messages)` → 三态（measured / stopped / unknown）；四条口径写在文件头 |
| `app/lib/cache-stats/index.test.ts` | **10 条**：只算这一轮 / 累加不取最后一笔 / 加权命中率 / 中止跳过 + partial / 0 笔完成 ⇒ stopped / 缺数 ⇒ unknown / input=0 不出 NaN / >100% 不夹 |
| `app/lib/use-agent-run.ts` | 派生 `cacheStats`（**不进 store**：纯派生，存一份就多一个事实源） |
| `app/page.tsx` | 透传 `cacheStats` |
| `app/components/composer/index.tsx` | 透传 `cacheStats` 给圆环 |
| `app/components/context-meter/index.tsx` | ① 面板四行（本轮调用 / 累计输入 / 命中缓存 / 命中率）+ 小字注脚（`cacheFootNote`）② **圆环右侧常驻百分比**（≥75% 转警示色） |
| `app/components/context-meter/context-meter.module.css` | `.cache` / `.cacheRow` / `.cacheKey` / `.cacheValue` / `.foot` / `.reading` |

**验证结果**：`tsc --noEmit` 0 · `pnpm lint` 0 · 全量单测 **68 文件 / 954 条**全绿（起始 940，+14）· dev server `GET /` 200。

**⚠️ 还没做真机验收（第 5 条）** —— 需要真的发两条消息，看面板数字与 `session.jsonl` 里的 `cachedInput` 对不对得上。这是唯一能证明"数字是真的"的判据。

**这一期没做**：A（回合尾读数）、C（轨迹逐笔）。轨迹里其实已经有 `cachedInput`（`message_end` 带整条 message），只是没在界面上渲染。

**已知边界（不在本期）**：进程被杀 / 断电时，那一次 run 的整批消息**不会**落进 `session.jsonl`（批量落盘发生在 run 收尾），但轨迹里有（实时写）。这是 run 落盘策略问题，属于 **C27** 的地盘。

## 七、与其它项的关系

- **C5（遥测 / 分析面板）**：C68 是它的数据前提。C5 做 UI 时要 demo，C68 不用。
- **B10（工作区记忆注入）**：B10 的核心争议是"塞进系统提示词每轮约 1 万 token、改文件还会废一次缓存"。**C68 做完，这笔账才有实测数字。**
- **C25（多模型接入）**：接第二家时必须知道它报不报缓存（阿里 Qwen 是**显式**缓存，不写 `cache_control` 就永远 0 命中）。
