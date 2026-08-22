# omp-harness-fix

> OMP 工具输入修复层与人性化错误 — 无需更换模型，让开源模型在工具调用上变得可靠。

灵感来自 **Command Code** 的工程长文：[How did we make DeepSeek outperform Claude Opus 4.7?](https://commandcode.ai/blog/how-did-we-make-deepseek-outperform-claude-opus-4.7)（作者 Ahmad Awais）。本仓库是文中 **Validate-then-Repair（先校验再修复）** 策略的最小化、可移植实现，并适配为 OMP harness 插件。

[English](./README.md) | [日本語](./README.ja.md) | 中文

## 核心洞察

> "开源模型工具调用不行" 几乎总是 harness 的问题，而不是模型的问题。

Command Code 在自家开源 CLI 中跑了数十亿 token 的 DeepSeek（flash / v4 Pro）、GLM、Qwen。结果发现所有开源模型的失败模式高度收敛——同样的 4 种错误占了约 90%。像 Claude Opus 4.7 这样的商业模型在预训练中见过足够多的契约，能够"宽容"地消化这些噪音，成本被隐形消化；而开源模型则会大声报错，然后被误判为"能力不行"。

修复方法不是换更强的模型，而是**让契约在恰当的地方变得更宽容**。

加上修复层后，**DeepSeek v4 Pro 在 Command Code 内部评测中 6/10 次击败 Claude Opus 4.7**。模型本身没有变。

## 插件做了什么

每次工具调用按顺序经过三层处理：

### 1. 形状修复（`repairInput`）—— 4 种有限的失败模式

| # | 错误类型 | 例子 | 修复方式 |
|---|---------|------|---------|
| 1 | 可选字段传 `null` 而非省略 | `{ path: null }` | `delete` 该键（改为省略） |
| 2 | 数组被序列化为 JSON 字符串 | `"[\"a\",\"b\"]"` | `JSON.parse` 还原为真实数组 |
| 3 | 本该是数组的地方传了空对象占位符 | `{}` | `[]` |
| 4 | Markdown 自动链接泄漏到路径中 | `"/proj/[notes.md](http://notes.md)"` | 正则解包 → `"/proj/notes.md"` |

修复顺序很关键——必须先尝试"JSON 字符串数组解析"，再做"裸字符串包裹"，否则 `'["a","b"]'` 会被误修成 `['["a","b"]']`。

**Markdown 泄漏**是最有启发性的 bug：DeepSeek 在对话训练中被奖励过自动加链接，这个分布泄漏到了工具边界（`filePath: "/Users/x/proj/[notes.md](http://notes. md)"`）。两行正则就能修复，真正的 Markdown 如 `[click](https://x.com)` 不受影响。Command Code 更彻底的解法是在 schema 层面编码提示——用 `pathString()` 代替 `z.string()`，让所有路径字段一次性得到保护。

### 2. 关联不变量（`applyRelationalDefaults`）

形状修复解决不了**字段之间的关系**。例如：`readFile({ absolutePath, limit: 30 })`——每个字段单独看都合法，但工具要求 `offset` 和 `limit` 成对出现。

与其直接报错，不如教会函数理解模型的意图：

- 只传 `limit` → `offset = 0`
- 只传 `offset` → `limit = 2000`

并将决策透明地回显给模型：

> `Note: limit was not provided; defaulted to 2000 lines. To read more or fewer lines, retry with both offset and limit.`

不加 `Error:` 前缀（避免 TUI 标红）。模型能看到我们做了什么选择，下一轮可以自行纠正。**透明胜过静默的魔法。**

### 3. 人性化错误（`humanizeToolError`）

原始的 Zod 报错（`invalid_type`、`Expected ...`）对模型不可读，会导致恢复失败。这一层将其转为自然语言的重试提示：

```
[Tool Input Error in 'readFile']
The arguments you provided contained a formatting issue that could not be automatically repaired:
Details: ...
Please check the tool schema and re-issue the tool call with valid types
(e.g. use raw JSON arrays, no markdown links, no raw stringified JSON).
```

非 Zod 错误的默认兜底：

```
Notice: Tool 'X' failed to execute.
Reason: ...
Please review your input parameters and retry.
```

### 额外：语言专属规则（`applyLanguageRules`）

针对 Go 和 Svelte 的项目级加固，遵循同样的修复哲学：

- **Go**：折叠 `././main.go` → `./main.go`；将裸 `go test` 展开为 `go test ./...`
- **Svelte/SvelteKit**：折叠路由路径中的 `//`（`/src/routes//+page.svelte`）；为裸 `svelte-check` 自动补上 `--tsconfig ./tsconfig.json`

## Validate-then-Repair（为什么不做预处理？）

来自原文的关键设计反转：

**不要做 `预处理 → 校验`，要做 `校验 → 修复 → 再校验`。**

```
try parse(input) 原样
  └─ 成功 → 直接放行（合法输入绝不触碰）

  └─ 失败 → 遍历校验器的 issue 列表
            对每个 issue.path，按顺序尝试 4 种修复
            再次 parse
              ├─ 成功 → 记录 tool_input_repaired:{tool}
              └─ 失败 → 记录 tool_input_invalid:{tool}
                        → 返回人性化重试提示
```

**原因：** 贪心的预处理会误伤恰好长得像 JSON 的合法输入（例如 `writeFile` 的内容本身就是 JSON）。让校验器先抱怨，schema 来定位 bug——只在 schema 真正不认同的路径上花修复预算。

这和 `cheap-then-careful`（先走快路径，再按证据兜底）是同一形态。同时还能免费获得按工具粒度的遥测（`(model, tool)` 的修复率）。

> 当前 `index.js` 实现的是简化版的 eager 变体（修复在校验前执行，通过深拷贝 + try/catch 保护）。如需严格的 validator-driven 版本，请在 Zod `safeParse` 失败后门控 `repairInput`，并遍历 `error.issues[].path`。

## 安装

```bash
npm install omp-harness-fix
# 或直接将 index.js 复制到你的 OMP plugins 目录
```

## 使用

### 作为 OMP 插件

```js
// omp.config.js
module.exports = {
  plugins: ['omp-harness-fix']
};
```

插件导出两个钩子：

```js
const plugin = require('omp-harness-fix');

// 工具执行前——返回修复后的输入
await plugin.onToolCall({ toolName: 'readFile', input });

// 工具报错时——返回人性化覆盖信息
await plugin.onToolError({ toolName: 'readFile', error });
```

### 独立使用

```js
const { repairInput, applyRelationalDefaults, humanizeToolError, applyLanguageRules } = require('./index');

// 仅形状修复
const fixed = repairInput({ path: null, tags: '["a","b"]' });
// → { tags: ["a", "b"] }  （null 键被删除，字符串化数组被解析）
```

## 项目结构

```
.
├── index.js      # 全部修复逻辑 + OMP 钩子（约 150 行）
└── package.json
```

零依赖，无构建步骤。

## 设计原则（来自原文）

1. **有限目录 > 开放式启发法。** 4 种修复覆盖约 90% 的失败，先从这里开始。
2. **Schema 即先验。** 让校验器定位问题，不要猜哪里坏了。
3. **绝不触碰合法输入。**
4. **能修就修，不能修就扩展语义，无论哪种都要把选择回显出来。**
5. **契约设计即能力。** 过于严格的 schema 会过滤掉可恢复的噪音，在恰当的接缝处让它更宽容。

## 遥测（推荐）

按原文建议，每次调用记录两个计数器：

- `tool_input_repaired:{toolName}` —— 修复成功，重试已修复输入
- `tool_input_invalid:{toolName}` —— 修复后仍无效，已发送人性化错误

观察每个 `(model, tool)` 的修复率——回归在用户报障之前就能被发现。

## 致谢

所有核心思想——4 种形状目录、Markdown 自动链接泄漏、validate-then-repair 反转、关联不变量、人性化错误、以及 "harness > model" 的框架——均来自 [Command Code](https://commandcode.ai/blog/how-did-we-make-deepseek-outperform-claude-opus-4.7)（作者 Ahmad Awais）。本仓库是针对 OMP harness 的独立最小化再实现，与官方无关联。

Command Code 团队的其他相关文章：[AICodeKing: "The harness matters more than the model"](https://commandcode.ai/blog/aicodeking-the-harness-matters-more-than-the-model)、[/goal](https://commandcode.ai/blog/slash-goal-give-command-code-an-objective)、[6.9B tokens 报告](https://commandcode.ai/blog/jefferson-nunn-ran-6-9b-tokens-for-156-dollars)。

## 许可证

MIT
