#!/usr/bin/env python3
"""verify-extraction — 抽出後の自己検証ゲート(extraction_verify)の機械照合部。

`testability_inventory` で「抽出」と裁定した単位が、本当にテスト可能な構成になったかを
**実測で機械照合**する。AI の自己申告（compliance theater）に堕さないための歯止め。
lens-lint.py の姉妹：lens-lint が「学習観点の劣化」を検査するのに対し、これは「抽出結果の構造」を検査する。

判定不能（ファイルが読めない/パースできない等）は PASS でも FAIL でもなく **UNVERIFIED(WARN)** に倒す
（黙って PASS = compliance theater / 一律 FAIL = 過剰ブロック の両方を避ける）。

--- できること（機械確定シグナルのみ）---
  F1 完全移動      : 抽出シンボルの定義が元ファイルに残っていない（残骸=二重定義の検出。クラスメソッド構文含む）
  F2 直接 import   : 元ファイルが新モジュールから抽出シンボルを import して使っている
  F3 pure→mock 0   : 「純粋」と裁定した単位のテストに mock/spy が 0（純粋のはずがモック要 = 分割線の誤り）
  F6 tautology     : tautology-test-detector の prefilter を抽出テストに当て、明白な無意味テストの兆候を拾う
  W1 eager test    : 1テストが叩く production 呼び出し数（責務未分割の兆候。閾値既定3）
  W2 side-effect   : 「純粋」単位のモジュールに I/O・時刻・乱数の痕跡
  W3 unchecked-cast: モジュール内の裸の `as` キャスト（検証せず型を宣言 = parse, don't validate 違反の疑い）
  W4 di-violation  : 非 pure 単位が依存を内部生成/直接参照（new XxxClient・process.env 等 = 注入不能でモック不可）
  W5 naming        : generic bucket 名のモジュール（utils/helpers 等）・And/Then 複合のシンボル名（多責務・雑多寄せ場の疑い）
  --list-mutations : F7 micro-mutation 用に、モジュールから**決定的な**変異点を列挙（恣意的変異の防止）
  --list-units     : 対象ファイルの private/protected メソッド・ローカル関数を機械列挙
                     （testability_inventory の網羅性チェック用。列挙された全単位が棚卸し表に載ること）

--- できないこと（§7a で AI が手続きで回す）---
  F5 tsc/jest green: 対象パッケージのツールチェーンが要る → §7b で実行
  F7 実変異＆再実行 : このスクリプトは変異点を列挙するだけ。適用・テスト再実行・revert は AI が回す

使い方:
  verify-extraction.py --source <元file> --module <新file> --symbol <名> [--symbol ...] \
      --test <testfile> [--test ...] [--pure] [--eager-threshold 3]
  verify-extraction.py --list-mutations --module <新file> --symbol <名>
  verify-extraction.py --list-units --file <対象file> [--file ...]

終了コード: 構造 FAIL が 1 件でもあれば 1 / それ以外（PASS or WARN のみ）は 0。
"""

import argparse
import os
import re
import subprocess
import sys

TAUTOLOGY_PREFILTER = os.path.expanduser(
	"~/.claude/skills/tautology-test-detector/scripts/prefilter.sh"
)

# テストに現れたら「モック/スタブを使っている」と見なすシグナル
MOCK_MARKERS = [
	r"\bjest\.mock\b", r"\bvi\.mock\b", r"\bjest\.fn\b", r"\bvi\.fn\b",
	r"\bspyOn\b", r"\.mockResolvedValue\b", r"\.mockReturnValue\b",
	r"\.mockImplementation\b", r"\bcreateMock\b", r"\bmockDeep\b",
	r"as\s+jest\.Mocked", r"\bMocked<", r"\b__mocks__\b",
]

# 「純粋」単位に現れたら副作用の疑い
SIDE_EFFECT_MARKERS = [
	r"\bfs\.", r"\bfetch\(", r"\baxios\b", r"\bDate\.now\(", r"new\s+Date\(",
	r"\bMath\.random\(", r"\bprocess\.env\b", r"\.query\(", r"\.execute\(",
	r"\bconsole\.", r"\bsetTimeout\(", r"\bawait\s+\w+\.(save|find|insert|update|delete|send|publish)\b",
]

