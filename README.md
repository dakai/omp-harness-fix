# omp-harness-fix

> Tool Input Repair Layer and Humanized Errors for OMP — make open models reliable at tool calling without changing the model.

**English** | [中文](./README.zh-CN.md) | [日本語](./README.ja.md)

Inspired by **Command Code**'s engineering post: [How did we make DeepSeek outperform Claude Opus 4.7?](https://commandcode.ai/blog/how-did-we-make-deepseek-outperform-claude-opus-4.7) by Ahmad Awais. This repo is a minimal, portable implementation of the **Validate-then-Repair** strategy described there, adapted as an OMP harness plugin.

## The Insight

> "open model bad at tool calling" is almost always a harness problem, not a model problem.

Command Code ran billions of tokens through DeepSeek (flash / v4 Pro), GLM, Qwen inside their open-source CLI. The same 4 failure modes repeated across every open model (~90% of failures). Commercial models like Claude Opus 4.7 absorb the cost invisibly — they've seen enough contracts during pretraining to be lenient. Open models pay it loudly and get dismissed for it.

The fix isn't a better model. It's a more forgiving contract — in exactly the right places.

After the repair layer, **DeepSeek v4 Pro beat Claude Opus 4.7 6/10 times** on Command Code's internal evals. The model didn't change.

## What This Plugin Does

Three layers, applied in order on every tool call:

### 1. Shape Repairs (`repairInput`) — 4 finite failure modes

| # | Mistake | Example | Repair |
|---|---------|---------|--------|
| 1 | `null` for optional field instead of omitting | `{ path: null }` | `delete` the key (omit) |
| 2 | JSON-stringified array instead of array | `"[\"a\",\"b\"]"` | `JSON.parse` → real array |
| 3 | Empty placeholder object where array expected | `{}` | `[]` |
| 4 | Markdown auto-link leaking into path | `"/proj/[notes.md](http://notes.md)"` | Regex unwrap → `"/proj/notes.md"` |

Repairs are ordered carefully — JSON-array-parse must run before any bare-string-wrap, or `'["a","b"]'` becomes `['["a","b"]']`.

**The markdown leak** is the most revealing bug: DeepSeek has been rewarded for auto-linking in chat output, and that distribution leaks through the tool boundary (`filePath: "/Users/x/proj/[notes.md](http://notes. md)"`). Two regex lines fix it. Real markdown like `[click](https://x.com)` passes through untouched. Command Code's deeper fix is to encode the hint at the schema level — `pathString()` instead of `z.string()` — so every path field is protected at once.

### 2. Relational Invariants (`applyRelationalDefaults`)

Shape repairs can't fix *relationships* between fields. Example: `readFile({ absolutePath, limit: 30 })` — each field is valid alone, but the tool requires `offset` + `limit` together.

Instead of erroring, teach the function the model's intent:

- `limit` alone → `offset = 0`
- `offset` alone → `limit = 2000`

And surface the choice back transparently:

> `Note: limit was not provided; defaulted to 2000 lines. To read more or fewer lines, retry with both offset and limit.`

