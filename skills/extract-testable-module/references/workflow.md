# 実行手順の詳細

SKILL.md の判断（自己評価ゲート → 切り出し）を、実際のツール操作に落とした手順。
コード探索・改変は Serena をデフォルトにし、型・コールグラフが論点になったら LSP に切り替える。
機械的なシンボル移動は `ts-morph` MCP を使う。

## 0. 準備

- **最初に Serena と LSP を取得する（特にサブエージェントで実行する場合は必須手順）。** ツールが事前ロードされていない文脈で取得を怠ると、`Read` がフックでブロックされて Grep に劣化フォールバックし、型・参照の正確さもトークン効率も落ちる（実測）。
  ```
  ToolSearch("select:mcp__plugin_serena_serena__find_symbol,mcp__plugin_serena_serena__get_symbols_overview,mcp__plugin_serena_serena__search_for_pattern,mcp__plugin_serena_serena__find_file,mcp__plugin_serena_serena__find_referencing_symbols,mcp__plugin_serena_serena__replace_symbol_body,mcp__plugin_serena_serena__activate_project")
  ToolSearch("select:LSP")
  ```
  ts-morph で機械的移動を使うなら `ToolSearch("select:mcp__mcp-tsmorph-refactor__move_symbol_to_file_by_tsmorph,mcp__mcp-tsmorph-refactor__rename_symbol_by_tsmorph,mcp__mcp-tsmorph-refactor__change_signature_by_tsmorph")` も取得する。**取得を試みた上で本当に使えない環境のときだけ**、§3 末尾の Read/Grep フォールバックに切り替える（無取得のまま Grep に流れない）。
- Serena を初めて使うセッションでは `activate_project(project="<プロジェクト名 or 絶対パス>")` を一度だけ実行する（未実行だと `No active project` になる）。
- 対象メソッドの正確な位置（ファイル・行・シンボル名）を `find_symbol` で確定してから着手する。位置を当てずっぽうで触らない。
- **LSP の型精度は deps/index が前提。** `node_modules` 未インストールの worktree 等では `hover` が `any` を返し、隠れた入力の引数化（§4-3）の型確定精度が落ちる。型を厳密に取りたいなら依存が入った状態で実行し、取れないときはその旨を残す。
- **探索・改変の対象となる実ファイルが無い／規約が既に事実として与えられている文脈（評価のみ・スニペット相談等）では、ツール取得・近隣調査は対象がある分だけでよい（空振りを強制しない）。** 与えられた/既知の規約を明示採用し「近隣調査の代わりに与件を採用した」と残す。実リポでの実作業では省略しない。

## 1. 自己評価ゲート（能動起動なら必ず最初に）

実装直後・自己点検として起動したときは、切り出しに入る前に SKILL.md「自己評価ゲート」の 5 問を、対象コードに対して具体的に答える。

1. **要件・文脈** — このコードは何のために書いたか。業務上のゴールは何か。
2. **責務の数** — 担っている「変更理由」をいくつ数えられるか（SRP）。
3. **関心の混在** — 純粋ロジックと副作用、業務的関心と技術的関心が同居していないか（関心の分離）。あわせて **rate-of-change（揮発↔安定）**: 揮発な adapter（外部フォーマット・契約の取り出し）と安定な policy（純粋な判定）が 1 関数に同居していないか。同居していたら deletion test 上浅く見えても層分離を検討する（`design-principles.md` (d)）。
4. **配置の妥当性** — 既存の層・慣習なら、この責務はどこに置かれるはずか。今の置き方は外れていないか。
5. **テスト可能性** — いま単体テストを書くなら何をモックするか。多いなら絡まっている証拠。
6. **型は関心を表現しているか** — 同型プリミティブの引数並び・不正状態が作れる型・裸の `as` キャストが無いか。検証は絞った型で返しているか（parse, don't validate。`design-principles.md` 2-(e)）。

棚卸し表（`testability_inventory`）を書く前に、**単位を機械列挙して網羅性を突合する**（列挙された全単位が表に載ること）:

```bash
python3 ~/.claude/skills/extract-testable-module/scripts/verify-extraction.py --list-units --file <編集した実ファイル> [--file ...]
```

結論として「**切り出すべき関心・単位・置き場所**」を決める。問題が無ければ「責務設計は妥当」と判断してここで通過してよい（過剰分割は 3 軸に反する）。
判断の詳細な拠り所は `design-principles.md` を参照。

受動起動（明示依頼）なら対象は与えられているので、責務の棚卸し（2〜5）から入る。

## 2. 近隣調査（置き場所と流儀を事実で把握する）