# W3: 裸の as キャスト。境界は宣言でなく検証（type guard / parse）で絞る。
# 除外 = as const / as unknown / as never / as readonly（widening 方向で安全なイディオム）。
# 識別子のほか `as { ... }`（オブジェクト型リテラル）・`as (`（関数型/括弧型）も拾う。
CAST_PATTERN = re.compile(r"\bas\s+(?!const\b|unknown\b|never\b|readonly\b)(?:[A-Za-z_][\w.]*|\{|\()")

# W4: 非 pure 単位が依存を内部生成/直接参照している痕跡（テストで差し替え不能 = モック不可）
DI_VIOLATION_MARKERS = [
	r"\bnew\s+[A-Z]\w*(?:Client|Repository|Repo|Service|Store|Queue|Producer|Consumer|Dispatcher|Connection|Pool|Sdk|Api)\b",
	r"\bcreateDatabaseAuto\s*\(",
	r"\bprocess\.env\b",
	r"from\s+['\"]axios['\"]",
	r"from\s+['\"]@aws-sdk/",
]

# W5: 命名の下限チェック。generic bucket 名のモジュール（雑多寄せ場=論理的凝集の温床）と
# And/Then 複合のシンボル名（SKILL.md「名前に『と』が要るなら多責務」の機械化）を WARN する。
GENERIC_MODULE_NAMES = {"util", "utils", "helper", "helpers", "common", "misc", "shared", "lib", "stuff"}
AND_COMPOSITE = re.compile(r"[a-z](?:And|Then)[A-Z]")

# F7: 決定的（=恣意的でない）1点変異のペア。左が現れたら右へ差し替える候補を1つずつ提示。
MUTATIONS = [
	("<=", "<"), (">=", ">"), ("===", "!=="), ("!==", "==="),
	("&&", "||"), ("|| ", "&& "), ("true", "false"), ("false", "true"),
	(" + 1", " - 1"), (" - 1", " + 1"), (".length", ".length + 1"),
]


def read(path):
	with open(path, "r", encoding="utf-8") as f:
		return f.read()


def strip_code_noise(text, strip_strings=False):
	"""コメント（// と /* */）を空白化し、strip_strings=True なら文字列リテラルの中身も空白化する。

	誤検知対策（2026-07-08 echo 実コーパス計測: W3 ヒットの 6.5% がコメント/文字列内の英文 `as`、
	W4 の 2.0% がコメントアウトされた旧コード）。行数・桁位置は空白置換で保持するので行番号報告は不変。
	テンプレートリテラルの ${...} 内は生きたコードなので blank しない（`${process.env.X}` は実参照）。
	正規表現リテラルと除算の曖昧性は扱わない近似（`//` 始まりの正規表現は実質出現しない）。
	"""
	out = list(text)
	n = len(text)

	def blank(a, b):
		for k in range(a, min(b, n)):
			if out[k] != "\n":
				out[k] = " "

	i = 0
	while i < n:
		c = text[i]
		two = text[i : i + 2]
		if two == "//":
			j = text.find("\n", i)
			j = n if j == -1 else j
			blank(i, j)
			i = j
		elif two == "/*":
			j = text.find("*/", i + 2)
			j = n if j == -1 else j + 2
			blank(i, j)
			i = j
		elif c in ("'", '"'):
			j = i + 1
			while j < n and text[j] not in (c, "\n"):
				if text[j] == "\\":
					j += 1
				j += 1
			if strip_strings:
				blank(i + 1, j)
			i = j + 1
		elif c == "`":
			j = i + 1
			seg_start = j
			while j < n:
				if text[j] == "\\":
					j += 2
					continue
				if text[j] == "`":
					break
				if text[j : j + 2] == "${":
					if strip_strings:
						blank(seg_start, j)
					depth = 1
					k = j + 2
					while k < n and depth:
						if text[k] == "{":
							depth += 1
						elif text[k] == "}":
							depth -= 1
						k += 1
					j = k
					seg_start = j
					continue
				j += 1
			if strip_strings:
				blank(seg_start, j)
			i = j + 1
		else:
			i += 1
	return "".join(out)


