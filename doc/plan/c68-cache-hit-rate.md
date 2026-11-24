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

### 3.4 明确不做：任何界面显示

**一期只到数据层。** 理由两条：

1. **界面显示归 C5**（遥测 / 分析面板）。C68 是它的第一块砖：先有数，面板才有东西画。
2. **不越规则**：`AGENTS.md` 11.8 规定任何视觉改动（含只改一个字号）必须先出 HTML demo。这轮是在会话中途插进来的，**不给自己加一道 demo 门**。

想肉眼看到数字，两条路都不用改代码：
- 打开 `<数据根>/sessions/<工作空间键>/<会话目录>/*.jsonl`（数据根默认 `~/.statve`，`STATVE_HOME` 可覆盖）
- 打开同目录的 `trace.<runId>.jsonl`，找 `message_end`

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
| 5 | ⭐ **真机**：同一个会话第二轮请求的 `cachedInput` ≈ 第一轮的 `input + output` | DeepSeek 官方场景 1「下一轮能命中上一轮的上下文缓存」。发两条消息，看会话 JSONL |
| 6 | `tsc --noEmit` / `pnpm lint` / 全量单测 | 常规三件套 |

第 5 条是**唯一能证伪"我们以为缓存命中"的判据** —— 前四条都只证明"解析写得对"，只有它证明"数字是真的"。

## 五、⚠️ 缺什么才能定案

1. **字段名**：`cachedInput` 行不行？（也可以叫 `cacheHit` / `cachedInputTokens`）
2. **一期是否只到数据层**（不做任何界面）—— 需要用户点头，因为"看不到"可能让人觉得没做完。

除此之外没有悬空项：3.1 / 3.2 / 3.3 都是从现有代码结构推出来的，不是发明。

## 六、与其它项的关系

- **C5（遥测 / 分析面板）**：C68 是它的数据前提。C5 做 UI 时要 demo，C68 不用。
- **B10（工作区记忆注入）**：B10 的核心争议是"塞进系统提示词每轮约 1 万 token、改文件还会废一次缓存"。**C68 做完，这笔账才有实测数字。**
- **C25（多模型接入）**：接第二家时必须知道它报不报缓存（阿里 Qwen 是**显式**缓存，不写 `cache_control` 就永远 0 命中）。
