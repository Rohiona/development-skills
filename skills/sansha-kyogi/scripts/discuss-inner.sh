#!/usr/bin/env bash
# discuss-inner.sh — Codex ⇄ Cursor のファイルベース議論を 1 サイクル回す内側ドライバ。
#
# 設計意図（重要）:
#   - 核となる原則は「他人の意見を先に聞かせない」。まず各 AI に自力で考えさせ、出揃ったところで
#     “せーの”で突き合わせてから議論させる（先発の意見に後発が引きずられるアンカリングを排除）。
#   - フェーズ構成:
#       1) 独立開陳（ブラインド・並列）: Codex と Cursor が【互いを見ずに】topic だけを読んで独立見解を出す。
#       2) せーの開示 ＋ Claude 見解の注入: 両者の独立見解を同時に transcript へ載せ、続けて
#          人間(Claude)の見解 claude-view.md があれば注入する（＝3 見解が俎上に乗る「2対1」の土俵）。
#       3) 議論: Codex⇄Cursor が【自分・相手・Claude の 3 見解すべて】をメリット/デメリットで比較し、
#          理由づきで合意できたときだけ RESOLVED: yes を出す（体裁だけの礼儀的合意は禁止）。
#          先攻はラウンドごとに交代（奇数=Codex、偶数=Cursor。先攻固定の系統バイアスを除去）。
#   - 合意の機械ゲート: 各議論ターンは末尾に AGREE_ON / REMAINING_OBJECTIONS / RESOLVED の 3 タグ必須
#     （欠落時は 1 回だけ再要求）。RESOLVED は【最後の宣言行】だけを見る（本文中の引用で誤判定しない）。
#     さらに「RESOLVED: yes は REMAINING_OBJECTIONS: none のときのみ有効」を driver が強制
#     ＝相違を残したままの礼儀的 yes を機械的に弾く。
#   - トークン抑制: Round 3 以降のプロンプト文脈は「独立開陳＋Claude 見解＋中間ラウンドのタグ要約＋
#     直前ラウンド以降の全文」に圧縮する（transcript.md 自体は全文ログのまま＝観戦・distiller は不変）。
#   - 各エージェントの作業ルートは <repo>（指定時）＝実コードベースを直接 read-only で読める。
#     議論コンテキスト(topic/claude-view/transcript)はプロンプトに inline 埋め込みで渡す
#     （/tmp の議論 dir を跨いで読ませる sandbox 問題を避けるため）。各発言の出力はドライバが回収する。
#   - Claude(メイン) は本スクリプトを background で起動し、生の往復は読まない。読むのは status(1 行)と
#     conclusion.md(終結時のみ)だけ＝Claude のトークン消費を最小化。conclusion.md の末尾には
#     最終ラウンドの各自の宣言タグを driver が【機械抽出・改変なし】で付記する＝distiller の要約ズレを
#     Claude が低コストで照合できる（spot-check の代替・LLM 呼び出し増ゼロ）。
#   - Claude は「2対1」の 1（主・外側）であり、見解は claude-view.md として注入し、内側の結論に
#     反論があれば外側ループで差し戻す（ラリー）。
#   - 終結シグナル status: RUNNING / REACHED(両者が理由づき・残存相違なしで合意宣言) / CAPPED(上限到達・未合意)。
#   - 両エージェントとも read-only（Codex: -s read-only / Cursor: --mode ask）。副作用なし。
#
# Usage:
#   discuss-inner.sh <dir> [repo] [max_rounds] [distiller: codex|cursor] [timeout_sec]
#     <dir>   議論ディレクトリ（topic.md 必須・claude-view.md 任意。transcript/status/conclusion をここに生成）
#     [repo]  協議対象のコードベース root（worktree/ブランチのパス）。"-" or 省略でコード無し(一般論)
#     [max_rounds] 議論フェーズの往復上限（既定 4）
#     [distiller]  結論を書く担当 codex|cursor（既定 codex）
#     [timeout_sec] 各エージェント 1 回呼び出しの timeout 秒（既定 600）

set -uo pipefail

DIR="${1:?usage: discuss-inner.sh <dir> [repo] [max_rounds] [distiller] [timeout_sec]}"
REPO="${2:--}"
MAX_ROUNDS="${3:-4}"
DISTILLER="${4:-codex}"
TO="${5:-600}"

CODEX="$HOME/.claude/skills/codex/scripts/codex-exec.sh"
MODEL_CURSOR="composer-2.5"
TRANSCRIPT="$DIR/transcript.md"
STATUS="$DIR/status"
CLAUDE_VIEW="$DIR/claude-view.md"

