# 実装タスクの Cursor 委譲 — 詳細正本

Global CLAUDE.md「実装タスクの Cursor 委譲」節から退避した詳細（2026-07-02 に CLAUDE.md ダイエットで移設）。
要点は CLAUDE.md 側に残し、既定値の理由・経緯・細則はここが正本。

## 役割分担と経緯

- 実装のみ Cursor ／ 設計・事実確認・検証点検（型・lint・test・ビルド・`/extract-testable-module`・`/tautology-test-detector`）は Claude（役割分担 2026-06-10、点検の Claude 一本化は 2026-06-16 閣下の決定）。
- サイズ分岐（2026-06-25 閣下の決定): 小さい編集に委譲仕様文を書くと逆に割高（トークン/コンテキスト浪費）になるため —
  - **小**（書き下す新規内容が概ね 40 行以下・単一ファイル・config/seed/wiring 等）= Serena/Edit 直（都度、直接にした理由を一言宣言）
  - **大**（多ファイル・込み入った実装・構造系リファクタ rename/delete/tsmorph）= Cursor 委譲
  - `~/.claude/hooks/cursor-delegation-enforce.py` で自動化済み（`SMALL_EDIT_MAX_LINES=40`。40 行以下は直接許可、超過・構造系はブロック→委譲。閾値は同フックで調整可）

## 起動コマンドと既定値の理由

**既定はラッパー `~/.claude/scripts/cursor-exec.sh` 経由**（2026-07-06 閣下の決定。codex-exec.sh と同系列）:

```bash
~/.claude/scripts/cursor-exec.sh 1800 -p --trust --force --workspace=<現worktree> --model composer-2.5 --output-format text "<実装依頼プロンプト>"
```

- 第1引数は timeout 秒。以降はそのまま `cursor agent` へ渡る（生コマンドと同じ引数体系）。
- ラッパーの責務: ①実行前に tracked＋untracked を `refs/cursor-snapshots/<ts>` へ自動スナップショット（作業ツリー・index 無変更）②timeout・stdin クローズ・tee ログ ③実行後に「消えたファイル」を即検知して警告＋復元コマンド提示 ④スナップショット ref は直近20件で自動整理。スナップショットが取れない場合は委譲自体を中止する（fail-closed）。
- 検証済み（2026-07-06）: 削除事故シミュレーションで未追跡ファイル含む検知・`git checkout <ref> -- <path>` での復元・正常系の3点を実測確認。
- 注意: `.gitignore` 対象のファイルはスナップショットに入らない。settings.json の allow ルールはプレフィックス一致のため、ラッパー経由の起動には `~/.claude/scripts/cursor-exec.sh` 向けの allow ルールが別途必要（未登録の間は都度確認になる）。

生コマンド（ラッパーが壊れた時のフォールバック用・従来形）:

```bash
cursor agent -p --trust --force --workspace=<現worktree> --model composer-2.5 --output-format text "<実装依頼プロンプト>"
```

生コマンドで起動した場合は、下の「未コミット成果の保護」を**手動で**実施すること。

- **作業場所の既定**: 今の worktree へ `--workspace=<現worktree>` で直接（2026-06-11 閣下の決定）。隔離 `-w` は「複数ブランチを汚さず並行で回す」等、隔離自体が目的のときだけ（隔離方式は遅くトークンも余計に食う）。
- **モデルの既定**: `--model composer-2.5` を明示指定（明示指定の方針 = 2026-06-11 閣下の決定。2026-07-10 コスト見直しで Fast 版 `composer-2.5-fast` → 非 Fast `composer-2.5` へ変更 = 閣下の決定）。`--model auto` はルーターが毎回選び再現性が無く、実行ログにも選択モデルが残らないため使わない。
- **権限**: settings.json の allow ルールで事前承認済みなのは `-w`（worktree 隔離）付きの `--force` のみ。既定（`--workspace` 直編集）の `--force` は都度確認になる。ルールはプレフィックス一致なので `timeout` 等を前置せず素の `cursor agent ...` で起動する。

## 依頼プロンプトの規則

- **Cursor には実装だけを依頼**し、テスト/ビルド/型チェック/`/extract-testable-module`・`/tautology-test-detector` の実行指示を依頼プロンプトに入れない（Claude 側でも同じ点検を回すので二重＝待ち時間とトークンの無駄。チェックは Claude へ一本化 = 2026-06-16 閣下の決定）。
- 依頼プロンプトには要件/スコープ/触ってはいけない核/完了報告項目（変更差分の提示）を明記する。

## 未コミット成果の保護（`--workspace` 直編集の必須運用 / 2026-06-12 閣下の決定）

直編集委譲は前回までの未コミット成果を上書き・消失させうる（実例: 同一ファイルへ連続委譲し、前回 green の抽出ファイルが未追跡のまま消えた）。

**2026-07-06 以降、cursor-exec.sh 経由ならこの保護は自動化済み**（スナップショット＋消失検知）。手動手順は生コマンド起動時のフォールバック:

1. 委譲前に成果を `git add`(-A)/commit/stash で固定
2. 各 Cursor 実行後に `git status`＋対象シンボルの grep で前回成果の生存を検証してから次へ

同一ファイルへの連続委譲では特に必須。ラッパー経由でも「前回成果のシンボルが中身ごと書き換えられていないか」の grep 検証（消失でなく改変の検知）は引き続き Claude が行う。

## 点検・検証・報告の規則

- **点検・検証は Claude が単独実施**: 実装が返ったら型/lint/test/ビルドと `/extract-testable-module`・`/tautology-test-detector` を Claude 自身が実行して品質担保（private 乱立・無意味テストの防止もここ）。不十分なら Cursor へ実装を再依頼（チェックは引き続き Claude 側）。
- **Cursor の自己申告は鵜呑みにしない**: 「テスト green」「型OK」「LGTM」等を返しても事実として報告に転記しない。品質判断は Claude 自身が実行した点検結果のみを根拠にする（触れるときは「Cursor 申告（未検証）」と明示）。
- **能力は確認してから語る**: 「Cursor が X できる/できない」と断定する前に一次情報（スキル一覧・`--help`・実行ログ）で確認する。確認できないなら「未確認」と述べる。

## フォールバックと関連正本

- Cursor 起動不可（未ログイン・障害・トークン/レート枯渇・timeout）→ general-purpose サブエージェントで実装（自走を維持）。GUI 手動ハンドオフは明示依頼時のみ。
- autonomous-dev run では、Cursor 委譲は `~/.claude/workflows/autodev-downstream.js` の Implement プロンプトが正本（旧 雛形1-C = subagent-prompts.md は 2026-07-03 の v3 再編で Workflow へ統合・廃止。経緯は `~/.claude/skills/autonomous-dev/references/rationale.md`）。
