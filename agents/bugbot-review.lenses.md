# bugbot-review 観点集（lenses）

`bugbot-review` エージェントが**レビュー時に読む唯一の観点ソース**。各観点は
**観点（何を見るか）/ 範囲（どこを）/ 目線（守る実害）/ 検出（どう見つけるか）** のユニットで持つ。

- これは「ケースの山」ではなく、過去傾向を**蒸留した有界な観点**。エージェントはこの集合だけを読む（コンテキスト一定）。
- **上限の目安 30 観点**。超過 or 定期で**統合**（近接マージ・陳腐化剪定・安定したものは core `bugbot-review.md` へ昇格）。
- 生のケース履歴は別ファイル（`bugbot-review.cases.jsonl`。プロジェクトごとに retro で育てる学習データで、初期状態では存在しない）に退避し、**ここには溜めない**。
- 目線（実害カテゴリ）= `security / correctness / performance / UX / 保守性`。**保守性のみのもの**は actionable 度が低い（実害ゲートで「参考」に落ちやすい）。
- 初版シード: 元プロジェクト（TypeScript monorepo SaaS）の Cursor Bugbot 過去指摘 **約 2,000 件 / 約 400 PR** の傾向分析（14 カテゴリ＋ホットスポット＋重大度分布）。導入先プロジェクトでは retro で観点を入れ替えて育てる。
- **security 観点の二重学習回避**: L1/L2/L7/L16 は security 棚 `hahifuhe-security-reviewer.lenses.md`（S*）と関心が重なる。`/review-retro` は機械的 security をこの L* に、人間由来の設計/運用/ヘッダ系 security を S* に振り分ける。同一観点を両方に育てない（既出ならもう片方に重複追加しない）。

---

## 実害が出やすい観点（High 偏重・最優先）

### L1. ハードコードされた秘密・認証情報・トークン
- 範囲: `*.http` / `.env*` / `*.sh`(デプロイ) / CDK 設定 / テストスクリプト
- 目線: security
- 検出: 実トークン/パスワード/ID の直書き。「別ファイル(例 sandbox.ts)と一致必須」コメント付きの直書き値もドリフトとして指摘。

### L2. 認可・スコープ漏れ / SSRF / CORS / インジェクション
- 範囲: API ハンドラ・route・webhook 転送・ユーザ入力 URL の fetch
- 目線: security
- 検出: workspace/organization をまたぐ参照の scope チェック有無、ユーザ URL fetch の再検証、CORS `*`、文字列補間 SQL。

### L3. マイグレーション安全性
- 範囲: `packages/data-access` の migration / schema（Drizzle）
- 目線: correctness（マイグレ失敗・データ不整合）
- 検出: 既存テーブルへの NOT NULL 無デフォルト追加、FK/relation 欠落・設計乖離、冪等性(`ON CONFLICT`/`NOT EXISTS`)欠落、`enumValues[0]` ハードコード、baseline 改変による checksum 不一致。

### L4. null/undefined ガード漏れ
- 範囲: API/クエリ結果・配列要素・optional prop を使う箇所
- 目線: correctness（実行時クラッシュ）
- 検出: ガード前の `array[0]`/optional 参照、空配列への `Math.max`、空文字が null チェックをすり抜け、catch 節での null 使用。**`x ?? fallback` は空文字 `''` を弾かず fallback しない**——DB値/デフォルトへのフォールバックや「未指定なら既存値」系で、入力が `''`（API 非返却フィールドの `?? ''` 正規化や空フォーム値）だとフォールバックが破れる。フォールバック判定は `??` でなく空文字も「無し」とみなす形（`x?.length ? x : fallback` / `x || fallback`）か確認。（過去レビューの実例で Missed→蒸留）
- **型が `string` でも油断しない（型の嘘）**: 値の静的型が非 null（`string`）でも、出所が `any`（例: untyped な API hook の返り値）や外部 API で、**API 契約上は nullable**（生成型 `string | null`）なら、実行時に null が混入し `.trim()`/`.toLowerCase()` 等の string メソッドで TypeError クラッシュする。型だけ見て安全と判断せず、API 契約（生成型・OpenAPI）の nullable を一次確認し、`x?.trim()` / 事前ガードがあるか見る。型ベースのレビュー（diff/型のみ）はこの型の嘘を素通りするので特に注意。（過去レビューの実例で Missed→蒸留: any 由来の設定値に直接 `.trim()` を呼び、当該設定が未登録のアカウントで設定画面がクラッシュ）