[ -d "$DIR" ]          || { echo "ERROR: dir not found: $DIR" >&2; exit 64; }
[ -f "$DIR/topic.md" ] || { echo "ERROR: topic.md missing in $DIR" >&2; exit 64; }
[ -x "$CODEX" ]        || { echo "ERROR: codex wrapper not executable: $CODEX" >&2; exit 64; }
command -v cursor >/dev/null 2>&1 || { echo "ERROR: cursor CLI not found" >&2; exit 64; }

# --- 作業ルートの決定: repo 指定があれば実コードベース、無ければ議論 dir（一般論） ---
if [ "$REPO" = "-" ] || [ -z "$REPO" ]; then
	ROOT="$DIR"
	CODE_CTX="（コードベースは付与されていません。一般論として論じてください）"
else
	ROOT="$REPO"
	CODE_CTX="あなたは協議対象リポジトリ「$REPO」のコードを直接 read-only で読めます。推測で語らず、必ず関連コードを実際に確認し、主張は具体的な file:line を引いて論じてください。両 AI は同一のコードベース($REPO)を見ています。"
fi
[ -d "$ROOT" ] || { echo "ERROR: root dir not found: $ROOT" >&2; exit 64; }

touch "$TRANSCRIPT"
echo "RUNNING" > "$STATUS"

# --- エージェント起動（出力はファイルへ。本体 stdout は捨てる＝Claude 文脈に乗せない） ---
run_codex() {  # $1=outfile  $2=prompt
	# --skip-git-repo-check: ROOT が非 git(議論 dir 等)でも実行できるように常時付与（git repo では無害）
	"$CODEX" "$TO" exec -s read-only --skip-git-repo-check -C "$ROOT" -o "$1" "$2" >/dev/null 2>&1
}
run_cursor() { # $1=outfile  $2=prompt
	timeout "$TO" cursor agent -p --output-format text --trust --mode ask \
		--workspace "$ROOT" --model "$MODEL_CURSOR" "$2" >"$1" 2>/dev/null
}
run_agent() {  # $1=agent(codex|cursor)  $2=outfile  $3=prompt
	if [ "$1" = "codex" ]; then run_codex "$2" "$3"; else run_cursor "$2" "$3"; fi
}

# --- 宣言タグの機械判定（末尾宣言のみ有効・引用に騙されない） ---
last_tag() { # $1=file $2=TAG名 → そのタグの【最後の】行を出力（無ければ空）
	grep -iE "^[[:space:]]*${2}:" "$1" 2>/dev/null | tail -1
}
has_tags() { # 議論ターンに必須 3 タグが全て存在するか
	[ -n "$(last_tag "$1" AGREE_ON)" ] \
		&& [ -n "$(last_tag "$1" REMAINING_OBJECTIONS)" ] \
		&& [ -n "$(last_tag "$1" RESOLVED)" ]
}
resolved_yes() { # RESOLVED: yes かつ REMAINING_OBJECTIONS: none のときだけ真（整合ゲート）
	last_tag "$1" RESOLVED | grep -qiE ':[[:space:]]*yes' || return 1
	last_tag "$1" REMAINING_OBJECTIONS | sed -E 's/^[^:]*:[[:space:]]*//' \
		| grep -qiE '^(none|なし|無し)[[:space:]]*(。|\.)?[[:space:]]*$'
}

run_debate_turn() { # $1=agent $2=outfile $3=prompt — タグ欠落時は 1 回だけ再要求
	run_agent "$1" "$2" "$3"
	if [ -s "$2" ] && ! has_tags "$2"; then
		run_agent "$1" "$2" "$3

【再出力要求（フォーマット違反）】直前のあなたの出力には必須の末尾タグ（AGREE_ON: / REMAINING_OBJECTIONS: / RESOLVED:）が欠けていました。主張内容は同じでよいので、末尾タグ 3 行を必ず付けて全文を出力し直してください。"
	fi
}

