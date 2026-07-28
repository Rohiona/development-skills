# 学習観点（領域: api-clients）— 外部 API / SDK ラッパ

対象: area-map で `api-clients` に対応付けたパス（記入例: `packages/<共有pkg>/**/client/**`, `**/*Client.ts`）。
この領域での **置き場所・命名・テスト慣習** に即した責務設計の具体化。全領域共通の枠は `../learned-lenses.global.md`。

- lens ユニットは 5枠（観点/対象/兆候/処方/反例）。**反例必須**。provenance は `cases.jsonl` へ（ここに具体ファイル名を書かない）。
- 上限の目安 8 観点。

---

### AC1. API Client の private に埋もれる純粋ロジックを module 関数へ剥がす

- **観点**: 「API Client だから private が多いのは当然」で流さない。Client の private には実は**純粋ロジック**——リクエストボディ/クエリの組立、レスポンスの解析・整形、エラーコードの写像、ページングカーソルの計算——が埋もれやすい。これらは Client クラスの外（同領域の純関数モジュール）へ抽出し、**HTTP クライアントをモックせずに**テストする。Client 本体には「実際に投げる薄いメソッド」だけ残す。
- **対象**: HTTP/SDK ラッパクラス。private が多く、本体に組立/解析/写像/分岐がある。
- **兆候**: private を1件ずつ見ると、HTTP を実際に呼ぶのはごく一部で、残りは入出力の変換・検証・判定。テストを書こうとすると HTTP クライアント全体をモックしないと純粋ロジックすら検証できない。
- **処方**: 組立/解析/写像/ページング計算を `(buildXxxRequest / parseXxxResponse / mapXxxError)` のような純関数へ Extract し、Client 近傍に置いて co-location でテスト。Client メソッドは「組立→送信→解析」を薄く配線するだけにする。
- **反例**: 認証ヘッダ付与・baseURL 連結のような1行委譲、あるいは SDK をそのまま1コール呼ぶだけの薄いメソッドは、純粋ロジックを含まないので据え置き（剥がすと pass-through が増えるだけ）。
