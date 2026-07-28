# rationale — 設計判断の履歴・実例・却下案（保守用。実行時には読まない）

> このファイルは autonomous-dev の「なぜこの形か」の記録。run 中のどのフェーズもこれを読まない。
> スキルを改訂する人（人間 or AI）だけが読む。実行手順の正本は `pipeline.md`。

## 2026-07-03 大規模再編（v3）: SSoT 化＋下流の Workflow 隔離

- **問題**: 指示文 86KB（SKILL.md 19.6KB 含む）が run 中メイン文脈に載り、同じポリシーが 3〜6 箇所に重複記載・フェーズ番号が相互矛盾（0,1,1.5,2〜7,9 の欠番/ズレ、loop-safety の「収束ループ #5→#6→#7」が実表と不一致）。レビュー工程（旧雛形3）は review-all.js の劣化再実装だった。
- **決定**: 各ポリシーは1ファイルにだけ書く（SSoT）。フェーズ番号を廃止しステージ名で統一。下流（実装→ゲート→レビュー→修正→再検証）を `~/.claude/workflows/autodev-downstream.js` に隔離し、ループ安全装置（上限・同一エラー・増加検知）は散文でなくコードの while 文へ。レビューは既存 `review-all.js` を子 Workflow として呼ぶ（7観点＋Codex・所見ファイル永続化・メインには判定のみ）。
- **旧構成の置き場**: hahifuhe-invocation.md → pipeline.md へ統合 / subagent-prompts.md（雛形1〜4）→ Workflow スクリプト内 prompt へ移動 / escalation.md＋loop-safety.md → guards.md / bucket-schema.md → bucket.sh ヘッダ＋pipeline.md 短節 / cursor-handoff.sh（AppleScript PoC・非推奨）→ 削除。
- **スパイク実測（2026-07-03）**: Workflow の agent() 内 Bash から `cursor agent status` と headless 実行（`-p --trust`）が権限プロンプトなしで完走 → implBackend='cursor' を既定にできた。

## なぜレビューを review-all.js に一本化したか（旧雛形3 の廃止）

- 旧雛形3（conformance/impact/quality を Task 並列→メインが統合）が書かれた当時、review-all は**対話版しか無く**、内部に人間確認 Phase を持つため丸投げできなかった。構造だけ真似る判断は当時は正しかった。
- その後、背景 Workflow 版 `review-all.js` が完成（観点 7＋Codex 二次意見・lens routing・所見ファイル永続化・判定サマリーのみ返却）し、コピーを正当化していた理由が消滅。二重実装は観点の乖離（security/テスト健全性が旧雛形3 に無い）とトークン浪費（findings 全文がメイン文脈へ）だけを生む。
- 仮想 Bugbot 並走・実害ゲートも review-all.js に内包済み。

## なぜ設計レビューの独立エージェントゲートを復活させないか

- 設計の品質ゲートは**プランモードでの人間収束**（Claude ↔ 閣下のバッチ Q&A で本質的分岐を潰す）。設計レビューが見る構造層は実装後 review-all の部分集合であり、独立ゲートは二度手間。
- 設計書は「合意した高度まで」を authoring し（altitude 規律）、実装で揺れる細部は書かず reconcile ステージで最終コードと突き合わせる。「設計→実装で破綻→書き直し」の二度手間を避けるため。

## 2層の不可逆性の住み分け

- 構造的・不可逆（DB スキーマ形・API/メッセージ契約・キュー/worker トポロジ・結合方針）→ **設計のプランモードで人間と先に固める**（型/test が緑でも後戻りが極端。例: 将来 2 段階デプロイを強いる結合）。
- 振る舞いの不可逆（本番パス非侵襲・後方互換・回帰ゼロ）→ **requirements の受け入れ条件（テスト可能な形）＋客観ゲート**で守る。

## ADR の住所分担（why コメント規律）

① 該当コード直近の短い why コメント（不変条件＋一行理由。例 `// worker側に分岐。API 直接 invoke は本番経路不可侵のため不可(AC-6)`）② 却下案・詳細 rationale → 設計書の DD ③ 不変条件そのもの → requirements の AC。コードに残すのは①だけ。PR を作る段で任意に `pr-inline-adr` 掲示可。

## Cursor 委譲まわりの経緯

- 2026-06-10: 実装バックエンドとして opt-in から**既定へ昇格**（閣下の決定）。狙いは実装の反復ループ（読込→編集→テスト→失敗ログ→再編集）を Cursor 側コンテキストへ逃がし、Claude セッションのトークン/寿命を守ること。検証は自パイプラインのゲートが担う（Cursor の自己申告は鵜呑みにしない）。
- 実走検証済みの事実: `cursor agent -p` は `~/.claude/skills` 等を available_skills として自動集約（事前登録不要）。`-w <name>` で `~/.cursor/worktrees/<repo>/<name>` に隔離。`--force` は承認ゲートを切る操作なので run 開始時に閣下の明示許可を一度取る（分類器が明示許可なしを拒否するのも実測済み）。
- 一般規則の正本は `~/.claude/references/cursor-delegation.md`。本スキル固有の受け渡しテンプレは autodev-downstream.js の Implement プロンプト内。

## サブエージェント経路の教訓（iter-1 実走）

- `subagent_type: "hahifuhe-implementer"` は「tool call could not be parsed」で init 失敗 → 既定は general-purpose ＋ playbook 追従。俺様への忠実さは「同じ playbook・同じ成果物配置」で担保され、起動経路には依存しない。
- 俺様の agent/command は内部に人間承認を前提とした手順を持つ（例: fix-build-errors「ユーザー承認なしで一括修正しない」、hahifuhe-implementer Phase2「テスト戦略をユーザーと合意」）。自走文脈では**自走モード上書き＋NEEDS_HUMAN 返却プロトコル**で置き換える（現在は Workflow プロンプトに内蔵）。

## 実装規律を必須にした実害の実例

- `verify-reuse-boundary` を省いた場合: 「同じはず」が実は別物だった実例 = コメント返信 API ≠ 通常 DM API / DB レコード型 ≠ ドメインモデル型。未検証の境界の上に実装を積むと後段レビューで手戻り。
- `extract-testable-module` を省いた場合: 本スキル初回実走で Major「テスト不在」を後出しで指摘された（先回りで防げた損失）。

## 既存エラーのマスク設計（2026-07-03 発見）

- クリーンな既定ブランチでも、あるパッケージの `tsc --noEmit` が既存エラー（当時の実測: 同一テストファイル起因の TS2532×7）で赤いことがある。素朴に「全 green まで修正ループ」すると**自分のせいでない既存エラーで詰む**。
- 決定: Workflow 側で typecheck の TS シグネチャのうち**変更ファイル外**のものをマスクし、警告として最終報告に載せる（黙殺しない）。テスト赤・check 赤はマスクしない（変更起因の可能性が高いため）。

## source-only パッケージの型検査（iter-1 で判明）

`pnpm build`（Turbo）は build スクリプトの無いパッケージ（server-core 等）を型検査しない。gate.sh all は影響パッケージ全てに `tsc --noEmit` を必ず回すため構造的に解消済み。

## 先送り（iter-4+）

- `verify`（組み込み）による動作検証ステージ: UI/挙動が観測可能な変更で reverify 後に任意実行する案。まず新構成の運用実績を作ってから。
- 複数機能の並走時の task-manager-sqlite 進捗ミラー / echo 以外への汎用化。
