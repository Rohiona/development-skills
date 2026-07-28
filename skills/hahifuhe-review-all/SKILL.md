---
name: hahifuhe:review-all-codex
description: 俺様レビューオール（Codex向け薄ラッパー）。仕様ある場合は整合性＋要件＋設計レビュー、常に変更影響＋品質（+テスト健全性）レビュー実行。詳細はClaude command本体に委譲
---

# Oresama Review All

この skill は薄いラッパー。詳細手順の正本は Claude command / reviewer playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. まず `~/.claude/skills/hahifuhe-review-all/references/review-all-workflow.md` を読む（`~/.claude/commands/hahifuhe:review-all.md` から辿ってもよい）
2. その内容を canonical workflow として扱う
3. ただし Claude 固有の実装はそのまま模倣せず、この skill の Codex 向けルールで読み替える
4. reviewer playbook は、そのフェーズを実行するときだけ読む
   - `~/.claude/agents/hahifuhe-conformance-reviewer.md`
   - `~/.claude/agents/hahifuhe-impact-reviewer.md`
   - `~/.claude/agents/hahifuhe-quality-reviewer.md`
   - `~/.claude/agents/hahifuhe-reviewer.md`（要件・設計レビュー＝批判的レビュアー。要件文書の質 / 設計文書の妥当性+逆おこし鮮度）
   - `~/.claude/agents/hahifuhe-security-reviewer.md`（セキュリティ＝OWASP 級チェックリストで体系 sweep。常時実行）

## Codex 向け読み替えルール

- レビュー本体は親 Codex が実行する
- sub-agent や second opinion は、ユーザーが明示的に求めたときだけ使う
- Claude command 内の background `codex exec` は「任意の追加レビュー」と解釈し、デフォルトでは必須にしない
- diff / コード探索 / 根拠確認は、このセッションで使えるローカルツールを優先する
- レビュー結果はデフォルトでチャットに返す
- `reviews/` へのレポート保存は、ユーザーが明示的に保存を求めたときだけ行う

## 最小レビュー手順

1. 対象を決める（PR 番号/URL → PR diff / ブランチ名 → base との差分 / 指定なし → 現在ブランチ差分）
2. 仕様の有無を `manifest.json` 起点で調べる（`phases.requirements.handoff` = `requirements/requirements.json`, `phases.design.handoff` = `design/context.json`）。distilled を既定で読み、verbose 本体は不足時のみ該当セクションを開く
3. requirements と design の distilled が両方そろっている場合は、仕様レビュー3観点を行う: (a) 整合性（要件↔設計↔実装）、(b) 要件レビュー（requirements 文書の完全性・検証可能性・値域表記の一貫性）、(c) 設計レビュー（design 補助文書の妥当性 + 逆おこし鮮度＝実装/diff との乖離検出）。playbook は `hahifuhe:review-conformance` / `hahifuhe:review-requirements` / `hahifuhe:review-architecture`
4. 変更影響レビューとコード品質レビューを行う（コード探索はスコープ限定 + Serena 優先）。diff にテストファイル変更があればテスト健全性（トートロジー/メタ）も行う。**セキュリティレビュー（`hahifuhe-security-reviewer.md` の体系チェックリスト）は常時行う**
5. 結果を統合し、findings first で返す。GO 判定は **Critical = 0 かつ Major = 0**（セキュリティの actionable な Critical/Major も算入）

## Ground Truth ルール

- finding を上げる前に対象コードを実際に読む
- 影響を主張する前に参照元・呼び出し元を確認する
- 「存在しない」「未実装」は検索または読了で確認してから述べる
- 推測ベースの指摘は出さない

## 出力ルール

- findings を最初に出す
- severity 順で並べる
- 可能な限りファイルパスと行番号を付ける
- open questions / assumptions は短く分離する
- 各レビュー種別で finding がなければ明示する
- 最後に簡潔な総合判定を付ける