切り出し先と書式を、思い込みではなくコードベースの事実で決める。新しい流儀を持ち込まない。（実ファイルにアクセスできない／規約が既に事実として与えられている場合は、それを採用し「近隣調査の代わりに与件を採用した」と明示して残す。捏造で埋めない。）

1. **テストフレームワークと実行方法** — `package.json` の devDependencies と test スクリプト、`jest.config.*` / `vitest.config.*` の有無で確定。モノレポなら対象パッケージ単位で確認。
2. **テストファイルの配置・命名** — 隣に `*.test.ts`（co-location）か、`__tests__/` 集約か。対象に近い方に倣う。
3. **同種の責務の置き場所** — 純粋関数がどこにあるか（`utils/`、ドメイン直下の `utils/`、`{module}.ts` 内の `export const`、専用の `domain/` 等）。`get_symbols_overview` で周辺構造を俯瞰し、`search_for_pattern` で似た関数の置かれ方を探す。
4. **依存注入の流儀** — コンストラクタ注入か、関数引数か、DI コンテナ（Awilix 等）か。切り出した単位の依存の渡し方をこれに合わせる。
5. **命名規則** — 関数・ファイルの命名（`xxx.service.ts` / `xxx-parser.ts` など）。
6. **同等ロジックの既存実装が無いか** — 新モジュールを作る前に、同じ責務の関数が既に存在しないか `search_for_pattern`（無ければ grep）で検索する。既にあれば新設せず、そこへ寄せる（必要なら `extraction-patterns.md` §5 の共有 Extract）。近似重複モジュール＝重複正本を作らない。

> 例（あるモノレポで実際に確認された慣習）: **テストフレームワークはパッケージで異なる — `server-core` 等バックエンド系は Jest + ts-jest、`frontend` は vitest。対象パッケージで必ず確認する（`package.json` の `test` スクリプトと、隣接する既存テストの import 文＝`from 'vitest'` か否か）。** 配置は co-location 主体（`xxx.test.ts`）と `__tests__/` 併用、純粋関数は `utils/`、依存はコンストラクタ注入（Awilix）。作業のたびに必ず再確認すること。プロジェクトが違えば前提も変わる。

## 3. ツールの使い分け

| 目的 | ツール | 補足 |
|---|---|---|
| シンボルの位置・本体を読む | Serena `find_symbol` / `get_symbols_overview` | ファイル全体を読まずに構造把握 |
| 似た実装・置き場所を探す | Serena `search_for_pattern` | regex/パターン検索 |
| 参照元を洗う | Serena `find_referencing_symbols`、厳密化が要れば LSP `findReferences` | 切り出し対象の呼び出し元確認 |
| 「この式の型は？」「シグネチャは？」 | LSP `hover` / ts-morph `get_type_at_position` | 抽出関数の引数・戻り値の型を確定 |
| 呼び出し関係を辿る | LSP `incomingCalls` / `outgoingCalls` | オーケストレーション境界を見る |
| シンボルを別ファイルへ移動（import 自動更新） | ts-morph `move_symbol_to_file_by_tsmorph` | 手作業の import 取りこぼし防止 |
| 安全なリネーム | ts-morph `rename_symbol_by_tsmorph` | 参照を一括更新 |
| シグネチャ変更（依存の引数化等） | ts-morph `change_signature_by_tsmorph` | |
| 本体の書き換え | Serena `replace_symbol_body` / `insert_after_symbol` / `insert_before_symbol` | 書き換えは Serena（LSP は読み取り専用） |

原則: **読み・型解決は LSP / Serena、書き換えは Serena / ts-morph**。LSP は編集しない。

ただしこれらは推奨手段にすぎない。Serena / LSP / ts-morph が未接続・利用不可の環境では、通常の Read / Grep / Write / Edit / Bash で同じ手順を踏めばよい。大切なのはツールではなく「純粋ロジックを分離し、テストを書き、型とテストで等価性を検証する」という中身。

## 4. Extract（純粋ロジックを剥がす）の安全手順

最頻出かつ最も価値が高い。等価変換であることを一歩ずつ保証する。

1. 剥がす範囲を決める（副作用のない、入力→出力が閉じた塊）。
2. 切り出し先ファイルを決める（近隣調査に従う）。無ければ新規作成。
3. 純粋関数として書き出す。隠れた入力（インスタンス変数・モジュール変数・時刻・乱数）はすべて **引数** として明示的に受け取る。これがテスト可能性の肝。
   - **引数化の前に、各隠れた入力の型を LSP `hover` で確定してから引数の型を書く（このスキルで最も精度が効く一手）。** 当てずっぽうで `any` を入れない。`hover` が `any`／未解決を返すときは deps/index 不足を疑い（§0）、確定できなければ最小の構造型に留め、その旨をコメントで残す。
   - **接合面の型は関心を表現させる**: 検証を含む抽出単位は検証済みの型を返す（parse, don't validate）。裸の `as` キャストで層を繋がない。同型プリミティブが並ぶなら union / オブジェクトで区別する（`design-principles.md` 2-(e)。流儀はコードベースに合わせ、新基盤は持ち込まない）。