# --- フェーズ1: 独立開陳プロンプト（相手の意見は一切見せない＝ブラインド） ---
build_open_prompt() { # $1=自分の名前
	printf '%s\n' "あなたは「$1」です。これからある論点について、もう一方の AI と議論します。"
	printf '%s\n' "ただし【今この瞬間は、まだ誰の意見も見ていません】。まず自力で結論を出してください（他者の意見に引きずられないための独立開陳フェーズです）。"
	printf '%s\n\n' "$CODE_CTX"
	printf '# 論点・前提・事実\n'
	cat "$DIR/topic.md"
	cat <<'EOS'

# あなたへの指示（独立開陳）
論点に対するあなた自身の見解（立場）と、その理由を明確に述べてください。
- なぜその結論なのか・なぜその方法が良いのか／必要なのかを、根拠を添えて論証すること。
- コードベースが付与されている場合は、推測でなく実コード(file:line)を確認した事実に基づくこと。
- この段階では合意/反論の判定（RESOLVED 等のタグ）は不要です。自分の考えを率直に出すことに集中してください。
- 冗長にせず要点を論証すること。ファイルは編集しないこと（read-only・意見の出力のみ）。
EOS
}

# --- 議論文脈の組み立て（Round 3 以降はタグ要約で圧縮。transcript.md 自体は常に全文） ---
emit_section() { # $1=見出し $2=file $3=full|tags
	echo
	echo "## $1"
	echo
	if [ "$3" = "full" ]; then
		if [ -s "$2" ]; then cat "$2"; else echo "(no output)"; fi
	else
		grep -iE '^[[:space:]]*(AGREE_ON|REMAINING_OBJECTIONS|RESOLVED):' "$2" 2>/dev/null || echo "(宣言タグなし)"
	fi
	echo
}
build_context() { # $1=現在ラウンド r。完成済みターンを時系列で出力（古い中間ラウンドはタグのみ）
	local r="$1" i a f mode order
	# 独立開陳と Claude 見解は常に全文（せーのの土台・各自の立場の原典）
	emit_section "独立開陳（せーの・互いに未見）— Codex" "$DIR/p1.codex.md" full
	emit_section "独立開陳（せーの・互いに未見）— Cursor" "$DIR/p1.cursor.md" full
	if [ -s "$CLAUDE_VIEW" ]; then
		emit_section "人間(Claude)の見解（議論の俎上に対等に載せる）" "$CLAUDE_VIEW" full
	fi
	for i in $(seq 1 "$r"); do
		if [ $((i % 2)) -eq 1 ]; then order="codex cursor"; else order="cursor codex"; fi
		for a in $order; do
			f="$DIR/r${i}.${a}.md"
			[ -s "$f" ] || continue
			if [ "$i" -ge $((r - 1)) ]; then mode="full"; else mode="tags（発言全文は省略・宣言タグのみ）"; fi
			if [ "$mode" = "full" ]; then
				emit_section "Round $i — $a" "$f" full
			else
				emit_section "Round $i — $a （宣言タグのみ・全文省略）" "$f" tags
			fi
		done
	done
}

# --- フェーズ3: 議論プロンプト（3 見解が俎上にある状態で、理由づき合意のみを許す規律） ---
build_debate_prompt() { # $1=自分の名前  $2=相手の名前  $3=現在ラウンド
	printf '%s\n' "あなたは「$1」です。もう一方の AI「$2」と議論しています。独立開陳は出揃いました。"
	printf '%s\n' "俎上には【あなた・$2・人間(Claude)】の 3 つの見解があります（Claude の見解が無い場合は 2 つ）。Claude の見解も対等に扱い、「Claude だから正しい」とはしないこと。"
	printf '%s\n\n' "$CODE_CTX"
	printf '# 論点・前提・事実\n'
	cat "$DIR/topic.md"
	printf '\n# これまでの議論（独立開陳 → 以降の往復。古いラウンドは宣言タグのみに圧縮されている場合があります）\n'
	build_context "$3"
	cat <<'EOS'

# あなたへの指示（議論フェーズ・規律）
1. 自案の論証: なぜその案が良いか/必要かを、根拠(コード付与時は file:line)を添えて述べる。
2. 明示的な比較: 相手案・Claude 案それぞれについて、自案より優れている理由／劣っている理由を必ず両方検討する。
   相手の論拠を正しく理解した（要約して見せる）うえで応答すること。
3. 合意の条件（厳格）: 体裁を整えるだけの同調・合理性のない譲歩は禁止。
   納得できない点が 1 つでも残るなら合意しないこと。
コードベースが付与されている場合は、推測でなく実コード(file:line)を確認した事実に基づいて論じること。
冗長にせず要点を論証すること。ファイルは編集しないこと（read-only・意見の出力のみ）。

メッセージの最後に、必ず次の 3 行を（この順で・各 1 行で）出力してください:
AGREE_ON: <現時点で相手と合意できている点の一行要約。無ければ none>
REMAINING_OBJECTIONS: <まだ合理的に納得できていない相違点の一行要約。無ければ none>
RESOLVED: yes または no
注意: RESOLVED: yes と書けるのは REMAINING_OBJECTIONS: none のときだけです（相違が 1 つでも残るなら必ず no）。
EOS
}

