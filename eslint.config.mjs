// ESLint 配置（flat config）。
//
// 为什么是这个形状（来龙去脉见 doc/plan/c45-lint-format.md）：
//   · Next 16 已删除 `next lint` —— 官方路线就是 ESLint CLI + 本文件 + eslint-config-next。
//   · 硬规则那一块抄自同级项目 ai-admin-pro 的 eslint.config.mjs，但**没抄 id-length**
//     （实测 248 条违规里绝大多数是 catch (e) / (e) => 这类惯用短名，是噪音不是坏命名）。
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    // 机器目录：不进版本控制，也没有"代码质量"可言
    ".pnpm-store/**",
    ".reasonix/**",
    ".repo-updates/**",
    ".sessions/**",
    ".traces/**",
    ".tmp_pdf/**",
    ".tmp-lint/**",
    "workspace/**",
  ]),

  ...nextVitals,
  ...nextTs,

  // ======================== 硬规则 ========================
  // 为什么抄这些：它们把 AGENTS.md 里"靠记性"的规矩变成"跑一下就报"。
  // 每条都实测过存量代价（见详案 3.2 的表），代价大的（id-length）没抄。
  {
    rules: {
      // —— 把 tsc 查不出的死代码揪出来 ——
      // 为什么值得单列：AGENTS.md「环境与验证」写着「tsc 绿 ≠ 没有垃圾」——
      // tsconfig 没开 noUnusedLocals，删代码后留下的死导入它一个字都不报。实测抓出 21 处。
      // ignoreRestSiblings：`const { [key]: _gone, ...rest } = obj` 是"剔除某个 key"的标准写法，
      // `_gone` 是必然的占位符 —— 没有它这条规则会逼人把这段语义拆散（见 run-store 的 deleteRun）。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",

      // —— 函数质量：AGENTS.md 第 2 条（函数小而单一）+ 第 5 条（避免深层嵌套）——
      // 为什么是 15 不是 ai-admin-pro 的 10：实测 10 会打在红线文件 lib/agent/index.ts 的
      // runAgentLoop 上（复杂度 11）—— 为一条 lint 阈值去动 agent 内核是本末倒置；
      // 而且最复杂的两个函数（classifyIpv4 32 / measureTagDepth 24）是**查表型**，
      // 拆成 4 个 8 只会让读的人多跳 4 个地方。详见详案 4.1③。
      complexity: ["error", { max: 15 }],
      "max-depth": ["error", { max: 3 }],
      "max-params": ["error", { max: 3 }],

      // —— 防 Bug ——
      eqeqeq: ["error", "always"],
      "guard-for-in": "error",
      "no-throw-literal": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "no-promise-executor-return": "error",
      "array-callback-return": "error",
      "no-constructor-return": "error",
      "consistent-return": "error",
      "no-use-before-define": [
        "error",
        { functions: false, classes: true, variables: true },
      ],

      // —— 代码质量 ——
      curly: ["warn", "all"],
      "no-nested-ternary": "error",
      "no-param-reassign": "error",
      "object-shorthand": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "no-var": "error",
      "no-eval": "error",
      "no-extend-native": "error",
      "no-proto": "error",
    },
  },

  // 组件文件再放宽 —— JSX 条件渲染天然多分支，不代表逻辑复杂
  {
    files: ["**/*.tsx"],
    rules: {
      complexity: ["error", { max: 20 }],
    },
  },

  // ======================== 体量上限（C64） ========================
  // 规矩：**前端组件单文件不超过 500 行，超了必须拆**（AGENTS.md 11.9 / PLAN 需求池 C64）。
  // 2026-11-20 用户提议改判：**不写 scripts/check-size.mjs，直接用 ESLint 内置的 max-lines**。
  // 三条理由：
  //   ① 提交门早就有了（husky → lint-staged → eslint --fix），规则一加就**真的挡提交**；
  //   ② max-lines **不可自动修复** ⇒ `--fix` 不会把它悄悄放过；
  //   ③ 编辑器里当场变红，不用等到提交；也少一个"要记得跑"的脚本。
  // 背景：同一个文件两个月内长回去过（408 → 474 → 489 → 556 → 722），
  // 2026-11-20 拆到 479 之后**当天又长回 541** ⇒ 靠人量不住，必须机器判据。
  //
  // ⚠️ 口径：ESLint 数的是"文件行数"，**末尾换行不算一行** ⇒ 比 `split("\n").length` 少 1
  //    （实测 app/page.tsx：split 498 / ESLint 497）。以后一律以 ESLint 报的数字为准。
  // ⚠️ 真要留一个超长的"单职责"文件（典型是一个长查表 switch），必须**带理由**豁免：
  //    `/* eslint-disable-next-line max-lines -- 为什么 */`（同 C45 对 4 处查表函数的处理）。
  //    想让豁免被看见，就得付出"写一行解释"的代价 —— 这是故意的。
  {
    files: ["app/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: {
      "max-lines": ["error", { max: 500 }],
    },
  },

  // 必须最后：关掉 ESLint 里和 Prettier 打架的格式化规则
  prettier,
]);
