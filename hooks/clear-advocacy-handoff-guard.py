#!/usr/bin/env python3
"""
Stop hook: 直前ターンの assistant 応答が「/clear（コンテキストのクリア）」を
ユーザーに訴求・提案している場合に、先に handoff skill でハンドオフファイルを
作るよう Claude 自身に差し戻す（block）。

設計上の要点（memory-stop-record.py の作法に倣う）:
- 「本当に clear を訴求しているか」の最終判断は Claude（モデル）が行う。
  フックは正規表現で候補を拾うだけのプレフィルタ。誤検出時はモデルが「該当なし」で抜ける。
- 無限ループ防止は stop_hook_active に依存しない。トランスクリプト上の
  「最後の実ユーザー発話」を署名にして state ファイルに記録し、
  1 ユーザーターンにつき block を最大 1 回に固定する（構造的にループ不可）。
  → handoff を作って clear を再提示しても、同一ユーザーターンなので再 block されない。
- 何かエラーが起きたら必ず「停止を許可（exit 0・出力なし）」にフォールバックする。
"""

import hashlib
import json
import os
import re
import sys

STATE_DIR = os.path.expanduser("~/.claude/.cache/clear-handoff-guard")

# 直前ターンの assistant テキストに現れたら「clear を訴求していそう」と見なす候補語。
# 低誤検出のため、原則 `/clear` リテラル、または「クリア」と
# 「コンテキスト/セッション/文脈」の共起を要求する。
CLEAR_RE = re.compile(
    r"(/clear\b"
    r"|コンテキスト[をのも　\s]*クリア"
    r"|クリア[をしてすが　\s]*[（(]?/?clear"
    r"|セッション[をの　\s]*クリア"
    r"|文脈[をの　\s]*クリア"
    r"|クリア(を|することを|するのを)?(お勧め|おすすめ|推奨|提案))",
    re.IGNORECASE,
)


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


def is_real_user_entry(obj: dict) -> bool:
    """tool_result やメタ注入ではない、人間の発話エントリか。"""
    if obj.get("type") != "user":
        return False
    if obj.get("isMeta") or obj.get("isMeta") is True:
        return False
    msg = obj.get("message") or {}
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip() != ""
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool_result":
                return False
        return True
    return False


def last_user_signature_and_assistant_text(transcript_path: str):
    """(最後の実ユーザー発話の署名, その後の assistant テキスト連結) を返す。"""
    assistant_chunks = []
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return None, ""

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

    last_user_idx = -1
    last_user_sig = None
    for i in range(len(parsed) - 1, -1, -1):
        obj = parsed[i]
        if obj and is_real_user_entry(obj):
            last_user_idx = i
            uid = obj.get("uuid") or obj.get("timestamp") or str(i)
            last_user_sig = hashlib.sha1(str(uid).encode("utf-8")).hexdigest()[:16]
            break

    if last_user_idx < 0:
        return None, ""

    # 最後のユーザー発話より後の assistant テキストのみ判定材料にする
    # （ユーザー発話自体は含めない＝ユーザーが "/clear" と言っただけでは発火させない）
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

    return last_user_sig, "\n".join(assistant_chunks)


REASON = """【clear 訴求ガード（Stop フック）】直前のあなたの応答に /clear（コンテキストのクリア）の提案らしき表現を検出しました。
▼本当にユーザーへ /clear を訴求・提案しているなら → まず handoff skill を実行してハンドオフファイルを作成し、handoff skill の手順どおり「次セッションへそのまま貼れるコピー可能な fenced code block（先頭に .md 絶対パス＋続行の合図）」を必ず出力してから、改めて /clear を提案して終了してください。この引き継ぎブロックの省略は禁止です（人間がパスを手で組み立てずに済ませるための必須成果物）。clear で文脈が失われる前に引き継ぎ資料を残すため。memory id 1836 の運用。
▼clear を訴求しておらず、語に触れただけ（このフック自体の話・ユーザー発話の引用・無関係な文脈）なら → handoff は作らず「clear 訴求ではない」と 1 行だけ述べて終了してください。"""


def main():
    data = read_input()

    if data.get("stop_hook_active") is True:
        allow_stop()

    transcript_path = data.get("transcript_path")
    session_id = data.get("session_id") or "unknown"
    if not transcript_path or not os.path.exists(transcript_path):
        allow_stop()

    sig, recent_text = last_user_signature_and_assistant_text(transcript_path)
    if not sig:
        allow_stop()

    # clear 訴求シグナルが無ければ何もしない
    if not CLEAR_RE.search(recent_text or ""):
        allow_stop()

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

    try:
        with open(state_file, "w", encoding="utf-8") as f:
            f.write(sig)
    except Exception:
        # state を書けないならループの危険があるので block しない
        allow_stop()

    block(REASON)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)
