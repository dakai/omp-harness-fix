# Repository Guidelines

## Project Overview
Zero-dependency harness plugin for OMP/pi **and** OpenCode that makes open models (DeepSeek, GLM, Qwen) reliable at tool-calling without changing the model. Implements Command Code's **Validate-then-Repair** strategy: forgive recoverable shape/relational errors at the harness boundary and humanize tool errors for retry.

> "open model bad at tool calling" is almost always a harness problem, not a model problem.

Inspired by [Command Code — How did we make DeepSeek outperform Claude Opus 4.7?](https://commandcode.ai/blog/how-did-we-make-deepseek-outperform-claude-opus-4.7).

## Architecture & Data Flow

Single-module, pipeline-of-pure-functions in `index.js` (~156 LOC). No state, no DI, no framework.

```
onToolCall({ toolName, input })
  -> repairInput(input)               // 4 shape repairs, deep-copy safe
  -> applyRelationalDefaults(toolName, input) // offset/limit pairing
  -> applyLanguageRules(toolName, input)      // Go/Svelte normalization
  -> { input }   // falls back to raw input on throw

onToolError({ toolName, error })
  -> humanizeToolError(toolName, error)
  -> { errorOverride: string }
```

**OpenCode entry (`setup(ctx)`).** OpenCode reads a plugin's default export; for CommonJS that
default is `module.exports`, so `id: 'omp-harness-fix'` + `setup` make the same file loadable
there. `setup` registers `ctx.tool.hook('execute.before')` — markdown unwrap + language rules +
relational defaults, rewriting `event.input` in place — and `ctx.tool.hook('execute.after')`
(appends the `Note:` from `relationalNote`, or humanizes a raw schema blob on
`status === 'error'`). Hooks mutate the event and return nothing; payloads carry `tool` and `id`
(callID).

OpenCode 2.0.32+ ships its own **schema-driven** repair of the four shapes (built-in
`opencode.tool.input.repair`), so `setup` deliberately does **not** call `repairInput` — a second,
coarser pass could corrupt input the runtime already repaired. `repairInput`/`onToolCall` stay
unchanged for OMP/pi, which have no such layer. Don't "restore parity" by wiring `repairInput` in.

**Key modules (all in `index.js`):**
- `repairInput(rawInput)` — ordered shape repairs: (1) delete `null`/`undefined` keys, (2) unwrap degenerate markdown `[/path](http://path)` -> `/path` via regex, (3) `JSON.parse` stringified arrays, (4) wrap bare string -> `[string]` for array-ish keys only. Order is load-bearing: parse before wrap or `'["a","b"]'` becomes `['["a","b"]']`.
- `wrapBareStringAtPath(input, path)` — schema-driven helper for strict Zod `validate -> repair -> re-validate` variant (currently unused by hooks).
- `applyRelationalDefaults(toolName, input)` — if tool name contains `read`/`file`: `limit` alone -> `offset=0`, `offset` alone -> `limit=2000`. Surfaces `Note:` (not `Error:` to avoid red TUI).
- `humanizeToolError(toolName, error)` — maps Zod `invalid_type`/`Expected` blobs to natural-language retry prompts; fallback `Notice: Tool 'X' failed...`.
- `applyLanguageRules(toolName, input)` — Go: collapse `././main.go` -> `./main.go`, `go test` -> `go test ./...`; Svelte: collapse `//` in route paths, inject `--tsconfig ./tsconfig.json` for bare `svelte-check`. Shell fixes are not path-gated.
- `relationalNote(before, after)` — the `Note:` string for a defaulted `offset`/`limit`, or `undefined` when nothing was defaulted.
- `unwrapMarkdown(value)` / `unwrapMarkdownPaths(input)` — the markdown auto-link unwrap alone; `repairInput` uses the first, the OpenCode hook the second.

Ideal flow per README is `validate -> repair -> re-validate` (let Zod `error.issues[].path` localize the bug). Current `index.js` is a simplified eager variant (deep-copy + try/catch) gated behind `onToolCall`.

## Key Directories

Flat layout — no `src/`, `docs/`, `scripts/`, `.github/`:

```
.
├── index.js              # All logic + OMP hooks + OpenCode `setup`
├── extension.mjs         # pi/OMP extension entry
├── test/opencode.test.js # OpenCode hook tests (node:test)
├── package.json          # Sole manifest
├── README.md             # Canonical docs
├── README.zh-CN.md       # Chinese translation
├── README.ja.md          # Japanese translation
└── .gitignore            # Standard Node ignores
```

`.codegraph/` is a local index artifact, not source.

## Development Commands

No build, no dependencies. `node:test` only.

```bash
# Install as OMP plugin
omp install git:github.com/dakai/omp-harness-fix

# Install as OpenCode plugin (from a pushed revision)
opencode plugin add github:dakai/omp-harness-fix

# Enable in omp.config.js
# module.exports = { plugins: ['omp-harness-fix'] };

npm test    # node --test → test/opencode.test.js
```

Manual verification without the runner:

```bash
node -e "const { repairInput } = require('./index'); console.log(repairInput({ path: null, tags: '[\"a\",\"b\"]' }))"
# -> { tags: ['a','b'] }

node -e "const p=require('./index'); p.onToolCall({toolName:'readFile', input:{limit:30}}).then(console.log)"
```

## Code Conventions & Common Patterns

- **Formatting:** No linter/formatter config (`.eslintrc`, `.prettierrc`, `tsconfig.json` all absent). Match existing **1-space** indent, single quotes, CommonJS style.
- **Naming:** `camelCase` for functions/vars, `UPPER_SNAKE` for `CONTENT_KEYS`, file `index.js` only. Export object: `module.exports = { id, name, setup, repairInput, wrapBareStringAtPath, applyRelationalDefaults, humanizeToolError, applyLanguageRules, onToolCall, onToolError }` — `id`/`setup` are the OpenCode contract, the rest serve OMP/pi.
- **Error handling:** `onToolCall` wraps pipeline in `try/catch` and returns raw input on failure. `humanizeToolError` converts Zod errors to retryable `Notice:`/`[Tool Input Error]` strings — never throw to caller.
- **Async:** Only `onToolCall`/`onToolError` are `async` (OMP hook contract); all repair functions are synchronous pure functions.
- **State/DI:** None. Deep-copy via `JSON.parse(JSON.stringify(rawInput))` to avoid mutating caller input. `CONTENT_KEYS` Set blocklist prevents wrapping `content|text|body|message|command|filePath|path|absolutePath|url|file|input`. Array-ish heuristic: `/s$|List$|Array$|Paths?$|Files?$|Ids?$|Items?$|Tags?$|Names?$/`.
- **Design invariants (from README):**
  - Don't touch valid inputs — real markdown `[click](https://x.com)` must pass through.
  - Finite catalogue > heuristics — 4 repairs cover ~90% failures.
  - Transparency over silent magic — defaulted choices surfaced as `Note:`.
  - `ponytail:` comments mark deliberate simplifications and ceilings (e.g., `// ponytail: bare-string→array needs schema`).
- **Telemetry:** Log `tool_input_repaired:{toolName}` on repair success, `tool_input_invalid:{toolName}` on still-invalid after repair.

## Important Files

| Path | Purpose |
|------|---------|
| `index.js` | Entry point + entire plugin — pipeline, helpers, 2 OMP hooks, OpenCode `setup` (~210 LOC) |
| `package.json` | Manifest: `name: omp-harness-fix`, `version: 1.0.0`, `main: index.js`, `type: commonjs`, `scripts.test: node --test` — no deps/engines |
| `test/opencode.test.js` | OpenCode hook tests via `node:test`; stub `ctx.tool.hook`, drive the captured callbacks with plain events |
| `README.md` | Canonical docs: repair catalogue, relational invariants, validate-then-repair rationale, install/usage, telemetry |
| `README.zh-CN.md` / `README.ja.md` | Translations — no extra tooling |
| `.gitignore` | Ignores `node_modules/`, `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`, `dist/`/`build/`/`coverage/`/`*.tsbuildinfo`, `.env` |

## Runtime/Tooling Preferences

- **Runtime:** Node.js (CommonJS `require`). No `engines` field, no lockfile — any recent Node works. OMP harness `require()`s `index.js` and calls `onToolCall`/`onToolError`; OpenCode imports it and calls `setup(ctx)`.
- **Package manager:** `npm` implied by `package.json`; no `bun.lockb`/`pnpm-lock.yaml`/`yarn.lock` committed. No install needed (zero dependencies).
- **Build:** None — "No dependencies. No build step." (`README.md:151`). No transpile, bundle, or `Makefile`/`Dockerfile`/`CI` (`.github/` absent).
- **Constraints:** Keep logic in `index.js`, zero-dep. Don't add build tooling, TS, or dependencies without explicit request. Distribution is via `omp install git:github.com/dakai/omp-harness-fix` (OMP) and `opencode plugin add github:dakai/omp-harness-fix` (OpenCode), both reading the same file.

## Testing & QA

`node:test` only — no framework dependency, no coverage tooling.

```bash
npm test    # node --test → test/opencode.test.js
```

`test/opencode.test.js` drives the real `setup()` with a stub `ctx.tool.hook` and then calls the
captured callbacks with plain event objects, asserting: the loader contract (`id` + `setup`),
shape/language repairs, untouched valid input, the defaulted-range `Note:`, and that only raw
schema blobs get humanized. `.gitignore` entries for `coverage/`/`dist/` are boilerplate and never generated.

- **Verification:** Require and call pure functions directly:
  ```js
  const { repairInput, applyRelationalDefaults, humanizeToolError } = require('./index');
  console.assert(JSON.stringify(repairInput({tags:'["a","b"]'})) === JSON.stringify({tags:['a','b']}));
  ```
- **Left unverified:** the live OpenCode runtime calling the hooks mid-session (needs a model call) —
  load and hook registration were verified against 2.0.32, hook payload shapes are read from the runtime.
