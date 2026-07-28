#!/usr/bin/env python3
"""
コンテキスト内訳レポート（オンデマンド）。

現セッション（または指定したトランスクリプト）に「何が乗っているか」を、
種別・ツール別・個別の重い項目に分解して表示し、/clear すべきか続けるべきかの
判断材料にする。フックではなく手動／Claude 経由で実行する。

使い方:
  python3 context-weight-report.py [transcript.jsonl]
    - 引数なし: カレントの cwd に対応する ~/.claude/projects/<slug>/ 内で
      最終更新が最も新しい *.jsonl を自動選択。
  python3 context-weight-report.py <session_id 先頭8桁など部分一致>

トークンは文字数 / 4 の推定（厳密値ではない）。最後の assistant usage は実測。
"""

import glob
import json
import os
import sys


def est_tokens(obj) -> int:
    """トークン概算。CJK（日本語等）は1文字≒1トークン、それ以外は4文字≒1トークン。
    2026-07-02: 一律 len/4 だと日本語が約1/4に過小評価されるため CJK 補正を導入。"""
    try:
        s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    except Exception:
        s = str(obj)
    cjk = sum(
        1
        for ch in s
        if (
            "　" <= ch <= "ヿ"  # 和文記号・ひらがな・カタカナ
            or "一" <= ch <= "鿿"  # 漢字
            or "＀" <= ch <= "￯"  # 全角英数・半角カナ
        )
    )
    return cjk + (len(s) - cjk) // 4


def resolve_transcript(arg):
    home = os.path.expanduser("~")
    proj_root = os.path.join(home, ".claude", "projects")
    if arg and os.path.exists(arg):
        return arg
    candidates = glob.glob(os.path.join(proj_root, "**", "*.jsonl"), recursive=True)
    if arg:  # 部分一致（session id など）
        m = [c for c in candidates if arg in os.path.basename(c)]
        if m:
            return max(m, key=os.path.getmtime)
    # cwd に対応する slug を優先
    cwd = os.getcwd()
    slug = cwd.replace("/", "-")
    same = [c for c in candidates if slug in c]
    pool = same or candidates
    if not pool:
        return None
    return max(pool, key=os.path.getmtime)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    tpath = resolve_transcript(arg)
    if not tpath:
        print("トランスクリプトが見つかりません")
        return

    branch = None
    first_user = None
    last_usage = None
    n_lines = 0
    # 集計
    by_tool_result = {}   # toolName -> est tokens (tool_result の重さ)
    by_tool_input = {}    # toolName -> est tokens (tool_use input の重さ)
    text_assistant = 0
    text_user = 0
    sidechain_tok = 0
    heavy = []            # (est, kind, detail)
    tooluse_by_id = {}    # tool_use_id -> toolName

    with open(tpath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            n_lines += 1
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("gitBranch"):
                branch = d["gitBranch"]

            # 2026-07-02: /compact・自動要約の境界以前はライブコンテキストに
            # 乗っていないため、境界を跨いだら集計をリセット（warn 版と同じ）。
            if d.get("type") == "system" and d.get("subtype") == "compact_boundary":
                by_tool_result = {}
                by_tool_input = {}
                text_assistant = 0
                text_user = 0
                sidechain_tok = 0
                heavy = []
                tooluse_by_id = {}
                continue

            side = d.get("isSidechain", False)
            msg = d.get("message") or {}
            content = msg.get("content")

            if d.get("type") == "assistant":
                u = msg.get("usage")
                if u:
                    last_usage = u
                if isinstance(content, list):
                    for p in content:
                        if not isinstance(p, dict):
                            continue
                        if p.get("type") == "text":
                            t = est_tokens(p.get("text", ""))
                            text_assistant += t
                            if side:
                                sidechain_tok += t
                        elif p.get("type") == "tool_use":
                            name = p.get("name", "?")
                            tid = p.get("id")
                            if tid:
                                tooluse_by_id[tid] = name
                            t = est_tokens(p.get("input", {}))
                            by_tool_input[name] = by_tool_input.get(name, 0) + t
                            if side:
                                sidechain_tok += t
                            # Read/Bash は対象を控える
                            inp = p.get("input", {}) or {}
                            detail = name
                            if name == "Read" and inp.get("file_path"):
                                detail = f"Read {inp['file_path']}"
                            elif name == "Bash" and inp.get("command"):
                                detail = f"Bash: {str(inp['command'])[:60]}"
                            if t >= 2000:
                                heavy.append((t, "tool_use", detail))

            elif d.get("type") == "user":
                if first_user is None and not d.get("isMeta") and isinstance(content, str):
                    if content.strip() and not content.lstrip().startswith("<"):
                        first_user = content.strip().replace("\n", " ")[:80]
                if isinstance(content, list):
                    for p in content:
                        if not isinstance(p, dict):
                            continue
                        if p.get("type") == "tool_result":
                            tid = p.get("tool_use_id")
                            name = tooluse_by_id.get(tid, "?")
                            c = p.get("content")
                            t = est_tokens(c)
                            by_tool_result[name] = by_tool_result.get(name, 0) + t
                            if side:
                                sidechain_tok += t
                            if t >= 2000:
                                heavy.append((t, "tool_result", f"{name} の結果"))
                        elif p.get("type") == "text":
                            text_user += est_tokens(p.get("text", ""))

    sid = os.path.basename(tpath)[:8]
    print(f"=== コンテキスト内訳: session {sid} ===")
    print(f"file   : {tpath}")
    print(f"branch : {branch}")
    print(f"行数   : {n_lines}")
    if first_user:
        print(f"最初の発言: 「{first_user}」")

    if last_usage:
        ctx = (
            last_usage.get("input_tokens", 0)
            + last_usage.get("cache_read_input_tokens", 0)
            + last_usage.get("cache_creation_input_tokens", 0)
        )
        print(f"\n■ 現コンテキストサイズ(実測): 約 {ctx/1000:,.0f}K トークン")
        print(f"   (input {last_usage.get('input_tokens',0):,} + "
              f"cache_read {last_usage.get('cache_read_input_tokens',0):,} + "
              f"cache_creation {last_usage.get('cache_creation_input_tokens',0):,})")

    print("\n■ 何が乗っているか（推定トークン = 文字数/4）")
    print(f"  assistant のテキスト  : {text_assistant:>10,}")
    print(f"  user のテキスト       : {text_user:>10,}")
    if sidechain_tok:
        print(f"  うちサブエージェント分: {sidechain_tok:>10,}  (別レビュー等の派生)")

    print("\n  ツール結果(tool_result)の重さ 上位:")
    for name, t in sorted(by_tool_result.items(), key=lambda x: x[1], reverse=True)[:8]:
        print(f"    {name:<16} {t:>10,}")

    print("\n  ツール入力(tool_use)の重さ 上位:")
    for name, t in sorted(by_tool_input.items(), key=lambda x: x[1], reverse=True)[:6]:
        print(f"    {name:<16} {t:>10,}")

    print("\n■ 単発で重い項目 上位12（推定トークン）:")
    for t, kind, detail in sorted(heavy, key=lambda x: x[0], reverse=True)[:12]:
        print(f"    {t:>8,}  {kind:<11} {detail}")

    print("\nヒント: 別作業に移っているなら /clear、元作業に戻る可能性があれば")
    print("       一旦 /clear して必要時に /resume でこのセッションを呼び戻す。")


if __name__ == "__main__":
    main()