4. 元のメソッドの該当箇所を新関数の呼び出しに置き換える。元のメソッドは「調整役」として薄く残る。
5. 参照・型を更新する（ts-morph / Serena）。
6. その純粋関数の単体テストを書く（モック不要のはず。要るならまだ純粋でない）。
7. 型チェック＋テストで等価性を確認する。

## 5. Sprout（既存に触らず芽吹かせる）の手順

既存が巨大・高リスク、または新規ロジックの追加のとき。

1. 新しい責務を独立モジュール（関数 or クラス）として新規ファイルに書く。最初からテスト可能な形（依存は注入、純粋ロジックは純粋に）にする。
2. 新モジュールに単体テストを書き、先に green にする。
3. 既存コードからは **最小限の呼び出し 1 箇所** だけ追加して繋ぐ。既存メソッドの中身は分解しない。
4. 既存の振る舞いが変わっていないことを確認する。

Sprout の狙いは「既存の厚いコードを安全に分解する余裕がなくても、新しい部分だけはテスト可能に保つ」こと。既存への侵襲がほぼゼロで済む。

## 6. テストを書く

- 近隣調査で確定したフレームワーク・配置・命名に従う。
- 純粋関数は入出力の表（正常系・境界・異常系）で素直にテストする。モックは不要なはず。
- 依存を注入する単位は、依存をテストダブルに差し替えてテストする（プロジェクトのモック流儀に合わせる。Jest なら `jest.mock` / `jest.Mocked<T>` / `mockResolvedValue`、vitest なら `vi.mock` / `vi.fn` / `mockResolvedValue` 等。**どちらの FW かは近隣調査で確定する**）。
- 具体的な before→after とテスト例は `extraction-patterns.md` を参照。

## 7. 検証と報告

切り出しとテスト作成が済んだら、**まず §7a の自己検証ゲートで「作った構成が本当にテスト可能か」を機械照合**し、その後 §7b で型・テストを実行して報告する。

### 7a. 抽出後の自己検証ゲート（extraction_verify）— 型・テストの前に構造を機械照合

事前の自己評価ゲート（`testability_inventory`）は「**どう割るかの意思決定**」だった。この 7a は「**割った結果が実際にテスト可能な構成になったか**」を、AI の自己申告でなく **機械で答え合わせ**する事後ゲート。散文で「テスト可能にした」と述べず、**単位ごとの PASS/WARN/FAIL 表**（`extraction_verify`）を出す。表を出すこと自体がゲート通過の証跡。

抽出が無いターン（設定・ドキュメントのみ等）は「抽出後検証 不要（理由）」の 1 行でスキップしてよい。

機械照合部はスクリプトで回す:

```bash
python3 ~/.claude/skills/extract-testable-module/scripts/verify-extraction.py \
  --source <抽出元file> --module <抽出先file> --symbol <抽出シンボル> \
  --test <抽出単位のtestfile> [--pure]   # 純粋ロジックと裁定した単位は --pure
```

**構造 FAIL（1 つでもあれば、型/テストが緑でも「完了」と言わず手順へ戻す）:**

- **完全移動**: 抽出シンボルの定義が元ファイルに残っていない（残骸=二重定義でない）。
- **直接 import/配線**: 元の呼び出し側が新モジュールから import して実際に呼んでいる（移したが未配線でない）。
- **純粋 → モック 0**: 「純粋ロジック」と裁定した単位のテストがモック/スパイ 0 で成立している。純粋のはずがモックを要したら**割る境界を間違えた**証拠。
- **export-as-private でない**: private を public にしただけ／内部分岐をそのまま export しただけで「テスト可能にした」と称していない（抽出先が単一の関心の独立単位になっている）。
- **等価性（§7b）**: `tsc` green ＋ 対象パッケージのテスト green（下記 §7b で実行）。
- **明白な無意味テストでない**: `tautology-test-detector` の prefilter で候補が出たら同スキルで adjudicate し、トートロジー/mock-only を排除。
- **micro-mutation（条件付き）**: 「純粋」かつ上記 tautology を通過した単位に限り、`--list-mutations` が挙げる**決定的な 1 点変異**（比較演算子反転・境界±1・真偽反転）を 1 つずつ適用し、書いた新テストが**赤化するか**を確認する。少なくとも 1 点で赤化しなければテストが空＝FAIL。適用→再実行→revert は手続きで回す（スクリプトは変異点の列挙のみ＝恣意的な変異を防ぐ）。

  ```bash
  python3 ~/.claude/skills/extract-testable-module/scripts/verify-extraction.py --list-mutations --module <抽出先file> --symbol <シンボル>
  ```

