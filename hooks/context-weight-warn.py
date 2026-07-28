#!/usr/bin/env python3
"""
UserPromptSubmit hook: 現セッションのコンテキスト肥大を「総量」と「中身」の
両面で軽量に検知し、必要なときだけ 1 行で知らせる。

なぜ作り替えたか（経緯・2026-06-16 閣下と設計）:
- 旧版は「総量 >= 150K で警告」の固定単一閾値だった。150K は実は 200K ウィンドウの
  75% で、ウィンドウ連動になっていなかったのが本質的な問題。閣下の環境は実質 1M
  ウィンドウ（claude-opus-4-8[1m]）固定なので、150K では 15% で鳴ってしまい早すぎた。
- 本当に潰したい無駄は「総量が大きい」ことではなく、「並列レビュー等で読み込んだ
  コードベース/サブエージェントの結果が居残り、もう使っていないのに毎ターン再送されて
  トークンが溶ける」こと。＝判定軸は総量 → 中身（composition）× 鮮度（staleness）。

二段構成:
  段1（このフック・決定論的・即時・LLM なし）
    A. 容量バックストップ: 現コンテキスト >= ウィンドウ * 比率(既定 1M*0.75=750K)
       → 「そろそろ本当に満杯」。/clear or /resume を促す。
    B. composition 検知: tool_result（Read/Grep/Serena/Task 等＝読み込んだ素材）が
       現コンテキストの大半を占め、かつ一定量を超える → stale 候補の一覧を出力し、
       「直近の作業文脈と照合して、無関係なら /clear を提案せよ」と main の Claude に促す。
  段2（main の Claude が担う・このスクリプト外）
    段1-B が出した一覧と直近の会話文脈を、安価モデル(haiku)の Agent で比較し、
    「絶対に使っていない」ものだけ高精度に名指しして /clear を訴求する。
    → フックに LLM を埋めない（同期遅延・認証不要）。発火は決定論的フックが保証する。

毎ターン連打しないよう、セッション単位の state ファイルで debounce する
（前回警告時からコンテキストが REWARN_GROWTH 以上増えたときだけ再発火）。

何が起きても exit 0（ユーザーを止めない・壊さない）。

環境変数（すべて任意・既定は 1M ウィンドウ前提）:
  CONTEXT_WINDOW_TOKENS  ウィンドウ既定 1000000
  CONTEXT_WARN_RATIO     容量警告の比率 既定 0.60（=600K で発火。auto compact 発火点
                         ≈90% の十分手前で「compact-save → /compact」の導線を出すため。
                         2026-07-08 閣下と compact 対策一式を導入した際に 0.75 から変更）
  CONTEXT_COMP_FLOOR     composition 検知の下限 既定 150000（未満は中身に関わらず黙る）
  CONTEXT_COMP_RATIO     tool_result 占有率の閾値 既定 0.5
  CONTEXT_REWARN_GROWTH  再発火に必要な増分 既定 50000
"""

import json
import os
import sys
import tempfile

WINDOW = int(os.environ.get("CONTEXT_WINDOW_TOKENS", "1000000"))
WARN_RATIO = float(os.environ.get("CONTEXT_WARN_RATIO", "0.60"))
SIZE_THRESHOLD = int(WINDOW * WARN_RATIO)
COMP_FLOOR = int(os.environ.get("CONTEXT_COMP_FLOOR", "150000"))
COMP_RATIO = float(os.environ.get("CONTEXT_COMP_RATIO", "0.5"))
REWARN_GROWTH = int(os.environ.get("CONTEXT_REWARN_GROWTH", "50000"))


def est_tokens(obj) -> int:
    """トークン概算。CJK（日本語等）は1文字≒1トークン、それ以外は4文字≒1トークン。
    2026-07-02: 一律 len/4 だと日本語が約1/4に過小評価され、日本語会話が分母の
    composition 比率が水増しされて警告が鳴りすぎたため CJK 補正を導入。"""
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


def state_path(session_id: str) -> str:
    safe = "".join(c for c in (session_id or "x") if c.isalnum() or c in "-_")[:40]
    return os.path.join(tempfile.gettempdir(), f"ctxwarn-{safe}.json")


