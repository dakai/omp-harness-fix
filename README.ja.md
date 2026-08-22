# omp-harness-fix

> OMP 用ツール入力修復レイヤーと人間味のあるエラー — モデルを変えずに、オープンなモデルでもツール呼び出しを信頼できるものに。

**Command Code** のエンジニアリング記事 [How did we make DeepSeek outperform Claude Opus 4.7?](https://commandcode.ai/blog/how-did-we-make-deepseek-outperform-claude-opus-4.7)（著者 Ahmad Awais）に着想を得ています。本リポジトリは、記事で紹介された **Validate-then-Repair（検証してから修復）** 戦略を最小構成で移植し、OMP ハーネス用プラグインとして再実装したものです。

[English](./README.md) | [中文](./README.zh-CN.md) | 日本語

## 核心となる洞察

> 「オープンなモデルはツール呼び出しが苦手」は、ほとんどの場合モデルの問題ではなくハーネスの問題。

多くの場合「モデルの能力」に見えるものは、実は**コントラクト設計（Contract Design）**の問題である。厳格なスキーマはコストを伴う選択だ。ノイズを遮断できる一方で、たまたまあなたが選んだ JSON コントラクトを正確に記憶していないモデルが生む、本来は回復可能なノイズまで遮断してしまう。

Command Code は自社 OSS CLI の中で DeepSeek（flash / v4 Pro）、GLM、Qwen に数十億トークンを流しました。結果、どのオープンなモデルでも同じ 4 つの失敗パターンが約 90% を占めていました。Claude Opus 4.7 のような商用モデルは、事前学習で十分な量のコントラクトを見ているため、ノイズを寛容に吸収できます——コストは不可視化されています。オープンなモデルは同じコストを露わに支払い、「能力不足」と誤解されます。

必要なのはより強力なモデルではなく、**適切な箇所でより寛容なコントラクト**です。

修復レイヤーを追加した結果、**DeepSeek v4 Pro は Command Code の内部評価で Claude Opus 4.7 に 10 回中 6 回勝利**しました。モデル自体は何も変わっていません。
## プラグインの役割

すべてのツール呼び出しは、順に 3 つのレイヤーを通過します：

### 1. 形状の修復（`repairInput`）—— 有限の 4 つの失敗モード

| # | ミスの種類 | 例 | 修復内容 |
|---|-----------|-----|---------|
| 1 | 省略すべき任意フィールドに `null` を送る | `{ path: null }` | キーを `delete`（省略に変換） |
| 2 | 配列を JSON 文字列化して送る | `"[\"a\",\"b\"]"` | `JSON.parse` で実配列に復元 |
| 3 | 配列であるべき箇所に空オブジェクト `{}` を送る | `{}` | `[]` に置換 |
| 4 | Markdown の自動リンクがパスに漏洩 | `"/proj/[notes.md](http://notes.md)"` | 正規表現でアンラップ → `"/proj/notes.md"` |

修復の順序は重要です——「JSON 文字列配列のパース」を「裸の文字列のラップ」より先に試さなければ、`'["a","b"]'` が `['["a","b"]']` に誤変換されます。

**Markdown の漏洩**は最も示唆に富むバグです。DeepSeek はチャット出力で自動リンクを張ることが報酬付けされており、その分布がツール境界を越えて漏れ出します（`filePath: "/Users/x/proj/[notes.md](http://notes. md)"`）。2 行の正規表現で修正でき、本物の Markdown（例：`[click](https://x.com)`）には影響しません。Command Code による根本的な解決は、スキーマレベルでヒントを埋め込むこと——`z.string()` ではなく `pathString()` を使うことで、すべてのパスフィールドを一括で保護します。

### 2. 関係的不変条件（`applyRelationalDefaults`）

形状の修復では**フィールド間の関係**は直せません。例：`readFile({ absolutePath, limit: 30 })` —— 各フィールドは単独では正当ですが、ツールは `offset` と `limit` のペアを要求します。

エラーで返すのではなく、モデルの意図を汲み取って補完します：

- `limit` のみ → `offset = 0`
- `offset` のみ → `limit = 2000`

そして決定を透過的にモデルへ返します：

> `Note: limit was not provided; defaulted to 2000 lines. To read more or fewer lines, retry with both offset and limit.`

`Error:` プレフィックスは付けません（TUI が赤く染まるのを避けるため）。モデルは選択内容を把握し、次ターンで自己修正できます。**暗黙の魔法より透明性を。**

### 3. 人間味のあるエラー（`humanizeToolError`）

生の Zod エラー（`invalid_type`、`Expected ...`）はモデルにとって判読不能で、リカバリを失敗させます。このレイヤーが自然言語のリトライ指示に変換します：

```
[Tool Input Error in 'readFile']
The arguments you provided contained a formatting issue that could not be automatically repaired:
Details: ...
Please check the tool schema and re-issue the tool call with valid types
(e.g. use raw JSON arrays, no markdown links, no raw stringified JSON).
```

Zod 以外のエラーに対するフォールバック：

```
Notice: Tool 'X' failed to execute.
Reason: ...
Please review your input parameters and retry.
```

### おまけ：言語固有ルール（`applyLanguageRules`）

Go と Svelte 向けのプロジェクト固有の堅牢化。同じ修復思想に基づきます：

- **Go**：`././main.go` → `./main.go` に正規化、素の `go test` は `go test ./...` に展開
- **Svelte/SvelteKit**：ルートパス中の `//` を正規化（`/src/routes//+page.svelte`）、素の `svelte-check` に `--tsconfig ./tsconfig.json` を自動付与

## Validate-then-Repair（なぜ前処理ではないのか）

記事からの重要な設計転換：

**`前処理 → 検証` ではなく `検証 → 修復 → 再検証`。**

```
try parse(input) をそのまま
  └─ 成功 → そのまま通す（正当な入力には一切触れない）

  └─ 失敗 → バリデータの issue リストを走査
            各 issue.path に対し 4 つの修復を順に試す
            再度 parse
              ├─ 成功 → tool_input_repaired:{tool} を記録
              └─ 失敗 → tool_input_invalid:{tool} を記録
                        → 人間味のあるリトライ文を返す
```

**理由：** 貪欲な前処理は、たまたま JSON に見える正当な入力を破損します（例：`writeFile` の中身自体が JSON である場合）。バリデータに先に不満を言わせることで、スキーマがバグの位置を特定してくれます——スキーマが実際に否定したパスにだけ修復予算を使います。

これは `cheap-then-careful`（まず高速パスを試し、証拠に基づいてフォールバックする）と同じ構造です。おまけにツール単位のテレメトリ（`(model, tool)` ごとの修復率）も無料で手に入ります。

> 現在の `index.js` は簡略化された eager 版（検証前に修復が走り、ディープコピー + try/catch で保護）を実装しています。厳密な validator-driven 版が必要な場合は、Zod の `safeParse` 失敗をゲートにして `repairInput` を呼び出し、`error.issues[].path` を走査してください。

## インストール

```bash
omp install git:github.com/dakai/omp-harness-fix
```

## 使い方

### OMP プラグインとして

```js
// omp.config.js
module.exports = {
  plugins: ['omp-harness-fix']
};
```

プラグインは 2 つのフックをエクスポートします：

```js
const plugin = require('omp-harness-fix');

// ツール実行前 —— 修復済みの入力を返す
await plugin.onToolCall({ toolName: 'readFile', input });

// ツールエラー時 —— 人間味のある上書きメッセージを返す
await plugin.onToolError({ toolName: 'readFile', error });
```

### スタンドアロン

```js
const { repairInput, applyRelationalDefaults, humanizeToolError, applyLanguageRules } = require('./index');

// 形状修復のみ
const fixed = repairInput({ path: null, tags: '["a","b"]' });
// → { tags: ["a", "b"] }  （null キーは削除、文字列化された配列はパース）
```

## プロジェクト構成

```
.
├── index.js      # すべての修復ロジック + OMP フック（約 150 行）
└── package.json
```

依存関係なし、ビルドステップなし。

## 設計原則（記事より）

1. **有限のカタログ > 開放的なヒューリスティクス。** 4 つの修復で約 90% をカバー。まずここから。
2. **スキーマが事前分布。** バリデータに局所化させ、壊れている箇所を推測しない。
3. **正当な入力には触れない。** 決して。
4. **修復できるものは修復し、できなければセマンティクスを拡張する。どちらも選択を可視化する。**
5. **コントラクト設計が能力である。** 厳格すぎるスキーマは回復可能なノイズまで遮断する。適切な継ぎ目で寛容にせよ。

## テレメトリ（推奨）

記事の推奨どおり、呼び出しごとに 2 つのカウンタを記録します：

- `tool_input_repaired:{toolName}` —— 修復成功、修復済み入力でリトライ
- `tool_input_invalid:{toolName}` —— 修復後も無効、人間味のあるエラーを返却

`(model, tool)` ごとの修復率を監視すれば、リグレッションをユーザー報告より先に検知できます。

## 謝辞

4 つの形状カタログ、Markdown 自動リンクの漏洩、validate-then-repair の転換、関係的不変条件、人間味のあるエラー、そして「ハーネス > モデル」というフレーミングを含むすべての中心的なアイデアは、[Command Code](https://commandcode.ai/blog/how-did-we-make-deepseek-outperform-claude-opus-4.7)（著者 Ahmad Awais）によるものです。本リポジトリは OMP ハーネス向けの独立した最小再実装であり、公式とは無関係です。

Command Code チームの関連記事：[AICodeKing: "The harness matters more than the model"](https://commandcode.ai/blog/aicodeking-the-harness-matters-more-than-the-model)、[/goal](https://commandcode.ai/blog/slash-goal-give-command-code-an-objective)、[6.9B tokens レポート](https://commandcode.ai/blog/jefferson-nunn-ran-6-9b-tokens-for-156-dollars)。

## ライセンス

MIT
