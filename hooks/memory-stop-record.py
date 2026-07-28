#!/usr/bin/env python3
"""
Stop hook: 毎ターン、直前のやり取りに ADR 級の重要情報が確定したかを評価し、
あれば memory skill (claude-mem CLI) で記録するよう Claude に促す。

設計上の要点:
- 「重要かどうか」の判断は Claude（モデル）が行う。フックは判断しない。
- 無限ループ防止は stop_hook_active に依存しない。トランスクリプト上の
  「最後の実ユーザー発話」を署名にして state ファイルに記録し、
  1 ユーザーターンにつき block を最大 1 回に固定する（構造的にループ不可）。
- 何かエラーが起きたら必ず「停止を許可（exit 0・出力なし）」にフォールバックし、
  ユーザーを誤ってブロックし続けない。

記録モード（MODE）:
- "everyturn" (既定): 毎ユーザーターンで Claude に評価を促す（最も自動的）。
- "signal": 直前ターンに決定シグナル語が現れたときだけ促す（軽量）。
  → 切り替えは下の MODE を書き換えるだけ。
"""

import hashlib
import json
import os
import re
import sys

MODE = os.environ.get("MEMORY_EVAL_MODE", "signal")  # "everyturn" | "signal"
# 2026-07-02: 既定を everyturn → signal に変更（毎ターンの block 1往復がトークン/待ち時間の
# 固定費になっていたため）。everyturn に戻すには環境変数 MEMORY_EVAL_MODE=everyturn。

# signal モード時に「直前ターンに重要情報がありそう」と判定する語。
# 注意: 「前提」「理由は」「とする」「根拠」「制約」等の頻出語を入れると
# 実質 everyturn になる（説明の型が毎回それらを含むため）。強い決定語だけに絞る。
SIGNAL_RE = re.compile(
    r"(決定|決めた|決めました|採用|合意|結論|見送り|却下|やめておく|に統一|"
    r"ルール化|正本|設計判断|意思決定|ADR|閣下の(決定|判断)|"
    r"覚えて|記録して|メモリに)",
    re.IGNORECASE,
)

STATE_DIR = os.path.expanduser("~/.claude/.cache/memory-stop-guard")


def allow_stop():
    """停止を許可（何も出力しない）。"""
    sys.exit(0)


def block(reason: str):
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.exit(0)


def read_input() -> dict:
    try:
        return json.loads(sys.stdin.read() or "{}")
    except Exception:
        return {}


# ハーネスが「user」ロールで注入する擬似発話の先頭マーカー。
# これらを実ユーザー発話に数えると、通知が届くたびに block 権が復活して
# 1 人間ターンに何十回も発火する（2026-07-04 に実測 112 回/セッションを確認）。
INJECTED_PREFIXES = (
    "<task-notification>",
    "<system-reminder>",
    "<local-command",
    "<command-name>",
    "Stop hook feedback",
    "[Request interrupted",
)


