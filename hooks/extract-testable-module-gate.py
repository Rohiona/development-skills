#!/usr/bin/env python3
"""Stop hook: TypeScript の実装をしたターンで、extract-testable-module の
責務設計・自己点検が未実施なら 1 回だけブロックしてリマインドを注入する。

背景:
  extract-testable-module スキルは「実装直後に能動発火せよ」と SKILL.md に
  書いてあるだけで、長い文脈ではモデルが自己点検を飛ばし、即席のインライン
  判断で代替してしまう（実例: レビュー指摘の修正後に自己点検が走らず、
  後で人間が明示的に訊いて初めて起動した）。自動挙動はフックでないと確実に
  再現しない、という知見に基づき、Stop でゲートする。

設計上の要点（memory-stop-record.py と同型）:
- 「実装があったか」「自己点検をしたか」はフックがトランスクリプトの
  tool_use / tool_result から機械的に判定する（モデルの自己申告に依存しない）。
- 無限ループ防止は stop_hook_active に依存しない。最後の実ユーザー発話を署名に
  して state ファイルへ記録し、1 ユーザーターンにつき block を最大 1 回に固定する
  （構造的にループ不可）。block 後にモデルがスキルを動かせば自己点検シグナルが
  立ち、次の Stop は許可される。動かさなくても署名ガードで許可される。
- 何かエラーが起きたら必ず「停止を許可（exit 0・出力なし）」にフォールバックし、
  ユーザーを誤ってブロックし続けない（fail-open）。

精度（誤発火回避）:
- 実装シグナルは「cursor agent -p（実装委譲）」または「コードファイル(.ts 等)への
  書換ツール」のみ。設定/ドキュメント(.py/.md/.json)だけのターンや、コードの
  読み取りだけのターンでは発火しない。
- errored な tool_use（権限拒否・cursor-delegation-enforce によるブロック・失敗）は
  実装/自己点検のいずれにも数えない（ブロックされた編集を実装と誤認しない）。
"""

import hashlib
import json
import os
import re
import sys

STATE_DIR = os.path.expanduser("~/.claude/.cache/extract-testable-gate")

CODE_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")

# コード書換系ツール → tool_input 内のパスキー（cursor-delegation-enforce と同じ集合）
CODE_WRITE_PATH_KEYS = {
    "Edit": "file_path",
    "Write": "file_path",
    "MultiEdit": "file_path",
    "NotebookEdit": "notebook_path",
    "mcp__plugin_serena_serena__replace_symbol_body": "relative_path",
    "mcp__plugin_serena_serena__replace_content": "relative_path",
    "mcp__plugin_serena_serena__insert_after_symbol": "relative_path",
    "mcp__plugin_serena_serena__insert_before_symbol": "relative_path",
    "mcp__plugin_serena_serena__create_text_file": "relative_path",
    "mcp__plugin_serena_serena__safe_delete_symbol": "relative_path",
    "mcp__plugin_serena_serena__rename_symbol": "relative_path",
}

# 拡張子に依らず常にコード操作とみなす（tsmorph リファクタ系）
ALWAYS_CODE_TOOLS = {
    "mcp__mcp-tsmorph-refactor__change_signature_by_tsmorph",
    "mcp__mcp-tsmorph-refactor__move_symbol_to_file_by_tsmorph",
    "mcp__mcp-tsmorph-refactor__remove_path_alias_by_tsmorph",
    "mcp__mcp-tsmorph-refactor__rename_filesystem_entry_by_tsmorph",
    "mcp__mcp-tsmorph-refactor__rename_symbol_by_tsmorph",
}

# 自己点検「をした」とみなす：スキルの参照ファイルを読むツールのパスキー
SKILL_READ_PATH_KEYS = {
    "Read": "file_path",
    "mcp__plugin_serena_serena__read_file": "relative_path",
    "mcp__plugin_serena_serena__find_file": "file_mask",
    "mcp__plugin_serena_serena__get_symbols_overview": "relative_path",
}

SKILL_DIR_MARK = "skills/extract-testable-module"
SKILL_NAME = "extract-testable-module"


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
    if not obj or obj.get("type") != "user":
        return False
    if obj.get("isMeta") is True:
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


def parse_transcript(transcript_path: str):
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return []
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
    return parsed


def last_user_index_and_sig(parsed):
    for i in range(len(parsed) - 1, -1, -1):
        obj = parsed[i]
        if is_real_user_entry(obj):
            uid = obj.get("uuid") or obj.get("timestamp") or str(i)
            sig = hashlib.sha1(str(uid).encode("utf-8")).hexdigest()[:16]
            return i, sig
    return -1, None


def collect_tool_events(parsed, start_idx):
    """start_idx より後の tool_use と、エラーになった tool_use_id 集合を返す。"""
    tool_uses = []  # [{id, name, input}]
    errored_ids = set()
    for obj in parsed[start_idx + 1:]:
        if not obj:
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            itype = item.get("type")
            if itype == "tool_use":
                tool_uses.append(
                    {
                        "id": item.get("id"),
                        "name": item.get("name", ""),
                        "input": item.get("input") or {},
                    }
                )
            elif itype == "tool_result":
                if item.get("is_error") is True:
                    tid = item.get("tool_use_id")
                    if tid:
                        errored_ids.add(tid)
    return tool_uses, errored_ids


