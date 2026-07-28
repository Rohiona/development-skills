# handoff 安定化・JSON 化 改訂設計 v2（批判レビュー指摘の全反映版）

前提要件（確定・変更不可）: 人間可読性不要／AI の調子が悪い日でも安定／ユーザーの restore 操作ゼロ。
6/24 事故分析の原文: 作成元プロジェクトの `.claude/pdca-logs/2026-06-24.md`（本リポジトリには含まれない）

## 1. 系統確定（C1 → 案(A) 採用）

- **JSON 化するのはタスク用 handoff（SKILL 発火・AI 生成）のみ**。
- 保存先を `/tmp/` から **`~/.claude/handoff/<cwd-slug>/task-<topic>-<UTC ts>.json`** に変更（自動復元と同じ置き場・cwd-slug 分離を維持）。
- セッション自動 dump（handoff-dump.sh・機械 md・session_id 名）は**無変更で恒久維持**。役割 = AI が handoff を書かずに終わった時の機械フォールバック。md/JSON の二重サポート期限問題は「役割が別」なので発生しない（m3 への回答）。

## 2. スキーマ（m1 反映）

```json
{
  "schemaVersion": 1,
  "topic": "string",
  "createdAt": "ISO8601（機械が書く）",
  "place": { "branch": "", "worktree": "", "headSha": "", "prUrl": "URL|\"none\"", "prHeadSha": "sha|null" },
  "goal": "md string",
  "scope": { "do": ["..."], "dontDo": ["..."] },
  "invariantsAdr": ["md string", "..."],
  "summary": "md string",
  "primarySources": [ { "url": "", "note": "新旧・同一性の1行区別" } ],
  "doneArtifacts": [ { "kind": "pr|commit|file|doc", "ref": "", "note": "" } ],
  "openQuestions": ["..."],
  "envNotes": ["..."],
  "recommendedSkills": ["任意・検証必須にしない"],
  "supersedes": ["同ディレクトリ内の旧版パス"],
  "staleness": { "parallelEditors": false, "note": "" },
  "needsCompletion": false
}
```

- `scope.do/dontDo` を独立フィールドに昇格（担当範囲。m1 指摘）。
- `primarySources` は `{url, note}` 構造（新旧紛らわしいリソースの同一性区別。m1 指摘）。
- `invariantsAdr` と `envNotes` の境界: 「触ってはいけない核・確定判断」= invariantsAdr、「環境の再現手順・接続情報」= envNotes、と SKILL.md に定義を明記（二重管理回避）。

## 3. 生成フロー（M2 反映: AI は生 JSON を書かない）

1. **collect-facts.sh**（新規）: git rev-parse / gh pr view を実行し place/createdAt の JSON 断片を生成。AI は関与しない。
2. **AI は散文フィールドを個別 md 断片ファイルに書く**（goal.md, summary.md, invariants-1.md, ...）。エスケープを一切扱わない。
3. **assemble-handoff.sh**（新規）: jq `--rawfile`/`--arg` で断片を封入し JSON を組み立てる（dump.sh:90 で実証済みの安全パターン）。supersedes は引数で受ける。
4. **validate-handoff.sh**（新規・fail-closed）:
   - jq: 必須キー存在・型
   - place.headSha が hex 7〜40 桁・`git cat-file -e` で実在
   - primarySources 非空（対象が本当に無い場合のみ `[{"url":"none","note":"<理由>"}]` を許可・暗黙の空は fail）
   - URL 実在チェック: GitHub 系は `gh api` で 200、その他は形式チェックのみ（Notion 等は認証で 200 が取れないため。幻覚 URL の完全排除はしないと明示）
   - supersedes: 実在・自己参照なし・チェーンを辿って循環なし（DAG。M3 反映）
   - **invariants 継承**: supersedes 元の invariantsAdr の各項目が新版に含まれる、または `droppedInvariants` に理由付きで明示されている（書き落とし防止。M1 反映）。照合は**文字列完全一致**。したがって SKILL.md に「継承する不変条件は旧版から verbatim コピー（言い換え禁止）。変更したい場合は droppedInvariants に旧文言を移し、新文言を新項目として追加」を規律として明記する（再レビュー要確認事項の確定 2026-07-04）
5. **再生成ループ上限3回**（M1 反映）。上限到達時は機械フィールドのみの最小 JSON を `needsCompletion: true` で保存し、AI は「handoff は不完全（要補完）」と報告する。「完了」と言わない。
6. 形式検証で拾えない欠陥（中身の空疎・誤り）は**検証では防げないと明示**し、復元時注入文に「中身は AI 生成につき着手前に一次情報で裏取り」を含める（現行 restore.sh:51 の文面を流用）。

## 4. ゼロタッチ復元（C2 反映: 5分窓維持＋窓外はポインタ注入）

handoff-restore.sh を拡張:

- 対象ディレクトリ: **cwd-slug のまま**（worktree 分離を維持。branch 選択に変えない）。
- 候補: task-*.json を優先、無ければ従来 md（現行ロジック無変更）。
- 最新判定: **createdAt**（mtime に依存しない。m2 反映）＋ supersede 末端（窓内の絞り込みにのみ使用。チェーン復活には使わない）。
- **〜14日** → **経過時間によらず常に1行ポインタのみ注入**: 「タスク引き継ぎあり: <topic> / <branch> / <createdAt> / <path>。該当タスクなら Read、無関係なら無視」。（2026-07-04 閣下決定: 当初設計の「5分以内は要約注入」を廃止しポインタ統一。理由: コピペ貼り付けブロックを正の導線に戻したため自動注入は保険で足り、誤注入の害を常に1行に固定できる。C2 の誤注入懸念への最終回答。要約注入モード inject_json_context "full" はコード上は残置・未使用）。
- 14日超: 既存 prune（dump.sh:156）が回収。
- needsCompletion:true の handoff は注入文に「不完全版（機械事実のみ）」と明示。

## 4.5 再レビューで追加した規律（Minor 反映・スキーマ変更なし）

- **着手モード**: goal 散文の先頭に「即着手可 / 要確認（何を確認するか）」を必ず明示する規律を SKILL.md に残す（6/24 の過剰確認 friction 対応。フィールド化はしない）。
- **file:line 規律**: コード位置は file:line で書く規律は SKILL.md 既存記載を維持。機械検証はしない（費用対効果）。設計の限界として「6/24 の6事故型のうち、コード位置精度の1種は規律依存（機械ガードなし）」を本設計書に明記する。

## 5. コピペブロック

特殊ケース（別マシン・別プロジェクトへの持ち出し）用に SKILL.md に残す。内容は JSON パス＋日本語応答固定の2行（現行の言語固定の理由をそのまま維持）。

## 6. 触らないもの

- handoff-dump.sh（無変更）
- memory 系フック・他スキル・プロジェクト本体のコード
- restore.sh の既存 md 経路（挙動不変）

## 実装物一覧

| ファイル | 変更 |
|---|---|
| ~/.claude/skills/handoff/SKILL.md | 生成フロー・スキーマ・保存先・コピペ格下げを改訂 |
| ~/.claude/skills/handoff/scripts/collect-facts.sh | 新規 |
| ~/.claude/skills/handoff/scripts/assemble-handoff.sh | 新規 |
| ~/.claude/skills/handoff/scripts/validate-handoff.sh | 新規 |
| ~/.claude/hooks/handoff-restore.sh | JSON 優先選択・createdAt 窓・ポインタ注入・headSha 照合を追加 |