def _entry_text(content) -> str:
    """user エントリの content からテキスト部分だけを連結して返す。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            item.get("text", "") for item in content if isinstance(item, dict) and item.get("type") == "text"
        )
    return ""


def is_real_user_entry(obj: dict) -> bool:
    """tool_result・メタ注入・ハーネス注入（通知/フック文言）ではない、人間の発話エントリか。"""
    if obj.get("type") != "user":
        return False
    if obj.get("isMeta") or obj.get("isMeta") is True:
        return False
    msg = obj.get("message") or {}
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, list):
        # tool_result を含むエントリ（ツール応答）は人間発話ではない
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool_result":
                return False
    text = _entry_text(content).strip()
    if text == "":
        return False
    if text.startswith(INJECTED_PREFIXES):
        return False
    return True


def last_user_signature_and_assistant_text(transcript_path: str):
    """トランスクリプトから (最後の実ユーザー発話の署名, その後の assistant テキスト連結) を返す。"""
    last_user_sig = None
    seen_last_user = False
    assistant_chunks = []
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return None, ""

    # 末尾から最後の実ユーザー発話を特定
    last_user_idx = -1
    parsed = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            parsed.append(None)
            continue
        try:
            parsed.append(json.loads(ln))
        except Exception:
            parsed.append(None)

    for i in range(len(parsed) - 1, -1, -1):
        obj = parsed[i]
        if obj and is_real_user_entry(obj):
            last_user_idx = i
            uid = obj.get("uuid") or obj.get("timestamp") or str(i)
            last_user_sig = hashlib.sha1(str(uid).encode("utf-8")).hexdigest()[:16]
            break

    if last_user_idx < 0:
        return None, ""

    # その後の assistant テキストを集める（signal モードの判定材料）
    for obj in parsed[last_user_idx + 1:]:
        if not obj:
            continue
        if obj.get("type") == "assistant":
            msg = obj.get("message") or {}
            content = msg.get("content")
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        assistant_chunks.append(item.get("text", ""))
            elif isinstance(content, str):
                assistant_chunks.append(content)
    # 直前のユーザー発話自体もシグナル判定に含める
    u = parsed[last_user_idx].get("message", {}).get("content")
    if isinstance(u, str):
        assistant_chunks.append(u)
    elif isinstance(u, list):
        for item in u:
            if isinstance(item, dict) and item.get("type") == "text":
                assistant_chunks.append(item.get("text", ""))

    return last_user_sig, "\n".join(assistant_chunks)


# 毎ターン注入される薄い指示。詳細な保存手順は該当時だけ PROTOCOL_PATH を読ませる。
PROTOCOL_PATH = "~/.claude/hooks/memory-record-protocol.md"

REASON = f"""【メモリ記録チェック（Stop フック）】直前のやり取りで、後から開発の判断材料になる重要情報が確定したか評価してください。
記録対象 = ①ADR 級の意思決定・設計方針とその理由 ②開発の判断基準・前提・制約（今後も再現するルール）③出典(URL/Slack/Notion/PR・Issue/コミット SHA/docs パス)。
非対象 = 作業ログ・一時的で再利用しない事実・コードを読めば分かること。
▼該当なし（大半）→ ツールを呼ばず「記録対象なし」とだけ述べて終了。
▼該当あり → `{PROTOCOL_PATH}` を Read し、その手順（重複 search → save、出典は原文保持）で memory skill に記録し、1 行で報告して終了。"""


def main():
    data = read_input()

    # stop_hook_active が存在し true なら、フック起因の継続中なので即許可（保険）
    if data.get("stop_hook_active") is True:
        allow_stop()

    transcript_path = data.get("transcript_path")
    session_id = data.get("session_id") or "unknown"
    if not transcript_path or not os.path.exists(transcript_path):
        allow_stop()

    sig, recent_text = last_user_signature_and_assistant_text(transcript_path)
    if not sig:
        allow_stop()  # ユーザー発話がまだ無い

    # state ファイルで「このユーザーターンは評価済みか」を判定
    os.makedirs(STATE_DIR, exist_ok=True)
    state_file = os.path.join(STATE_DIR, f"{re.sub(r'[^A-Za-z0-9_.-]', '_', session_id)}.txt")
    prev_sig = ""
    try:
        with open(state_file, "r", encoding="utf-8") as f:
            prev_sig = f.read().strip()
    except Exception:
        prev_sig = ""

    if prev_sig == sig:
        # 同じユーザーターンで既に block 済み → 停止を許可（ループ防止の要）
        allow_stop()

    # 新しいユーザーターン。まず署名を記録（block 後の再 Stop で許可されるように）
    try:
        with open(state_file, "w", encoding="utf-8") as f:
            f.write(sig)
    except Exception:
        # state を書けないならループの危険があるので block しない
        allow_stop()

    if MODE == "signal" and not SIGNAL_RE.search(recent_text or ""):
        allow_stop()

    block(REASON)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # 想定外のエラーでは絶対にユーザーをブロックし続けない
        sys.exit(0)