def is_implementation(tu) -> bool:
    name = tu["name"]
    inp = tu["input"]
    if name == "Bash":
        cmd = inp.get("command", "")
        if isinstance(cmd, str) and "cursor agent" in cmd and re.search(r"(^|\s)-p(\s|$)", cmd):
            return True
        return False
    if name in ALWAYS_CODE_TOOLS:
        return True
    if name in CODE_WRITE_PATH_KEYS:
        path = inp.get(CODE_WRITE_PATH_KEYS[name], "")
        if isinstance(path, str) and path.endswith(CODE_EXTS):
            return True
    return False


def is_self_check(tu) -> bool:
    name = tu["name"]
    inp = tu["input"]
    # 1) Skill ツールで extract-testable-module を起動した
    if name == "Skill":
        skill = inp.get("skill") or inp.get("name") or ""
        if isinstance(skill, str) and SKILL_NAME in skill:
            return True
    # 2) スキルの SKILL.md / references を読んだ（自己点検に着手した証跡）
    if name in SKILL_READ_PATH_KEYS:
        path = inp.get(SKILL_READ_PATH_KEYS[name], "")
        if isinstance(path, str) and SKILL_DIR_MARK in path:
            return True
    return False


REASON = """【責務設計の自己点検（extract-testable-module / Stop ゲート）】このターンで TypeScript の実装（cursor agent 委譲 か コード書換）がありましたが、extract-testable-module の自己評価ゲートをまだ通していません。即席のインライン判断で済ませず、コミット/報告の前に実コードへ自己点検を通してください。

手順:
1. Skill ツールで `extract-testable-module` を起動する。起動したら、編集した実ファイルのパスから `references/area-map.md` で領域(area)を判定し、`references/learned-lenses.global.md` ＋ 該当領域の `references/learned-lenses/<area>.md` の 2 枚だけを読んで、過去に人間の指摘から蒸留された学習観点を「いま書いた実コード」に照合する。
2. 自己評価ゲート（要件・文脈／責務の数／関心の混在／配置／テスト可能性／型は関心を表現しているか）の結論は、散文の「妥当」で済ませず **testability_inventory（単位ごとの棚卸し表）** で出す。クラス/モジュールの private・ローカル関数・厚いブロックを 1 件ずつ「純粋ロジック有無／モック要否／抽出 or 据え置き＋理由」で裁く。gestalt な「概ね妥当」は不可。表を書く前に `python3 ~/.claude/skills/extract-testable-module/scripts/verify-extraction.py --list-units --file <編集ファイル>` で単位を機械列挙し、列挙された全単位が表に載っていること（網羅性を自己申告にしない）。
3. rate-of-change（揮発↔安定）を必ず見る: 1 つの関数が「外部フォーマット・契約に結びつく揮発な adapter（例: 封筒のどこに値が載るか）」と「純ポリシー・判定の安定なロジック（例: 値→分岐）」をまたいでいたら、deletion test で浅く見えても層として分離を検討する。export-as-private（内部をテストのために晒すだけ）はアンチパターン、責務の再概念化＝層分離が正。
4. 「据え置き」の行には必ず理由を書く。妥当・据え置きと判断するのは、deletion test で浅い かつ 揮発/安定が混ざっていないことを確認した上でのみ可。

このターンが設定/ドキュメントのみ等で自己点検が不要だと確信できる場合は「責務自己点検 不要（理由）」とだけ述べて終了してください。"""


def main():
    data = read_input()

    if data.get("stop_hook_active") is True:
        allow_stop()

    transcript_path = data.get("transcript_path")
    session_id = data.get("session_id") or "unknown"
    if not transcript_path or not os.path.exists(transcript_path):
        allow_stop()

    parsed = parse_transcript(transcript_path)
    if not parsed:
        allow_stop()

    last_idx, sig = last_user_index_and_sig(parsed)
    if last_idx < 0 or not sig:
        allow_stop()

    tool_uses, errored_ids = collect_tool_events(parsed, last_idx)

    impl = any(is_implementation(tu) for tu in tool_uses if tu["id"] not in errored_ids)
    if not impl:
        allow_stop()  # このターンに TS 実装は無い → 対象外

    checked = any(is_self_check(tu) for tu in tool_uses if tu["id"] not in errored_ids)
    if checked:
        allow_stop()  # 既に自己点検をしている

    # state ファイルで「このユーザーターンは既に block 済みか」を判定（ループ防止の要）
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)
        state_file = os.path.join(STATE_DIR, f"{safe}.txt")
        prev_sig = ""
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                prev_sig = f.read().strip()
        except Exception:
            prev_sig = ""
        if prev_sig == sig:
            allow_stop()  # 同じユーザーターンで既に block 済み
        with open(state_file, "w", encoding="utf-8") as f:
            f.write(sig)
    except Exception:
        # state を扱えないならループの危険があるので block しない
        allow_stop()

    block(REASON)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # 想定外のエラーでは絶対にユーザーをブロックし続けない
        sys.exit(0)
