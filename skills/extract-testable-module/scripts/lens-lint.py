#!/usr/bin/env python3
"""lens lint — 学習観点(lens)が「判断の枠」から「事例メモ」へ劣化していないか検査する。

理念学習機構の最大の失敗モードは、lens がいつのまにか具体ケースの寄せ集め（特定ファイル名・
特定シンボル・PR/SHA/日付などの provenance 直書き）に劣化し、汎化が効かなくなること。
provenance は cases.jsonl にのみ置く約束なので、lens 本文（### セクション）に次が現れたら違反:

  1. 具体ファイル名（glob/プレースホルダでない実ファイル名。例 instagramGraph.ts）
  2. provenance マーカー（PR番号 #1234 / commit SHA / セッションID風 8hex / 日付 / 「由来:」「出典:」）

対象: references/learned-lenses.global.md と references/learned-lenses/*.md の **### セクション内のみ**
（冒頭の書式説明・領域ヘッダの「対象:」glob は対象外）。

使い方: python3 lens-lint.py            # 全 lens ファイルを検査
        python3 lens-lint.py <file...>  # 指定ファイルだけ
終了コード: 違反ゼロ=0 / 違反あり=1（retro やフックの歯止めに使える）。
"""

import glob
import os
import re
import sys

ROOT = os.path.expanduser("~/.claude/skills/extract-testable-module/references")

# provenance マーカー（lens 本文に書いてはいけない＝cases.jsonl 専用）
PROV_PATTERNS = [
    (re.compile(r"#\d{2,}"), "PR/Issue 番号"),
    (re.compile(r"\b[0-9a-f]{7,40}\b"), "commit SHA 風の16進"),
    (re.compile(r"\b20\d\d[-/]\d{1,2}[-/]\d{1,2}\b"), "日付"),
    (re.compile(r"(由来|出典|provenance)\s*[:：]", re.I), "provenance ラベル"),
    (re.compile(r"\b(PR|commit|SHA)\b", re.I), "PR/commit/SHA 語"),
]

# コードファイル名（実ファイル名＝違反 / glob・プレースホルダ＝OK）
FILE_TOKEN = re.compile(r"[A-Za-z0-9_./\-*{}]+\.(?:ts|tsx|js|jsx|mjs|cjs)\b")
# プレースホルダ/グロブとみなす印（含まれていれば「形」の表現なので許可）
PLACEHOLDER_HINT = re.compile(r"[*{}]|Xxx|XXX|<[^>]+>|\.\.\.")


def is_shape_token(tok: str) -> bool:
    """グロブ/プレースホルダ（形の表現）なら True、具体ファイル名なら False。"""
    return bool(PLACEHOLDER_HINT.search(tok))


def lint_file(path: str):
    violations = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception as e:
        return [(0, "read-error", str(e))]

    in_section = False  # 最初の ### より前（書式説明・領域ヘッダ）は対象外
    for i, raw in enumerate(lines, 1):
        line = raw.rstrip("\n")
        if line.startswith("###"):
            in_section = True
            continue  # 見出し行自体は対象外
        if not in_section:
            continue
        if not line.strip() or line.strip().startswith("<!--"):
            continue

        # 1) 具体ファイル名
        for m in FILE_TOKEN.finditer(line):
            tok = m.group(0)
            if not is_shape_token(tok):
                violations.append((i, "具体ファイル名", tok))

        # 2) provenance マーカー
        for pat, label in PROV_PATTERNS:
            m = pat.search(line)
            if m:
                # SHA 風は短い英単語の誤検出を避けるため16進専用パターンに任せる
                violations.append((i, f"provenance({label})", m.group(0)))

    return violations


def main():
    args = sys.argv[1:]
    if args:
        files = args
    else:
        files = [os.path.join(ROOT, "learned-lenses.global.md")]
        files += sorted(glob.glob(os.path.join(ROOT, "learned-lenses", "*.md")))

    total = 0
    for path in files:
        if not os.path.exists(path):
            continue
        vs = lint_file(path)
        if vs:
            total += len(vs)
            rel = path.replace(os.path.expanduser("~"), "~")
            print(f"\n⚠️  {rel}")
            for line_no, kind, tok in vs:
                print(f"   L{line_no}: {kind} → 「{tok}」 ※lens本文に具体は書かない。cases.jsonl へ。形(*Client.ts / buildXxx)で書く")

    if total == 0:
        print("✅ lens lint: 違反なし（全 lens が判断の枠として書かれている）")
        sys.exit(0)
    print(f"\n❌ lens lint: {total} 件の劣化兆候。具体は cases.jsonl へ移し、lens は汎化表現にする。")
    sys.exit(1)


if __name__ == "__main__":
    main()