**WARN（記録するが blocking でない。§7a の表に残し、当たっていれば処方を検討）:** Eager Test（1 テストが多くの production を叩く＝責務未分割の疑い）／「純粋」単位への副作用の痕跡／**W3 裸の `as` キャスト**（検証せず型を宣言＝parse, don't validate 違反の疑い。type guard / parse で絞る）／**W4 非 pure 単位の依存内部生成**（`new XxxClient`・`process.env`・axios/SDK 直 import ＝注入不能でモック不可。コンストラクタ/引数注入へ）／**W5 命名**（generic bucket 名のモジュール〔utils/helpers 等〕・And/Then 複合のシンボル名＝雑多寄せ場・多責務の疑い。責務を一文で言い当てる名前へ）／抽出後も過大な単位。

**判定不能（UNVERIFIED）**: ファイルが読めない・ツール不在等で機械判定できないときは、**PASS でも FAIL でもなく UNVERIFIED（=要手動確認）**として表に残す。黙って PASS にして compliance theater にしない。逆に一律 FAIL で過剰ブロックもしない。

**自己成長（self-oracle）**: 上の**機械確定シグナル由来の FAIL** が、事前 `testability_inventory` の**見落とし**だった（抽出したのにモックが要った／mutant が生き残った／残骸があった 等）ときは、それを反省材料として `cases.jsonl` に self-missed case を 1 行記録する:

```jsonl
{"date":"YYYY-MM-DD","area":"<area>","path":"<file>","kind":"missed","stage":"case","lens":"self","who":"self-verify","signal":"F3-mock-nonzero","title":"pure claim but test needed mocks"}
```

- **必ず `stage:"case"` 固定**。self-case を lens へ自動追記・自動昇格しない（**自己参照汚染の防止**＝自分の採点で自分のルールを勝手に増やさない）。provisional/stable への昇格は `/extract-testable-retro` で**人間の承認を経てのみ**。
- **matched（緑通過）は自動記録しない**（成功事例の自動蓄積でノイズ/暴走させない）。
- **dedupe**: 同一 `path`＋`signal` に既存 self-case があれば再記録しない（`cases.jsonl` 膨張の歯止め）。
- 主観判断（「筋が悪い」等）は self-case にしない＝機械確定シグナル由来のみ。主観の学習は従来どおり人間オラクル専任。

### 7b. 型・テスト実行と報告

- **型チェック**: プロジェクトの方法で（例: `pnpm --filter <pkg> exec tsc --noEmit`、または `pnpm build`）。
- **テスト**: 対象パッケージのテストを実行し green を確認（例: `pnpm --filter <pkg> test -- <path>`）。
- 落ちたら原因を直す。「テストを書いた」だけで終わらせず、必ず通るところまでやる。
- 既存テストがあれば、それも引き続き green であることを確認する（挙動不変の証拠）。
- **実行不能な環境（deps 未インストールの worktree / サンドボックス / 実ファイルが無い評価のみ 等）では `green` を詐称しない。**「green を確認せず『できました』と言わない」の趣旨は「**実行できるのに確認しない**」の禁止であり、実行不能なのに green と偽るのも同じく違反。実行できないときは「未実行（理由）」と明記し、代わりに**等価性の根拠**（抽出は元式と論理等価／隠れた入力を引数化しただけ／型が通る見込み 等）を残す。実行可能になった時点（`pnpm install` 後など）に必ず走らせる。

報告に必ず含める:

- 触ったファイルの一覧（追加・変更を分けて）— 侵襲が最小に収まったことを示す
- 切り出した単位の名前・置き場所・選んだ技法（Extract / Sprout）と、その理由（特に侵襲と凝集度の判断）
- 追加したテストと実行結果（green であること）
- 等価性の根拠（既存テストが通る／型が通る）

## モノレポでの注意

- テスト・型チェックは対象パッケージの文脈で実行する（ルートからの実行は解決に失敗することがある）。
- import パスはパッケージのエクスポート規約（`@yourorg/...` 等のエイリアス、`package.json` の exports）に従う。新規ファイルが公開境界に関わるなら index の再エクスポートも確認する。
