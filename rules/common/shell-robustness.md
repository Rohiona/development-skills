# Shell Robustness: profile 上書きで壊さない

Claude Code の Bash ツールは、毎回ユーザーの shell profile（zsh 等）で初期化される。
そのため profile 上の **エイリアス / 関数による上書き**（例: `grep` を関数で再定義）や
PATH の差異が、コマンドの挙動に漏れ込む。検証スクリプトがこれで頻繁に壊れてきた。

## 守ること

- コアコマンド（`grep` `sed` `awk` `ls` `find` 等）が **予期せぬ挙動** をした、
  あるいは `exit 127`（command not found 相当）になったときは、まず profile の
  エイリアス/関数上書きを疑う。
- 上書きを避けるには **`command <tool>`** か **`\<tool>`**、もしくは絶対パスで呼ぶ。
  例: `command grep -n ...` / `\grep -n ...` / `/usr/bin/grep -n ...`
- パイプ段が黙って何も返さない・途中で落ちるときは、各段のバッファリングと
  終了コード（`${PIPESTATUS[@]}`）を確認する。握りつぶさない。

## 適用範囲

これは「シェル環境の脆さ」全般の万能策ではない（PATH 構成や日本語エンコーディングは
個別対応）。あくまで **profile のコマンド上書きを Claude 側でバイパスする** 防御策。