---

## 件数最多・cross-file 推論が要る観点

### L5. 関数シグネチャ変更時の呼び出し側不整合
- 範囲: service / repository / hooks（引数の数・順序・型を変えた箇所）
- 目線: correctness
- 検出: シグネチャ変更を見たら**全呼び出し側**を `find_referencing_symbols` / LSP `incomingCalls` で照合。

### L6. 条件・分岐ロジックの誤り
- 範囲: 全レイヤ
- 目線: correctness
- 検出: 条件反転・誤演算子、off-by-one、配列インデックス不整合、switch の `break` 漏れ、時刻変換(JST/UTC・うるう年)、演算子優先順位。

### L7. FE↔BE バリデーション乖離
- 範囲: フロント(yup 等) ↔ バックエンド検証（API サーバ側）
- 目線: correctness / security（不正データ保存）
- 検出: 必須・上限・プレフィックス処理(`gtm.*`/`custom_event` 等)の不一致、**直 API で不正値が保存できないか**、NaN/Infinity/負値のすり抜け。

### L8. 非同期・競合・トランザクション順序
- 範囲: 二重送信、外部 API 送信↔DB 保存、SQS/冪等性、setTimeout/rAF
- 目線: correctness（二重配信・部分 INSERT・stale）
- 検出: await 漏れ、送信後 DB 失敗で二重配信、冪等性のテナント非限定/遷移より後、stale closure。**[FIFO producer の正しさ]** FIFO キューへ送る producer/seam で、(a) builder が組んだ `MessageGroupId`/`MessageDeduplicationId` が実際に `SendMessageCommand` へ渡っているか（send 実装や型が `MessageAttributes` だけ受け取り group/dedup id を落としていないか＝FIFO は GroupId 必須で送信が必ず失敗。seam/ラッパーの「組み立て」と「送信」の間で欠落しやすい）、(b) 同一メッセージを**複数の enqueue 経路**（分岐した branch・複数 handler 等）で出すとき、冪等キー(dedup/group id)の**構成元(batchId 等)を経路間で統一**しているか（一方が L2 のみ・他方が `event ?? L2` のように源がズレると、タイミング次第で dedup キー不一致→二重 enqueue）。（過去レビューの実例で Missed→蒸留）**[再実行 producer の冪等性]** 同一エンティティ(workflow 等)を再起動/再配信しうる producer で、(c) admit/ensure 系メソッドの戻り値を enqueue/再処理ゲートに使うとき、その戻り値が**終端状態(COMPLETED/WAITING/PAUSED 等)でも true を返す**仕様でないか（"処理続行可"の admit 戻り値を"新規作成できた"と取り違えると終端対象へ二重送信。新規作成時のみ true を返す専用関数（＋`if(!created)continue`）を使う）、(d) 永続集約カウンタ(`completedUsers`/`errorCount` 等、エンティティ ID 一意で永続する集計)を**新 run 用に 0 リセット**しているか（既存の run セットアップ処理（runId 採番+全カウンタリセット）との**非対称**を疑う。リセット漏れだと再配信時に過去値が残り completionRate/自動停止の誤判定）。（過去レビューの実例 round-2 で Missed→蒸留）

### L9. React 状態同期 / hooks
- 範囲: フロントエンドアプリ（特に状態の多いエディタ系 UI）
- 目線: UX / correctness（表示と実値の乖離・無限ループ）
- 検出: props/atom の外部更新に local state が追従しない、保存成功後の初期値未更新、useEffect 依存配列、controlled/uncontrolled、Undo/Redo は**ガード後に** snapshot。

---

## 軽め（lint で取れる分は委譲）

### L10. エラーハンドリング
- 範囲: ループ内処理・catch・API エラー応答
- 目線: correctness / security
- 検出: ループ内 try-catch で 1 件失敗が全件巻き込み、握り潰し、内部エラーのクライアント漏洩、誤解を招くエラーメッセージ。

### L11. パフォーマンス / リソース
- 範囲: 全件取得・クライアント生成・Object URL
- 目線: performance
- 検出: メモリリーク(未解放)、無制限の全件取得、リクエスト毎のクライアント生成、N+1。