def load_state(session_id: str) -> dict:
    try:
        with open(state_path(session_id), "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save_state(session_id: str, **updates) -> None:
    st = load_state(session_id)
    st.update(updates)
    try:
        with open(state_path(session_id), "w", encoding="utf-8") as f:
            json.dump(st, f)
    except Exception:
        pass


def tail_ctx(tpath: str, tail_bytes: int = 262144):
    """末尾 tail_bytes だけ読み、最後の assistant usage から現コンテキストを実測する高速路。
    取れなければ None（フルパースへフォールバック）。"""
    try:
        size = os.path.getsize(tpath)
        with open(tpath, "rb") as f:
            if size > tail_bytes:
                f.seek(size - tail_bytes)
                f.readline()  # 行の途中から始まる断片を捨てる
            ctx = None
            for raw in f:
                try:
                    d = json.loads(raw)
                except Exception:
                    continue
                if d.get("type") == "assistant":
                    u = (d.get("message") or {}).get("usage")
                    if u:
                        ctx = (
                            u.get("input_tokens", 0)
                            + u.get("cache_read_input_tokens", 0)
                            + u.get("cache_creation_input_tokens", 0)
                        )
            return ctx
    except Exception:
        return None


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        sys.exit(0)

    tpath = data.get("transcript_path")
    session_id = data.get("session_id") or ""
    if not tpath or not os.path.exists(tpath):
        sys.exit(0)

    # ── 高速路（2026-07-04）: 末尾だけ読んで「確実に黙るケース」を先に判定する。
    # フルパースはファイルサイズ比例（実測 2.4MB=85ms / 14MB=267ms・毎プロンプト発火）で、
    # 大半のターンは警告条件に届かないため、その場合の全行走査を省く。
    # 判定条件・警告文面は従来と同一（警告の可能性があるターンだけ従来のフルパースへ進む）。
    ctx_fast = tail_ctx(tpath)
    if ctx_fast is not None:
        if ctx_fast < min(SIZE_THRESHOLD, COMP_FLOOR):
            sys.exit(0)  # size/composition どちらの警告条件にも届かない
        st = load_state(session_id)
        last_fast = int(st.get("last_ctx", 0) or 0)
        if last_fast and (ctx_fast - last_fast) < REWARN_GROWTH:
            sys.exit(0)  # debounce（フルパースする前に黙ると分かる）
        # composition 静穏キャッシュ: 前回フルパースが「警告なし」で終わり、以後のファイル
        # 増分が小さい（<256KB）なら占有比率はほぼ動かないため走査を省く。
        # 警告の発火が最大その増分ぶん遅れうるのは許容（助言用の警告のため）。
        try:
            size_now = os.path.getsize(tpath)
        except Exception:
            size_now = None
        if (
            size_now is not None
            and st.get("comp_quiet")
            and isinstance(st.get("comp_size"), int)
            and 0 <= size_now - st["comp_size"] < 262144
            and ctx_fast < SIZE_THRESHOLD
        ):
            sys.exit(0)

    branch = None
    first_user = None
    last_usage = None
    text_assistant = 0
    text_user = 0
    tool_result_est = 0
    tool_input_est = 0
    tooluse_by_id = {}     # id -> (name, detail)
    heavy = []             # (est, detail) tool_result のみ（=居残りやすい読み込み素材）

    try:
        with open(tpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("gitBranch"):
                    branch = d["gitBranch"]

                # 2026-07-02: /compact・自動要約の境界。これ以前の内容はライブ
                # コンテキストから消えているのに積算し続けると誤検知するため、
                # 境界を跨いだら composition 集計をリセットする（要約文は境界の
                # 後に user メッセージとして来るので自然に再集計される）。
                if d.get("type") == "system" and d.get("subtype") == "compact_boundary":
                    text_assistant = 0
                    text_user = 0
                    tool_result_est = 0
                    tool_input_est = 0
                    tooluse_by_id = {}
                    heavy = []
                    continue

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
                                text_assistant += est_tokens(p.get("text", ""))
                            elif p.get("type") == "tool_use":
                                name = p.get("name", "?")
                                tid = p.get("id")
                                inp = p.get("input", {}) or {}
                                detail = name
                                if name == "Read" and inp.get("file_path"):
                                    detail = f"Read {inp['file_path']}"
                                elif name in ("Grep", "Glob") and inp.get("pattern"):
                                    detail = f"{name} {str(inp['pattern'])[:40]}"
                                elif name == "Bash" and inp.get("command"):
                                    detail = f"Bash: {str(inp['command'])[:50]}"
                                elif name == "Task" and inp.get("description"):
                                    detail = f"Task: {str(inp['description'])[:50]}"
                                elif name.startswith("mcp__"):
                                    detail = name.split("__")[-1]
                                if tid:
                                    tooluse_by_id[tid] = (name, detail)
                                tool_input_est += est_tokens(inp)

                elif d.get("type") == "user":
                    if (
                        first_user is None
                        and not d.get("isMeta")
                        and isinstance(content, str)
                        and content.strip()
                        and not content.lstrip().startswith("<")
                    ):
                        first_user = content.strip().replace("\n", " ")[:60]
                    if isinstance(content, list):
                        for p in content:
                            if not isinstance(p, dict):
                                continue
                            if p.get("type") == "tool_result":
                                tid = p.get("tool_use_id")
                                name, detail = tooluse_by_id.get(tid, ("?", "?"))
                                t = est_tokens(p.get("content"))
                                tool_result_est += t
                                if t >= 3000:
                                    heavy.append((t, detail))
                            elif p.get("type") == "text":
                                text_user += est_tokens(p.get("text", ""))
    except Exception:
        sys.exit(0)

    if not last_usage:
        sys.exit(0)

    # 現コンテキスト = 直近に実際に送った入力総量（実測）
    ctx = (
        last_usage.get("input_tokens", 0)
        + last_usage.get("cache_read_input_tokens", 0)
        + last_usage.get("cache_creation_input_tokens", 0)
    )

    content_est = text_assistant + text_user + tool_result_est + tool_input_est
    share = (tool_result_est / content_est) if content_est else 0.0

    size_hit = ctx >= SIZE_THRESHOLD
    comp_hit = (ctx >= COMP_FLOOR) and (share >= COMP_RATIO)

    if not size_hit and not comp_hit:
        # 静穏で終了 → 次回以降の高速路キャッシュ用に「警告なしだった時点のサイズ」を記録
        try:
            save_state(session_id, comp_quiet=True, comp_size=os.path.getsize(tpath))
        except Exception:
            pass
        sys.exit(0)

    # debounce: 前回警告から十分増えていなければ黙る（連打防止）
    # ctx < last は compact / rewind でコンテキストが縮んだ証拠。そのまま比較すると
    # 差が負のまま固定され再警告が永久に死ぬため、状態をリセットして計測し直す。
    last = int(load_state(session_id).get("last_ctx", 0) or 0)
    if last and ctx < last:
        save_state(session_id, last_ctx=0)
        last = 0
    if last and (ctx - last) < REWARN_GROWTH:
        sys.exit(0)

    sid = session_id[:8] if session_id else "????????"

    # ── compact-save 実行状態の機械チェック（2026-07-15 閣下指示・memory id 2024 の強制化）
    # /compact を案内する前に compact-save が済んでいるかを Claude の自己申告に頼らず判定し、
    # 警告文に事実として明示する。閣下は訴求されたら必ず /compact を実行するため、
    # 準備なしの案内 = 保存漏れ事故に直結する。
    import time
    ss_path = os.path.join(os.path.expanduser("~"), ".claude", "session-state", f"{session_id}.md")
    try:
        age_min = (time.time() - os.path.getmtime(ss_path)) / 60.0
        save_status = f"compact-save 保存済み（{ss_path}・約{age_min:.0f}分前）。その後に新たな判断・状態変化があれば再実行してから案内する。"
    except OSError:
        save_status = "compact-save 未実行（state file なし）。"
    compact_gate = (
        f"   【/compact 案内の前提条件（恒久ルール・違反禁止）】現在の状態: {save_status}\n"
        f"   /compact に言及・案内する場合は、その同一ターン内で先に compact-save skill を実行完了し、\n"
        f"   保存先パスを添えてから案内すること。未実行のまま /compact の案内文言を出すことを禁止する\n"
        f"   （「保存してから圧縮します」という予告も不可 — 先に実行する。ユーザーは訴求されたら即実行するため）。"
    )

    k = ctx / 1000.0
    pct = (ctx / WINDOW * 100.0) if WINDOW else 0.0
    label = f"session {sid}"
    if branch:
        label += f" / {branch}"
    if first_user:
        label += f' / 「{first_user}」'

    lines = []
    if size_hit:
        lines.append(
            f"⚠️ コンテキスト容量: 約 {k:,.0f}K / {WINDOW/1000:,.0f}K "
            f"（{pct:.0f}%・閾値 {WARN_RATIO:.0%}超。自動compactは約90%で発火）（{label}）。\n"
            f"→ [Claude への指示] 会話内容の「陳腐化度」で最適手を1つ選んで提案すること:\n"
            f"   ・同じ作業を継続する（既定・まず検討）→ 作業の区切りで compact-save skill（圧縮準備）で\n"
            f"     判断ログ・フェーズ・却下案を保存 → ユーザーに /compact を案内（圧縮後の復旧は hook が自動注入）。\n"
            f"     自動compactに先を越されると保存なしで文脈が落ちるため、余力のあるうちに勧めること。\n"
            f"   ・陳腐化・無関係になった情報が多い（残す価値のある文脈が少ない）\n"
            f"     → handoff skill で必要分だけ引き継ぎ文書に残してから /clear（一掃して仕切り直し）\n"
            f"   ・後で同じ文脈に戻る可能性 → /resume 用に温存（clear しない）\n"
            f"   注意: /clear は動作中の常駐監視・バックグラウンドタスクを停止させる（/compact なら生存）。\n"
            f"   停止して困るものが無いか確認してから提案すること。\n"
            f"   判断が付かないときだけ選択肢を併記する（既定は状況からの単一提案）。\n"
            + compact_gate
        )

    if comp_hit:
        top = sorted(heavy, key=lambda x: x[0], reverse=True)[:8]
        inv = "\n".join(f"    - ~{t/1000:.0f}K  {detail}" for t, detail in top) or "    （個別の重い項目なし）"
        lines.append(
            f"🔎 読み込み素材(tool_result)が現コンテキストの約 {share*100:.0f}% を占有"
            f"（約 {k:,.0f}K 中）。レビュー/コード読み込みの残骸が居残っている可能性。\n"
            f"  居残り候補（上位）:\n{inv}\n"
            f"  → [Claude への指示] 直近の作業文脈とこの一覧を自分で照合し（候補が多く判断に迷うときだけ\n"
            f"     安価モデルの Agent に委譲可）、現在の作業と明確に無関係なものだけを名指しした上で、\n"
            f"     会話の陳腐化度で使い分けて提案すること:\n"
            f"       ・必要な情報は残しつつ容量だけ節約したい（同じ作業を継続・既定）\n"
            f"         → compact-save skill（圧縮準備）で判断・状態を保存してから /compact を案内\n"
            f"       ・その居残り素材を含め、陳腐化・無関係な情報が会話の多くを占める\n"
            f"         → handoff skill で必要分だけ引き継ぎ文書に残してから /clear（一掃して仕切り直し）\n"
            f"       ・後で同じ文脈に戻る可能性 → /resume 用に温存（clear しない）\n"
            f"     注意: /clear は動作中の常駐監視・バックグラウンドタスクを停止させる（/compact なら生存）。\n"
            f"     関連性が曖昧なものは挙げない（precision 優先・誤検出は信頼を壊す）。\n"
            + compact_gate
        )

    lines.append(f'詳しい内訳: python3 ~/.claude/hooks/context-weight-report.py "{tpath}"')

    print("\n".join(lines))
    save_state(session_id, last_ctx=ctx, comp_quiet=False)
    sys.exit(0)


if __name__ == "__main__":
    main()