build_distill_prompt() {
	printf '%s\n' "次の議論ログを読み、日本語で簡潔にまとめてください。"
	printf '%s\n' "形式: 【合意点】【未解決の相違点】【結論】の 3 見出し。新しい意見や根拠を足さず、ログに実在する内容だけを要約すること。ファイルは編集しない。"
	printf '\n# 議論ログ\n'
	cat "$TRANSCRIPT"
}

append() { # $1=見出し  $2=発言ファイル — transcript.md は常に全文ログ（観戦・distiller 用）
	{
		echo
		echo "## $1"
		echo
		if [ -s "$2" ]; then cat "$2"; else echo "(no output — agent returned empty / errored)"; fi
		echo
	} >> "$TRANSCRIPT"
}
note_gate() { # $1=発言ファイル $2=agent名 — yes 宣言が整合ゲートで弾かれたことを観戦ログに残す
	if last_tag "$1" RESOLVED | grep -qiE ':[[:space:]]*yes' && ! resolved_yes "$1"; then
		echo "（driver 注: $2 は RESOLVED: yes を宣言したが REMAINING_OBJECTIONS が none でないため、未合意として扱う）" >> "$TRANSCRIPT"
	fi
}

# ===================== フェーズ1: 独立開陳（ブラインド・並列） =====================
# 「せーの」で考えさせるため、両者を相手の出力を見せずに同時並行で起動する。
p1cx="$DIR/p1.codex.md"
p1cu="$DIR/p1.cursor.md"
run_codex  "$p1cx" "$(build_open_prompt codex)"  &
run_cursor "$p1cu" "$(build_open_prompt cursor)" &
wait
echo "phase1 (independent opening) done"

# ===================== フェーズ2: せーの開示 ＋ Claude 見解の注入 =====================
append "独立開陳（せーの・互いに未見）— Codex" "$p1cx"
append "独立開陳（せーの・互いに未見）— Cursor" "$p1cu"
if [ -s "$CLAUDE_VIEW" ]; then
	append "人間(Claude)の見解（議論の俎上に対等に載せる）" "$CLAUDE_VIEW"
fi

# ===================== フェーズ3: 議論（先攻はラウンド交代・理由づき合意のみ） =====================
final="CAPPED"
for r in $(seq 1 "$MAX_ROUNDS"); do
	# 先攻の系統バイアスを除去: 奇数ラウンド=Codex 先攻 / 偶数ラウンド=Cursor 先攻
	if [ $((r % 2)) -eq 1 ]; then order="codex cursor"; else order="cursor codex"; fi

	for a in $order; do
		peer="codex"; [ "$a" = "codex" ] && peer="cursor"
		f="$DIR/r${r}.${a}.md"
		run_debate_turn "$a" "$f" "$(build_debate_prompt "$a" "$peer" "$r")"
		append "Round $r — $a" "$f"
		note_gate "$f" "$a"
	done

	echo "round $r done"

	if resolved_yes "$DIR/r${r}.codex.md" && resolved_yes "$DIR/r${r}.cursor.md"; then
		final="REACHED"
		break
	fi
done

# --- 結論の蒸留（distiller が transcript 全文を要約。新規意見は足さない） ---
if [ "$DISTILLER" = "cursor" ]; then
	run_cursor "$DIR/conclusion.md" "$(build_distill_prompt)"
else
	run_codex  "$DIR/conclusion.md" "$(build_distill_prompt)"
fi
[ -s "$DIR/conclusion.md" ] || echo "(distiller returned empty — see transcript.md)" > "$DIR/conclusion.md"

# --- 機械抽出の付記（改変なし・LLM 不使用）: distiller の要約ズレを Claude が照合するための正本 ---
{
	echo
	echo "---"
	echo "（driver 機械抽出・改変なし: 最終ラウンドの各自の宣言タグ。上の要約と食い違う場合はこちらが正）"
	for a in codex cursor; do
		f=$(ls "$DIR"/r*."$a".md 2>/dev/null | sort -V | tail -1)
		echo "- $a:"
		if [ -n "$f" ]; then
			grep -iE '^[[:space:]]*(AGREE_ON|REMAINING_OBJECTIONS|RESOLVED):' "$f" | sed 's/^/    /'
		else
			echo "    (発言なし)"
		fi
	done
} >> "$DIR/conclusion.md"

echo "$final" > "$STATUS"
echo "STATUS=$final"