### L12. 設定・インフラ・CI
- 範囲: env / CDK / GitHub Actions / Dockerfile
- 目線: correctness（デプロイ破壊・環境不整合）
- 検出: retention 等のハードコード(設定値を使う)、env 名/ドメインの CDK 不整合、checkout 漏れ・reusable/uses 誤用・トリガー誤り。**[cross-stack リソース移設の物理名据え置き]** CDK 構成変更でリソース(Lambda/IAM role/LogGroup 等)を別 Stack へ移設する際、`generateLambdaFunctionName` 等の明示物理名を据え置くと、`cdk deploy --all` の並行更新で新 Stack の CREATE が旧 Stack の DELETE に先行し「リソース既存」で失敗しうる。移設時は物理名を変える(例: queue を `.fifo` で改名=非衝突)／deploy 順序を担保(`addDependency` 等)／運用手順を OQ 記録、のいずれかがあるか確認。（過去レビューの実例 Missed→蒸留）**[FIFO SQS の visibility 不変条件]** FIFO キュー + consumer Lambda を新設/変更する際、`visibilityTimeout >= consumer Lambda timeout × 1.5` の不変条件を construct 起動時に assert しているか(既存の同型 construct に同種 assert があるなら対称か)。未検証だと誤設定で visibility 切れ→同 MessageGroupId 二重 invocation→順序破壊/二重処理。（過去レビューの実例 Missed→蒸留）

### L13. i18n / 文言 / UX 表記
- 範囲: `locales` / ラベル
- 目線: UX
- 検出: 翻訳キー未定義/重複、ハードコード日本語、ラベル不整合。

### L14. 後始末（dead code / 残骸）
- 範囲: 変更ファイル全般
- 目線: 保守性（実害は低）
- 検出: `console.log`/デバッグ残骸、未使用 export、重複コード、一時ファイル混入。**※ format/import 順/命名は Biome lint の責務＝対象外**。

### L15. 楽観的 UI 更新の失敗時収束 / UI 一時状態の表示ゲート混入
- 範囲: フロントエンドアプリ（mutation を伴うトグル・フォーム。保存/ローディング状態を持つ UI）
- 目線: correctness / UX（表示とサーバ実値の乖離・誤った訴求表示）
- 検出: ①mutation 失敗時の楽観更新の戻しが、リモート副作用の成否を区別せず一律 revert（成功済みなのに旧値へ戻す）or 一律据え置き（未反映なのに新値が stuck）になっていないか → 失敗時は **refetch した実値へ収束**させ、passive な sync ゲートに依存しない。②`isSaving`/`isLoading`/`isPending` 等の**一時状態フラグ**を、本来は別条件（連携状態など恒久ゲート）で出し分けるべき表示ロジック（caption/notice/disabled 表示）へ混入させていないか（保存中だけ別文言が誤表示）。

### L16. ローカル専用 env/secret/scaffold の誤コミット
- 範囲: リポジトリ追加ファイル全般（特に `.env*`, `*.local`, worktree/個人用 env・compose・seed・スクリプト）
- 目線: security（秘密漏洩）/ 保守性
- 検出: `.env.secrets.local` 等のローカル専用ファイルが `.gitignore` 漏れで tracked・PR diff に乗っていないか。中身に実 secret/接続文字列があれば High 相当（push 済みなら履歴スクラブ＋ローテーション検討）。機能と無関係な個人開発用雛形の混入も指摘。※source 内ハードコード秘密は L1。

### L17. 複数の書き込み経路（トランスポート/builder）の一方に新フィールド伝播漏れ
- 範囲: フロントエンドの API 呼び出し層（複数トランスポート（例: REST ↔ RPC）を分岐する hook、入力 builder）、および同一更新を複数経路で実装している箇所
- 目線: correctness / UX（保存が無言で効かない・成功表示なのに反映されない）
- 検出: 新規フィールド（例: トグルの新設定フラグ）を追加したとき、PUT body 等の主経路だけに載せて**別トランスポート/別 builder 経路へ写し漏れ**ていないか。トランスポート切替フラグ（env/ビルドフラグ）で経路が切り替わる場合、フラグ ON 構成で送信されず成功表示のまま未反映になる（条件付きでも実害あり）。フィールド追加 PR では「この値を運ぶ経路は何本あるか」を数え、全経路に伝播しているか確認。（過去レビューの実例で Missed→蒸留）

