#!/usr/bin/env python3
"""
UserPromptSubmit hook: ユーザーが「たぶんメモリにあると思うんだけど」「メモリにありませんか」
「メモリから思い出してほしい」「たぶんメモリから」等の "想起意図" を口にしたときだけ、
memory skill で検索してから答えるよう Claude に文脈を注入する。

毎プロンプトでは発火しない（検索コストとノイズを避けるため、想起フレーズ検知時のみ）。
判断（実際の検索クエリ設計・distance 判定）は memory skill 側のルールに委ねる。
フックの責務は「検知 → ナッジ注入」だけ。
"""

import json
import re
import sys

# 想起意図フレーズ。メモリ/記憶 という語 + 想起を示す言い回しの組み合わせを拾う。
# 「メモリの仕組みを作る」のような話題（メモリ＝設計対象）で誤発火しないよう、
# あくまで "そこに在るものを引き出したい" 意図の表現に限定する。
RECALL_PATTERNS = [
    r"(たぶん|多分|確か|きっと)\s*(メモリ|記憶)",
    r"(メモリ|記憶)\s*(に|の中に|内に|から)?\s*.{0,12}?(あると思|あるはず|あったはず|あったよね|あったっけ|なかったっけ|ありませんか|ありますか|残って|入って|記録(して|され|ある))",
    r"(メモリ|記憶)\s*から\s*.{0,8}?(思い出|想起|引っ張|取り出|探)",
    r"(メモリ|記憶)\s*(に|を)?\s*.{0,8}?(思い出して|想起して)",
    r"(メモリ|記憶)\s*(を|から|に)?\s*(検索|探して|探せ|あさって|漁って)",
    r"前に\s*.{0,16}?(メモリ|記憶)\s*.{0,8}?(保存|記録|残し)",
    # 英語の軽い言い回し
    r"\b(in|from)\s+memory\b.{0,20}?(remember|recall|stored|saved|have)",
    r"\b(check|search)\s+(the\s+)?memory\b",
]
RECALL_RE = re.compile("|".join(RECALL_PATTERNS), re.IGNORECASE)


NUDGE = """【メモリ想起トリガー検知（UserPromptSubmit フック）】
ユーザーは過去に memory に記録した内容を引き出したい意図を示しています。
回答を組み立てる前に、まず memory skill の search で関連記録を検索してください。
- クエリはユーザー発言から想起トリガー語（「たぶんメモリ」「メモリにある？」等）を除いた本質キーワードで組む
- --project は現在のプロジェクト（cwd のルート名、echo リポなら echo）に絞るのが既定
- distance と意図一致の両方で関連性を判定（memory skill のルールに従う）。弱ヒット時は recent / 言い換え再検索でフォロー（retry は最大 3 回）
- 関連が見つからなければ「メモリには見つからなかった」と明示し、追加キーワードを促す
見つかった記録は id / title / 要点を引用してから本題に答えてください。"""


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        sys.exit(0)

    prompt = data.get("prompt") or ""
    if not isinstance(prompt, str) or not prompt.strip():
        sys.exit(0)

    if not RECALL_RE.search(prompt):
        sys.exit(0)  # 想起意図なし → 何も注入しない

    out = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": NUDGE,
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)
