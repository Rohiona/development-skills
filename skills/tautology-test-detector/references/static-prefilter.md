# 静的プレフィルタ（ripgrep パターン集）

`scripts/prefilter.sh` が surface する候補パターンの定義と、それぞれの**誤検出帯域**。
プレフィルタは「候補を機械的に拾う」だけで判定はしない。各ヒットは必ず LLM 段で `detection-criteria.md` の類型＋誤検出ガードに照らして adjudicate する。

> シェル堅牢性: スクリプトは `command rg` / `command grep` で呼び、profile のエイリアス/関数上書きをバイパスする（グローバルルール `shell-robustness`）。`rg` が無ければ `grep -rnE` にフォールバック。

## 対象ファイル

`*.test.ts` / `*.test.tsx` / `*.spec.ts` / `*.spec.tsx` のみ。production コードは対象外。

## カテゴリ別パターン

| カテゴリ | 拾うもの | パターン（regex） | 誤検出帯域 |
|---|---|---|---|
| `META:source-read` | ソースをファイルとして読む | `readFileSync\(` | fixture 読込・スナップショット比較は別物。**実行時 wiring と要区別** |
| `META:grep-spawn` | grep を spawn | `spawnSync\(.{0,3}grep` | ほぼ確実にメタ。誤検出少 |
| `META:source-includes` | ソース文字列の含有を assert | `\.includes\(.{0,2}(as any|as unknown|from .~/gen|function )` | 通常データの `.includes` を拾うことあり。文脈確認必須 |
| `META:self-reference` | 自分/テストファイルを読む | `__filename` / `readFileSync\(\s*__` | 循環メタの強シグナル。誤検出少 |
| `TAUTOLOGY:literal` | 自明な等値 | `expect\(\s*(true|false|-?\d+|null|undefined)\s*\)\.toBe\(\s*(true|false|-?\d+|null|undefined)\s*\)` | 意図的な sentinel 確認のことあり |
| `TAUTOLOGY:scaffold` | 導入時スキャフォールド | `adds 1 \+ 2 to equal 3` / `/temp/sum` | ほぼ確実にスキャフォールド。誤検出ほぼ無 |
| `MOCKONLY:vi-mock` | `vi.mock` 多用（弱シグナル） | `vi\.mock\(` | **誤検出多**。外部依存の遮断は正当。被検対象の置換かは LLM 判定 |
| `DOC:comment-exists` | コメント/ドキュメント存在 | `toContain\(.{0,2}//` / `describe\(.*(ドキュメント|documentation)` | コメント内容の検証は稀に正当 |

## 帯域の濃淡（LLM 段での優先度）

- **濃い（ほぼ確定・明白対応の候補）**: `META:grep-spawn` / `META:self-reference` / `TAUTOLOGY:scaffold`
- **中間（要コード確認）**: `META:source-read` / `META:source-includes` / `TAUTOLOGY:literal` / `DOC:comment-exists`
- **薄い（多くは正当・要慎重判定）**: `MOCKONLY:vi-mock`

`MOCKONLY:vi-mock` は件数が多いので、**単体では削除候補にしない**。「被検対象 = mock 対象」かつ「固有 assert が 0」を実コードで確認できたときのみ ④ として扱う。

## 使い方

```bash
# パッケージ配下を走査
bash scripts/prefilter.sh apps/frontend/src

# PR レビュー: diff のテストファイルだけに限定
bash scripts/prefilter.sh $(git diff --name-only develop...HEAD | grep -E '\.(test|spec)\.tsx?$')
```

出力 1 行 = `category<TAB>file:line:matched`。0 件なら候補なし（＝静的には綺麗）。
ただし静的に拾えない ④ mock-only / 設計意図のあるメタは LLM 段でしか判定できないため、「prefilter 0 件 = 健全」と即断しない。