### L18. 副作用を持つ事前チェックを、早期 return すべきゲートより前に eager 実行（read-only であるべき判定器が状態を変える）
- 範囲: 同期 validator / 門番(gatekeeper) / preflight ハンドラ。判定を pure 関数に集約しつつ、その入力（canStart 結果・対象取得等）を呼び出し側 handler が**ゲート前に一括 await**する構造。
- 目線: correctness（対象外入力の状態破壊）/ security（テナント/種別越境での副作用）
- 検出: pure 判定関数が「(A 種別/前提) → (B 副作用ありの可否) → …」の順で弾く設計でも、**handler が A の前に B を await していないか**＝早期 return すべき最初のゲート(種別 kind・前提不一致)を IO の前に handler 側でも短絡しているか。呼ぶ関数が本当に read-only か一次確認（`completeIfExpired`/`terminate`/`cleanup`/status 遷移など書き込みを含まないか）。pure 関数内の評価順が正しくても、handler が副作用 IO を eager に集めると意味がない。「この門番/validator は対象外入力に対して 1 バイトも書かないか」を問う。（過去レビューの実例で Missed→蒸留: 特定種別専用の門番が対象外の kind を弾く前に副作用持ち canStart() を実行していた）

### L19. 共有 UI コンポーネントの既定 prop/外観の変更が、prop 未指定の全既存呼び出し元へ波及
- 範囲: フロントエンドの共有入力/表示コンポーネント（`components/inputs/*` 等、複数画面から使い回されるもの）。default variant・既定 prop・「prop 未指定時に入る分岐」を変えた diff。
- 目線: UX / correctness（既存画面の見た目・入力体裁・挙動が意図せず変わる後方互換欠落）
- 検出: 共有コンポーネントの**既定挙動**（default の外観 variant・未指定時の分岐・既定 prop 値）を変えたら、その prop を**渡していない**全既存呼び出し元の表示/体裁/挙動が変わる。型は通る（コンパイル緑）ので diff/型だけでは素通りする。`find_referencing_symbols` / LSP `incomingCalls` で**全 caller を洗い**、旧挙動に依存している箇所が壊れないか確認。後方互換を壊す変更は、新挙動を**opt-in prop でゲート**（既定は旧挙動）しているか。L5（関数シグネチャ変更→全呼び出し側）の UI 版。（過去レビューの実例, cursor[bot] Medium で Missed→蒸留: SelectBox を outlined→filled に全 caller 一括変更→後続 PR で `filled` opt-in 化した際、既定側の後方互換欠落を bot が指摘）

### L20. JSX で明示 prop の直後に `{...rest}` を展開すると、呼び出し側の同名 prop が明示値を上書きする
- 範囲: props を受け取り子コンポーネントへ**明示 prop ＋ `{...rest}`（残り props スプレッド）** を渡すラッパー/共有コンポーネント。
- 目線: correctness / UX（整形済み・必須マーク付き値が表示されない／意図した明示値が無言で消える）
- 検出: `<Child label={displayLabel} {...rest} />` の形で、`rest` に同名キー（`label` 等）が含まれると**後勝ち**で `displayLabel` が上書きされる（JSX/オブジェクトスプレッドは後の指定が勝つ）。明示値を優先したいなら **`{...rest}` の後に明示 prop を置く**か、`rest` から当該キーを除いてから展開する。逆に呼び出し側の上書きを許したい設計なら意図的か確認。（過去レビューの実例, cursor[bot] Low で Missed→蒸留: SelectBox の `!filled` 分岐で `label={displayLabel}` の後に `{...rest}` 展開）

### L21. 新設した不変条件（終端 status 等）のガード入口列挙漏れ — 非 CRUD の副作用入口を落とす
- 範囲: 不変条件（「ARCHIVED は複製のみ可」等）を新設する PR の、対象エンティティへ副作用を及ぼす**全入口**（REST route・RPC メソッド・バッチ/エンジン command に加え、**test-delivery / 複製 / export / run 等の非 CRUD 間接実行系**）
- 目線: correctness / security（終端・保護対象への操作すり抜け）
- 検出: 不変条件ガードを追加した diff を見たら、対象エンティティに書き込み/実行の副作用を持つエンドポイントを **route/service 定義から機械列挙**して「ガード適用の有無」を表で突き合わせる。CRUD（update/delete）＋状態遷移（suspend/activate/revert/run）で列挙を止めない。トランスポート別（REST/RPC/エンジン command）の対称も同時に検査。（過去レビューの実例: cursor[bot] が終端 status エンティティのテスト配信・管理系実行入口のガード漏れを指摘、当方 Missed→蒸留）

