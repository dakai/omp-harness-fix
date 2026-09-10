# Repository Guidelines

## Project Overview
Zero-dependency OMP harness plugin that makes open models (DeepSeek, GLM, Qwen) reliable at tool-calling without changing the model. Implements Command Code's **Validate-then-Repair** strategy: forgive recoverable shape/relational errors at the harness boundary and humanize tool errors for retry.

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

**Key modules (all in `index.js`):**
- `repairInput(rawInput)` — ordered shape repairs: (1) delete `null`/`undefined` keys, (2) unwrap degenerate markdown `[/path](http://path)` -> `/path` via regex, (3) `JSON.parse` stringified arrays, (4) wrap bare string -> `[string]` for array-ish keys only. Order is load-bearing: parse before wrap or `'["a","b"]'` becomes `['["a","b"]']`.
- `wrapBareStringAtPath(input, path)` — schema-driven helper for strict Zod `validate -> repair -> re-validate` variant (currently unused by hooks).
- `applyRelationalDefaults(toolName, input)` — if tool name contains `read`/`file`: `limit` alone -> `offset=0`, `offset` alone -> `limit=2000`. Surfaces `Note:` (not `Error:` to avoid red TUI).
- `humanizeToolError(toolName, error)` — maps Zod `invalid_type`/`Expected` blobs to natural-language retry prompts; fallback `Notice: Tool 'X' failed...`.
- `applyLanguageRules(toolName, input)` — Go: collapse `././main.go` -> `./main.go`, `go test` -> `go test ./...`; Svelte: collapse `//` in route paths, inject `--tsconfig ./tsconfig.json` for bare `svelte-check`. Shell fixes are not path-gated.

Ideal flow per README is `validate -> repair -> re-validate` (let Zod `error.issues[].path` localize the bug). Current `index.js` is a simplified eager variant (deep-copy + try/catch) gated behind `onToolCall`.

## Key Directories

Flat layout — no `src/`, `tests/`, `docs/`, `scripts/`, `.github/`:

```
.
├── index.js            # All logic + OMP hooks
├── package.json        # Sole manifest
├── README.md           # Canonical docs
├── README.zh-CN.md     # Chinese translation
├── README.ja.md        # Japanese translation
└── .gitignore          # Standard Node ignores
```

`.codegraph/` is a local index artifact, not source.

## Development Commands

No scripts, no build, no dependencies.

```bash
# Install as OMP plugin
omp install git:github.com/dakai/omp-harness-fix

# Enable in omp.config.js
# module.exports = { plugins: ['omp-harness-fix'] };

# Manual verification (no test runner exists)
node -e "const { repairInput } = require('./index'); console.log(repairInput({ path: null, tags: '[\"a\",\"b\"]' }))"
# -> { tags: ['a','b'] }

# Ad-hoc hook test
node -e "const p=require('./index'); p.onToolCall({toolName:'readFile', input:{limit:30}}).then(console.log)"
```

`npm test` / `npm run <script>` will fail — `package.json` defines no `scripts`. `npm install` installs nothing.

## Code Conventions & Common Patterns

- **Formatting:** No linter/formatter config (`.eslintrc`, `.prettierrc`, `tsconfig.json` all absent). Match existing 2-space indent, CommonJS style.
- **Naming:** `camelCase` for functions/vars, `UPPER_SNAKE` for `CONTENT_KEYS`, file `index.js` only. Export object: `module.exports = { name, repairInput, wrapBareStringAtPath, applyRelationalDefaults, humanizeToolError, applyLanguageRules, onToolCall, onToolError }`.
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
| `index.js` | Entry point + entire plugin — pipeline, 5 helpers, 2 OMP hooks (~150 LOC) |
| `package.json` | Manifest: `name: omp-harness-fix`, `version: 1.0.0`, `main: index.js`, `type: commonjs` — no deps/scripts/engines |
| `README.md` | Canonical docs: repair catalogue, relational invariants, validate-then-repair rationale, install/usage, telemetry |
| `README.zh-CN.md` / `README.ja.md` | Translations — no extra tooling |
| `.gitignore` | Ignores `node_modules/`, `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`, `dist/`/`build/`/`coverage/`/`*.tsbuildinfo`, `.env` |

## Runtime/Tooling Preferences

- **Runtime:** Node.js (CommonJS `require`). No `engines` field, no lockfile — any recent Node works. OMP harness `require()`s `index.js` and calls `onToolCall`/`onToolError`.
- **Package manager:** `npm` implied by `package.json`; no `bun.lockb`/`pnpm-lock.yaml`/`yarn.lock` committed. No install needed (zero dependencies).
- **Build:** None — "No dependencies. No build step." (`README.md:151`). No transpile, bundle, or `Makefile`/`Dockerfile`/`CI` (`.github/` absent).
- **Constraints:** Keep it single-file, zero-dep. Don't add build tooling, TS, or dependencies without explicit request. Distribution is via `omp install git:github.com/dakai/omp-harness-fix`.

## Testing & QA

**No test framework, no test directory, no coverage tooling exists.** `package.json` has no `scripts.test`; no `jest`/`vitest`/`go test` config for this repo (README mentions `go test`/`svelte-check` only as examples of `applyLanguageRules` behavior for *other* projects). `.gitignore` entries for `coverage/`/`dist/` are boilerplate and never generated.

- **Verification:** Require and call pure functions directly:
  ```js
  const { repairInput, applyRelationalDefaults, humanizeToolError } = require('./index');
  console.assert(JSON.stringify(repairInput({tags:'["a","b"]'})) === JSON.stringify({tags:['a','b']}));
  ```
- **If adding tests:** Introduce framework from scratch (e.g., `vitest` or `node:test`). All exported functions are pure and trivially importable — no mocking needed. Test ordering invariant (parse before wrap) and `CONTENT_KEYS` blocklist explicitly.