def def_patterns(sym):
	"""元ファイルに残っていたら「定義の残骸」と見なすパターン（import/再export は除外して後段で判定）。"""
	s = re.escape(sym)
	return [
		re.compile(rf"\bfunction\s+{s}\b"),
		re.compile(rf"\b(const|let|var)\s+{s}\s*="),
		re.compile(rf"\bclass\s+{s}\b"),
		re.compile(rf"\b{s}\s*=\s*(async\s*)?\("),  # const 省略の再代入や method 定義風
		# クラスメソッド構文の残骸（このスキルの最頻出抽出元）: private foo(... / async foo(... / get foo(...
		re.compile(rf"^\s*(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set)\s+)+{s}\s*(?:<[^>]*>)?\s*\("),
		# 修飾子なしメソッド定義: foo(args): T { — 呼び出し文と区別するため同一行の本体開始 `{` を要求（複数行シグネチャは上の修飾子付きで拾う）
		re.compile(rf"^\s*{s}\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^={{;]+)?\s*\{{"),
	]


IMPORT_LINE = re.compile(r"^\s*import\b|^\s*export\b.*\bfrom\b")


def check(args):
	rows = []  # (severity, check, unit, detail)  severity: FAIL / WARN / PASS / UNVERIFIED

	def add(sev, chk, unit, detail):
		rows.append((sev, chk, unit, detail))

	# ---- F1 完全移動 / F2 直接 import（--source があるときだけ）----
	src_text = None
	if args.source:
		try:
			# コメントアウトされた旧コード（`// private foo(...` 等）を残骸と誤認しないようコメントを除外
			src_text = strip_code_noise(read(args.source))
		except Exception as e:
			add("UNVERIFIED", "F1/F2", args.source or "-", f"元ファイルを読めない: {e}")
	if src_text is not None:
		src_lines = src_text.splitlines()
		for sym in args.symbol:
			# F1: import/export-from 行を除いた本文に定義パターンが残っていたら残骸=FAIL
			residual = []
			for i, ln in enumerate(src_lines, 1):
				if IMPORT_LINE.search(ln):
					continue
				if any(p.search(ln) for p in def_patterns(sym)):
					residual.append(i)
			if residual:
				add("FAIL", "F1 完全移動", sym, f"元ファイルに定義の残骸 L{residual} （二重定義/未移動）")
			else:
				add("PASS", "F1 完全移動", sym, "元ファイルに定義なし")
			# F2: 元ファイルが sym を import し、本文で実際に使っているか。
			# workflow §7a の契約は「import して実際に呼んでいる」— import 行だけ残った未配線（dead import）を PASS にしない。
			# 「使用」は直接呼び出しに限らずコールバック参照渡し（`arr.map(sym)` 等）も配線と見なす。
			sym_pat = re.compile(rf"\b{re.escape(sym)}\b")
			imported = any(
				IMPORT_LINE.search(ln) and sym_pat.search(ln) and ln.lstrip().startswith("import")
				for ln in src_lines
			)
			reexported = any(
				IMPORT_LINE.search(ln) and sym_pat.search(ln) and not ln.lstrip().startswith("import")
				for ln in src_lines
			)
			used = any(sym_pat.search(ln) for ln in src_lines if not IMPORT_LINE.search(ln))
			if imported and used:
				add("PASS", "F2 直接 import", sym, "元ファイルが新モジュールから import し、本文で使用（呼び出し/参照）")
			elif imported:
				add("FAIL", "F2 直接 import", sym, "import はあるが本文で未使用（dead import＝未配線）")
			elif used:
				add("FAIL", "F2 直接 import", sym, "元ファイルで使用しているが import が無い（配線漏れ）")
			elif reexported:
				add("WARN", "F2 直接 import", sym, "再 export のみで本文使用なし（呼び元が別所か要確認）")
			else:
				add("WARN", "F2 直接 import", sym, "元ファイルに import も使用も無い（呼び元が別所か未配線か要確認）")

	# ---- F3 pure→mock 0 / F6 tautology / W1 eager（--test ごと）----
	for tpath in args.test:
		try:
			ttext = read(tpath)
		except Exception as e:
			add("UNVERIFIED", "F3/F6/W1", tpath, f"テストを読めない: {e}")
			continue
		mock_hits = [m for pat in MOCK_MARKERS for m in re.findall(pat, ttext)]
		if args.pure:
			if mock_hits:
				add("FAIL", "F3 pure→mock0", tpath, f"純粋と裁定したのに mock/spy を {len(mock_hits)} 件使用 → 分割線の誤り")
			else:
				add("PASS", "F3 pure→mock0", tpath, "mock/spy なしでテスト成立")
		else:
			add("WARN", "F3 pure→mock0", tpath, f"非 pure 宣言（mock {len(mock_hits)} 件・情報のみ）")

		# W1 eager test: it/test ブロックごとの production 呼び出し数
		blocks = re.split(r"\b(?:it|test)\s*\(", ttext)[1:]
		worst = 0
		for b in blocks:
			calls = set(re.findall(r"\b([a-z][A-Za-z0-9_]*)\s*\(", b))
			# expect/describe/系のテストAPIは除外
			calls -= {"expect", "it", "test", "describe", "beforeEach", "afterEach",
					 "beforeAll", "afterAll", "toBe", "toEqual", "toThrow", "vi", "jest"}
			worst = max(worst, len(calls))
		if worst >= args.eager_threshold:
			add("WARN", "W1 eager test", tpath, f"1テストが最大 {worst} 種の呼び出し（閾値{args.eager_threshold}）→ 責務未分割の疑い")

		# F6 tautology prefilter（あれば）
		if os.path.exists(TAUTOLOGY_PREFILTER):
			try:
				r = subprocess.run(["bash", TAUTOLOGY_PREFILTER, tpath],
								   capture_output=True, text=True, timeout=60)
				out = (r.stdout or "").strip()
				if out:
					add("WARN", "F6 tautology", tpath, "prefilter が候補を検出 → tautology-test-detector で adjudicate")
				else:
					add("PASS", "F6 tautology", tpath, "prefilter 候補なし")
			except Exception as e:
				add("UNVERIFIED", "F6 tautology", tpath, f"prefilter 実行不可: {e}")
		else:
			add("UNVERIFIED", "F6 tautology", tpath, "prefilter 未検出（tautology-test-detector を別途起動）")

	# ---- モジュール本文の走査（W2 純粋の副作用 / W3 裸の as キャスト / W4 依存の内部生成）----
	if args.module:
		mtext = None
		try:
			mtext = read(args.module)
		except Exception as e:
			add("UNVERIFIED", "W2/W3/W4", args.module, f"モジュールを読めない: {e}")
		if mtext is not None:
			mtext_nc = strip_code_noise(mtext)  # コメント除外（文字列は残す: `from 'axios'` や `${process.env.X}` は実コード）
			if args.pure:
				hits = [m for pat in SIDE_EFFECT_MARKERS for m in re.findall(pat, mtext_nc)]
				if hits:
					add("WARN", "W2 side-effect", args.module, f"純粋宣言のモジュールに副作用の痕跡 {len(hits)} 件 → 層混在の疑い")
				else:
					add("PASS", "W2 side-effect", args.module, "副作用の痕跡なし")
			# W3: import/export 行（`import { x as y }` 等）とコメント・文字列内の英文 `as` を除いた本文の裸 as キャスト
			casts = []
			for ln in strip_code_noise(mtext, strip_strings=True).splitlines():
				if IMPORT_LINE.search(ln):
					continue
				casts += CAST_PATTERN.findall(ln)
			if casts:
				add("WARN", "W3 unchecked-cast", args.module, f"裸の `as` キャスト {len(casts)} 件 → 検証して絞る（parse, don't validate。type guard / parse で返す）")
			else:
				add("PASS", "W3 unchecked-cast", args.module, "裸の as キャストなし")
			# W4: 非 pure（I/O 担当）単位は依存が注入可能でないとモックできない
			if not args.pure:
				di = [m for pat in DI_VIOLATION_MARKERS for m in re.findall(pat, mtext_nc)]
				if di:
					add("WARN", "W4 di-violation", args.module,
						f"依存の内部生成/直接参照の痕跡 {len(di)} 件 → 注入（コンストラクタ/引数）でモック可能に。"
						"ただし抽出単位が組み立て役（composition root / config モジュール）なら new・process.env はそこが定位置＝据え置き可")
				else:
					add("PASS", "W4 di-violation", args.module, "依存の内部生成なし（注入で差し替え可能とみられる）")

	# ---- W5 命名（generic bucket 名のモジュール / And・Then 複合のシンボル名）----
	if args.module:
		base = os.path.splitext(os.path.basename(args.module))[0]
		if base.lower() in GENERIC_MODULE_NAMES:
			add("WARN", "W5 naming", args.module,
				f"generic bucket 名のモジュール（{base}）→ 責務を一文で言い当てる名前に（雑多寄せ場は論理的凝集）")
		else:
			add("PASS", "W5 naming", args.module, "generic bucket 名でない")
	for sym in args.symbol:
		if AND_COMPOSITE.search(sym):
			add("WARN", "W5 naming", sym, "And/Then 複合名 → 多責務の疑い（名前に「と」が要るなら分割を再検討）")

	return rows