No `Error:` prefix (so the TUI doesn't paint it red). The model sees what was chosen and can self-correct next turn. **Transparency over silent magic.**

### 3. Humanized Errors (`humanizeToolError`)

Raw Zod issue blobs (`invalid_type`, `Expected ...`) are unreadable to the model and cause recovery failure. This layer converts them to natural-language retry prompts:

```
[Tool Input Error in 'readFile']
The arguments you provided contained a formatting issue that could not be automatically repaired:
Details: ...
Please check the tool schema and re-issue the tool call with valid types
(e.g. use raw JSON arrays, no markdown links, no raw stringified JSON).
```

Default fallback for non-Zod errors:

```
Notice: Tool 'X' failed to execute.
Reason: ...
Please review your input parameters and retry.
```

### Bonus: Language-Specific Rules (`applyLanguageRules`)

Project-specific hardening for Go and Svelte, following the same repair philosophy:

- **Go**: collapses `././main.go` → `./main.go`; expands bare `go test` → `go test ./...`
- **Svelte/SvelteKit**: collapses `//` in route paths (`/src/routes//+page.svelte`); injects `--tsconfig ./tsconfig.json` for bare `svelte-check`

## Validate-then-Repair (Why Not Preprocess?)

The key design inversion from the article:

**Don't do `preprocess → validate`. Do `validate → repair → re-validate`.**

```
try parse(input) as-is
  └─ success → ship it (valid inputs never touched)

  └─ failure → walk validator's issue list
                for each issue.path, try 4 repairs in order
                parse again
                  ├─ success → log tool_input_repaired:{tool}
                  └─ failure → log tool_input_invalid:{tool}
                              → return humanized retry message
```

**Why:** A greedy preprocessing pass corrupts valid inputs that happen to be JSON-shaped (e.g., `writeFile` content that is legitimately JSON). By letting the validator complain first, the schema localizes the bug — you only spend repair budget at the exact paths the schema disagreed at.

Same shape as `cheap-then-careful` everywhere else: try the fast path, fall back on evidence. You also get per-tool telemetry for free (`(model, tool)` repair rates).

> Current `index.js` implements a simplified eager variant (repairs run before validation, with deep-copy + try/catch). For a strict validator-driven version, gate `repairInput` behind a Zod `safeParse` failure and walk `error.issues[].path`.

## Installation

```bash
npm install omp-harness-fix
# or copy index.js into your OMP plugins directory
```

## Usage

### As an OMP Plugin

```js
// omp.config.js
module.exports = {
  plugins: ['omp-harness-fix']
};
```

The plugin exports two hooks:

```js
const plugin = require('omp-harness-fix');

// Before tool execution — returns repaired input
await plugin.onToolCall({ toolName: 'readFile', input });

// On tool error — returns human-readable override
await plugin.onToolError({ toolName: 'readFile', error });
```

### Standalone

```js
const { repairInput, applyRelationalDefaults, humanizeToolError, applyLanguageRules } = require('./index');

// Shape repair only
const fixed = repairInput({ path: null, tags: '["a","b"]' });
// → { tags: ["a", "b"] }  (null key deleted, stringified array parsed)
```

## Project Structure

```
.
├── index.js      # All repair logic + OMP hooks (~150 LOC)
└── package.json
```

No dependencies. No build step.

## Design Principles (from the article)

1. **Finite catalogue > open-ended heuristics.** 4 repairs cover ~90% of failures. Start there.
2. **Schema is the prior.** Let the validator localize; don't guess what's broken.
3. **Don't touch valid inputs.** Ever.
4. **Repair where you can. Extend semantics where you can't. Surface the choice either way.**
5. **Contract design is capability.** A strict schema filters recoverable noise. Make it forgiving at the right seams.

## Telemetry (Recommended)

Log two counters per call (as in the article):

- `tool_input_repaired:{toolName}` — repair succeeded, retry with fixed input
- `tool_input_invalid:{toolName}` — still invalid after repair, sent humanized error

Watch repair rates per `(model, tool)` — regressions show up before users report them.

## Attribution

All core ideas — the 4-shape catalogue, markdown auto-link leak, validate-then-repair inversion, relational invariants, humanized errors, and the "harness > model" framing — are from [Command Code](https://commandcode.ai/blog/how-did-we-make-deepseek-outperform-claude-opus-4.7) by Ahmad Awais. This repo is an independent, minimal reimplementation for the OMP harness. No affiliation.

Additional context from the Command Code team: [AICodeKing: "The harness matters more than the model"](https://commandcode.ai/blog/aicodeking-the-harness-matters-more-than-the-model), [/goal](https://commandcode.ai/blog/slash-goal-give-command-code-an-objective), [6.9B tokens report](https://commandcode.ai/blog/jefferson-nunn-ran-6-9b-tokens-for-156-dollars).

## License

MIT
