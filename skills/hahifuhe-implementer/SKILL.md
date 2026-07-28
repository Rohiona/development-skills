---
name: hahifuhe:implementer-codex
description: 俺様インプリメンター（Codex向け薄ラッパー）。設計に沿った実装、テスト、修正を Codex で進める
---

# Oresama Implementer

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:implementer.md` を読む
2. 実装に入る前に `~/.claude/agents/hahifuhe-implementer.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## 共有契約

hahifuhe シリーズ共通契約に従う。正本:
`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`

- **入力**: `manifest.json` → `design/context.json` + `task-split/tasks.json` の順で読む。
  `design/architecture.md` は既定で読まず、DD-id の詳細が要るときだけ該当セクションを開く。
- **出力**: `implementation/context.json`（契約 §3.4）を書き、`manifest.json` の implementation エントリを更新する。

## Codex 向け読み替えルール

- 親 Codex が既定で実装を進める
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- 高レベル設計（design/context.json の DD-id）に従い、必要なら差分を説明した上で実装する
- 変更前に**当該タスクが触るパッケージ・近接モジュールに限定して**関連コードを読み（シンボル単位優先・全文読み回避）、変更後に関連テストを走らせる
- 設計変更が必要なら `architect` に戻す判断を明示する

## バグ修正時：先にフィードバックループを作る（diagnose Phase1）

「設計に沿った新規実装」ではなく **既存バグの修正・不具合の再現** が主目的のときは、コードに触る前に
**高速・決定論的・自分で実行できる pass/fail シグナル（フィードバックループ）** を先に用意する。

- 推測で直し始めない。まず「失敗が再現し、直れば緑になる」最小の判定手段を作る。優先順:
  1. 適切な層の失敗するテスト（最有力）
  2. dev サーバへの HTTP リクエスト / CLI 実行 + 固定入力のスナップショット比較
  3. 対象コードパスだけを叩く最小ハーネス
- ループを作ったら **再現を確認**してから、反証可能な仮説を 2〜3 個立て、一度に 1 変数だけ変えて切り分ける。
- 修正後はその **回帰テストを残す**（同じ壊れ方を二度と通さない）。一時ログ・計装は片付ける。

新規実装が主目的なら通常のテスト方針でよい。この節はあくまで「再現できる不具合を追う」ときの先行手順。

## 最小実行手順

1. `manifest.json` → `design/context.json` + `task-split/tasks.json` で設計判断・タスク・制約を確認する
2. 実装方針とテスト方針を固める（不変性・クリーンコード規約を遵守）
3. タスク単位で「コード変更 + ユニットテスト」をセットで回す
4. 検証を行う
5. `implementation/context.json` と `manifest.json` を更新する
6. 変更内容、検証結果、残課題を短く返す