# --list-units: testability_inventory の網羅性チェック用の単位列挙
UNIT_KINDS = [
	("private/protected", re.compile(r"^\s*(?:private|protected)\s+(?:(?:static|async|readonly|override|get|set)\s+)*([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(")),
	("local function", re.compile(r"^\s*function\s+([A-Za-z_]\w*)")),
	("local arrow", re.compile(r"^\s*const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*(?::[^=]+)?=>")),
]

COMPLEXITY = re.compile(r"\b(?:if|for|while|switch|case|try|catch)\b|\?\.|&&|\|\||\.(?:map|filter|reduce|some|every)\(")


def body_extent(lines, start):
	"""start 行から brace バランスで本体の終端行を推定（文字列内 brace は無視する近似）。"""
	depth = 0
	opened = False
	for j in range(start, len(lines)):
		for ch in lines[j]:
			if ch == "{":
				depth += 1
				opened = True
			elif ch == "}":
				depth -= 1
		if opened and depth <= 0:
			return j
	return start


def list_units_cmd(args):
	"""対象ファイルの private/protected メソッド・非 export のローカル関数を機械列挙する。

	testability_inventory（棚卸し表）が全単位を裁いているかを、自己申告でなく列挙との突合で確認するための土台。
	export 済み関数・public メソッドは列挙対象外（前者は抽出の出力、後者は表へ手動で載せて裁く）。
	"""
	files = args.file or ([args.source] if args.source else [])
	if not files:
		print("--list-units には --file（複数可）が必要です", file=sys.stderr)
		return 2
	total = 0
	print("### unit_enumeration（testability_inventory 網羅性の機械列挙）")
	print("| 種別 | 単位 | ファイル | 行 | 本体行数(概算) | 分岐/変換シグナル |")
	print("|---|---|---|---|---|---|")
	for path in files:
		try:
			# コメントアウトされた旧メソッドを単位として列挙しない（行番号は blank 置換で保持される）
			lines = strip_code_noise(read(path)).splitlines()
		except Exception as e:
			print(f"| UNVERIFIED | - | `{path}` | - | - | 読めない: {e} |")
			continue
		for i, ln in enumerate(lines):
			if IMPORT_LINE.search(ln):
				continue
			for kind, pat in UNIT_KINDS:
				m = pat.search(ln)
				if not m:
					continue
				end = body_extent(lines, i)
				body = "\n".join(lines[i : end + 1])
				sig = len(COMPLEXITY.findall(body))
				print(f"| {kind} | `{m.group(1)}` | `{path}` | L{i + 1} | {end - i + 1} | {sig} |")
				total += 1
				break
	print()
	if total == 0:
		print("列挙対象なし（private/protected メソッド・ローカル関数が検出されず）。public メソッド・厚いブロックは手動で表に載せて裁く。")
	else:
		print(
			f"計 {total} 単位。testability_inventory はこの全単位を **1 行ずつ** 裁くこと"
			"（表に載っていない単位が 1 つでもあれば網羅性不足＝ゲート未通過）。"
			"public メソッド・厚いブロックは列挙対象外なので手動で表に追加する。"
		)
	return 0


