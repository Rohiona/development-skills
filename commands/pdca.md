---
description: PDCA自己改善ループ（GitHub不使用・対話型・効果検証つき）。会話ログ＋insights frictionから問題を洗い出し、選択式で取捨選択→深掘り→反映、効果を縦断検証。記録は.claude/pdca-logs/
---

# PDCA 自己改善ループ

PDCA 自己改善ループを実行する。**手順の正本はスキル本体**にあるので、必ず次を読み、それに厳密に従うこと:

- `~/.claude/skills/pdca/SKILL.md`

特に次の鉄則を必ず守る:
- 合意前に SKILL.md / CLAUDE.md / rules / スキル本体を自動で書き換えない
- GitHub に登録しない（記録は `.claude/pdca-logs/` のみ）
- 事実 / 推論 / 推測を区別する
- 問題かどうかは AI が決めつけず、必ず人間の取捨選択（まとめてチェック式）で確定する

引数（`$ARGUMENTS`）があれば、対象セッションや観点の指定として解釈する。