### L22. status 集合ベースの新設防御が「離脱遷移」で無効化される（既存遷移 × 新設ゲートの合成は PR 由来）
- 範囲: status 集合で判定する新設のゲート/フィルタ（webhook 配信ゲート・一覧フィルタ・計測可否）と、そのゲート対象 status から**他 status へ抜けられる既存遷移**（suspend/activate/revert 等）
- 目線: correctness（防御の迂回・計測/リダイレクトの誤再開・要件矛盾）
- 検出: 「status ∈ {A,B} なら遮断」型の防御を新設した PR では、A/B から抜ける全遷移を列挙し、**遷移後にその防御が外れてよいか**を要件と突き合わせる（実例: ERROR→suspend→SUSPENDED で「ERROR は公開終了」の webhook ゲートが外れ redirect/inview 計測が再開）。離脱遷移自体が base 既存でも、**新設ゲートとの合成帰結は PR 由来**として「既存・非悪化」による severity 降格をしない（Verify の降格判定にもこの角度を適用）。（過去レビューの実例: cursor[bot] 指摘・当方 Verify が「既存・非悪化」で誤降格→蒸留）


### L23. レビュー往復で入った同型修正・新設防御の「横展開漏れ」（統一を謳う fix の残存経路）
- 範囲: レビュー指摘対応コミットが「統一/一本化/全経路に適用」を謳う diff。同 PR 内で導入された防御的設定（timeout/リトライ/実行時検証）と同型の資源生成箇所（SQS/HTTP クライアント・handler 群・resolver 呼び出し元）
- 目線: correctness / 可用性（1 経路だけ旧挙動が残り、修正済みのはずのバグが局所再発する）
- 検出: (a) 「統一」「一本化」を謳う修正では、同型経路（同じ repository/resolver を使う handler 群）を独立に機械列挙し、旧 API の残存呼び出しを `git grep <旧関数名> <headSha>` で探す（実例: 更新系の解決処理を TX 内の専用 resolver に統一後も、1 つの handler だけ TX 外の旧 finder 直呼びが残存）。(b) 同 PR 内で防御設定（`requestTimeout` 等）が入ったクライアント生成があるとき、同型の生成箇所（`new SQSClient` 等）を全 grep して非対称を探す（実例: 一方のサービスのキュー送信に timeout 追加後も、別サービスの同型クライアント生成は無設定のまま）。(c) 過去 round で「取り残し」が指摘された経路・ファイルは、次の同型修正でも最優先で再確認する（同一 PR 内で同じ経路が 2 度取り残された実例）。修正コミットのメッセージが主張する適用範囲を鵜呑みにせず、適用先を自分で数える。（過去レビューの実例, cursor[bot] Medium×2 で Missed→蒸留）

### L24. 全フィールド optional の更新スキーマ ＋ 無条件 UPDATE ＝「何も届いていない更新」が 200 success を返し副作用だけ残す
- 範囲: 更新系エンドポイント（PUT/PATCH）のうち、リクエストボディのスキーマが**全フィールド `.optional()`** のもの。特に validator がボディを読めなかったときに `{}` を注入する実装（Content-Type ヘッダ欠落・空ボディで hono/zod validator が素通りする経路）。
- 目線: correctness / UX（クライアントは更新成功と受け取るのに値は反映されず、`updatedAt` だけ前進して監査ログ・楽観ロック・並び順が汚れる）
- 検出: (a) 更新スキーマの全フィールドが optional なら、**空オブジェクトがスキーマを通過する**ことをまず確定させる。(b) その先の repository/service に「更新対象フィールドが 1 つも無ければ早期 return」があるか読む。無く `updatedAt: new Date()` を無条件に含む UPDATE を発行しているなら成立。(c) 再現の入口は Content-Type 欠落・空ボディ・`{}` 送信の 3 通りを試す（他エンドポイントが 400/415 を返す中でここだけ 200 という**外形の非対称**が手掛かり）。(d) API 移行 PR では移行元の挙動（旧トランスポートが Content-Type 不正を 415 で拒否していた等）と突き合わせ、挙動差分を台帳管理しているプロジェクトなら登録済みかまで確認する。（過去レビューの実例: 移行 PR で唯一の実挙動差分として他レビュアーが検出、当方 Missed→蒸留）