def list_mutations(args):
	"""F7: モジュール本文から決定的な変異点を列挙（AI が1点ずつ適用→テスト赤化を確認するため）。"""
	if not args.module:
		print("--list-mutations には --module が必要です", file=sys.stderr)
		return 2
	try:
		# コメント・文字列内のトークン（`a && b` 等の説明文）を変異点に挙げない
		lines = strip_code_noise(read(args.module), strip_strings=True).splitlines()
	except Exception as e:
		print(f"UNVERIFIED: モジュールを読めない: {e}")
		return 0
	found = 0
	print(f"# 決定的変異点（{args.module}）— 1点ずつ適用し、抽出テストが赤化するか確認する")
	for i, ln in enumerate(lines, 1):
		for a, b in MUTATIONS:
			if a in ln:
				print(f"L{i}: 「{a}」→「{b}」 ｜ {ln.strip()[:80]}")
				found += 1
				break
	if found == 0:
		print("（決定的変異点が見つからず。純粋判定でも分岐/比較が無いなら micro-mutation は非適用=情報のみ）")
	else:
		print(f"\n計 {found} 点。少なくとも1点で新テストが赤化しなければ F7 FAIL（テストが空）。")
	return 0


def main():
	ap = argparse.ArgumentParser(description="抽出後の自己検証ゲート（機械照合部）")
	ap.add_argument("--source", help="抽出元ファイル（F1 完全移動 / F2 直接 import）")
	ap.add_argument("--module", help="抽出先モジュール（W2 副作用 / --list-mutations）")
	ap.add_argument("--symbol", action="append", default=[], help="抽出シンボル名（複数可）")
	ap.add_argument("--test", action="append", default=[], help="抽出単位のテストファイル（複数可）")
	ap.add_argument("--pure", action="store_true", help="この単位を『純粋ロジック』と裁定した（F3/W2 を有効化）")
	ap.add_argument("--eager-threshold", type=int, default=3)
	ap.add_argument("--list-mutations", action="store_true", help="F7 用に決定的変異点を列挙")
	ap.add_argument("--list-units", action="store_true", help="対象ファイルの private/ローカル関数を機械列挙（inventory 網羅性チェック）")
	ap.add_argument("--file", action="append", default=[], help="--list-units の対象ファイル（複数可）")
	args = ap.parse_args()

	if args.list_units:
		sys.exit(list_units_cmd(args))

	if args.list_mutations:
		sys.exit(list_mutations(args))

	rows = check(args)
	if not rows:
		print("入力なし。--source/--module/--test と --symbol を指定してください。", file=sys.stderr)
		sys.exit(2)

	order = {"FAIL": 0, "WARN": 1, "UNVERIFIED": 1, "PASS": 2}
	rows.sort(key=lambda r: order.get(r[0], 3))
	icon = {"FAIL": "❌", "WARN": "⚠️ ", "UNVERIFIED": "❓", "PASS": "✅"}
	print("### extraction_verify（機械照合）")
	print("| 判定 | チェック | 単位 | 詳細 |")
	print("|---|---|---|---|")
	fails = 0
	for sev, chk, unit, detail in rows:
		if sev == "FAIL":
			fails += 1
		print(f"| {icon.get(sev,'')}{sev} | {chk} | `{unit}` | {detail} |")

	print()
	if fails:
		print(f"❌ 構造 FAIL {fails} 件。緑でも『完了』にせず手順に戻す。"
			  " FAIL が事前 testability_inventory の見落としなら self-missed case を cases.jsonl に記録（stage:case 固定・dedupe）。")
		sys.exit(1)
	print("✅ 構造 FAIL なし（WARN/UNVERIFIED は §7a の指針に従って裁定）。tsc/jest（§7b）と micro-mutation（--list-mutations）へ。")
	sys.exit(0)


if __name__ == "__main__":
	main()
