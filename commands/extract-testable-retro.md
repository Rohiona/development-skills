---
description: 人間が出した責務設計のズレ指摘をオラクルに、extract-testable-module の自己点検が落とした観点を学習観点(lens)へ蒸留する。増分スイープ(栞以降)/狙い撃ち(セッション・PR)の2モード。Missed は3段階昇格・構造変更は承認制
argument-hint: "[--session <id> | --pr <番号> | (引数なし=増分スイープ)]"
---

# /extract-testable-retro — 責務設計の理念学習（蒸留）ループ

## 概要
`extract-testable-module` の自己点検が見落とした「責務過多/テスト不能」を、**人間（閣下）がセッション中に
実コードを指して出した指摘**をオラクルに学習観点(lens)へ蒸留する。bugbot-review-retro / hahifuhe:review-retro の
**責務設計版**。lens は有界な「判断の枠」（事例メモにしない＝lens lint で担保）、生ケースは `cases.jsonl` に蓄積。

## このコマンドを実行したら初めにやること
「extract-testable-retro.md を実行」と出力すること。

## 関連ファイル
- 学習観点(点検側が読む・有界): `~/.claude/skills/extract-testable-module/references/learned-lenses.global.md` ＋ `references/learned-lenses/<area>.md`
- 領域ルーティング: `references/area-map.md`
- 生ケース(蓄積専用・点検側非読込・provenance はここだけ): `~/.claude/skills/extract-testable-module/cases.jsonl`
- ウォーターマーク: `~/.claude/skills/extract-testable-module/.retro-state.json`
- lens lint: `~/.claude/skills/extract-testable-module/scripts/lens-lint.py`

## モード
- **増分スイープ**（引数なし）: `.retro-state.json` の `last_ts` より後の補正発話だけを全 transcript から拾う。普段使い。
- **狙い撃ち**（`--session <id>` / `--pr <番号>`）: 指定セッション or PR だけを対象（review-retro と同じ使い方）。栞は前進させない。

## 手順

### 1. 対象期間/対象を確定
```bash
ETM=~/.claude/skills/extract-testable-module
LAST_TS=$(python3 -c "import json;print(json.load(open('$ETM/.retro-state.json'))['last_ts'])")
echo "watermark(last_ts) = $LAST_TS"
NOW_TS=$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat())")  # ※スクリプト実行時刻でよい
```
- 増分スイープ: `ts > LAST_TS` の人間発話だけを見る。
- 狙い撃ち: 指定 session の transcript（`~/.claude/projects/<プロジェクトのパスをエンコードしたディレクトリ>/<id>.jsonl`）または PR のレビュー/会話だけ。

### 2. 補正発話の抽出（正規表現プレフィルタ → LLM 判定）
transcript から **人間（role=user, isMeta でない, tool_result でない）** の発話を `ts > LAST_TS` で集め、
責務設計のズレ指摘らしき候補を正規表現で粗濾し（`private.*多|単体テスト.*でき|責務.*過多|切り出|別モジュール|別ファイル|詰め込|層.*混|adapter|揮発|据え置|薄い.*ラッパ|モック.*多` 等）、
**各候補を LLM で二値判定**する:
- ✅ 採用 = 「実コードの責務設計（厚いprivate/責務過多/関心の混在/テスト不能/置き場所）への補正・不満・要望」
- ❌ 除外 = 単なる質問・仕様相談・作業ログ・スキル起動指示(`<command-name>` 等)・設計議論一般・コードと無関係
- **人間の指摘がゼロの期間は「学習なし」が正解**。無理に lens を作らない（沈黙を過学習しない）。

### 3. 自己点検との突合（Missed / Matched）
各採用発話について、その時点で extract-testable-module の自己点検が**先回りできていたか**を判定:
- **Missed**: 人間が指摘 ・ 自己点検は挙げていなかった → 蒸留対象（最重要）
- **Matched**: 自己点検も同種を挙げていた（既存 lens でカバー済み含む） → cases 記録のみ
- 既存 lens でカバー済みなら `lens` にその ID、未カバーなら `"new"`。

### 4. ケース蓄積（生ログ・自動）
全 Missed/Matched を `cases.jsonl` に1行1ケースで追記（`date` は `date +%F`）:
```jsonl
{"date":"2026-06-20","session":"abcd1234","area":"api-clients","path":"packages/.../xClient.ts","kind":"missed","stage":"case","lens":"new","title":"...","who":"daemon-kakka"}
```
- `area` は `references/area-map.md` で path から判定（廃止予定モジュール配下は記録のみ・観点化しない）。
- `stage` は3段階昇格の現在地（手順5で決める）。

### 5. 蒸留 → 学習観点を更新（3段階昇格・構造変更は承認制）
各 Missed を **3段階昇格**で扱う（過学習＝気まぐれ指摘の暴発を防ぐ）:
1. **case**: 初観測の新種 → `cases.jsonl` 記録のみ。**lens は作らない**。
2. **provisional**: 同種が**2回以上**観測 or **明確な実害**（テスト不能で実バグを通した等）が1回 → 該当 lens ファイルへ
   `### <ID>. … (provisional)` で**暫定追記**（自動）。
3. **stable**: provisional が再観測され定着 → `(provisional)` を外す。十分安定なら **core 昇格を提案**（承認制）。

置き場所（global / 領域別）は `learned-lenses.global.md` 冒頭の判定基準に従う:
- 置き場所・命名・テスト配置に**依存しない判断境界** → `learned-lenses.global.md`
- プロジェクトの**その領域固有のお作法**（どこへ置く/命名/混ざりやすさ） → `learned-lenses/<area>.md`（プロジェクトごとに育てる学習データ。無ければ area-map に行を足して新設）
- 矛盾は global 優先。

lens は必ず **5枠（観点/対象/兆候/処方/反例）**で書き、**反例を必ず埋める**（浅いモジュール量産の歯止め）。
**provenance（PR/SHA/セッション/日付/具体ファイル名）は lens 本文に書かない**＝`cases.jsonl` のみ。

**構造変更は承認制**: Missed の新規 provisional 追記**以外**（lens 削除・近接マージ・stable 昇格・core 昇格・領域の新設/再編・area-map 改訂）は、**提案して閣下の承認後**に実施する。

#### self-verify ケースの扱い（事後ゲート §7a が積む反省材料）
`cases.jsonl` には人間指摘由来のケースに加え、抽出後の自己検証ゲート（`extract-testable-module` の §7a）が機械確定シグナルで自動記録した **self-missed case**（`who:"self-verify"`, `lens:"self"`, `signal:"..."`）が混ざる。これは「人間が後で見直すべき候補」を機械で前倒しに積んだもの。retro での扱いは:

- self-case は **常に `stage:"case"` 固定で記録されている**。人間指摘と違い、**自動で provisional/stable へ昇格しない**（自己参照汚染＝AI が自分の採点で自分のルールを増やす暴走の防止）。
- retro では self-case を**素材として読み**、同種が人間指摘とも重なる／明確な実害がある等、**閣下が観点化に値すると承認した場合にのみ** lens へ昇格させる（＝上の「構造変更は承認制」に含める）。**AI 単独で self-case を lens 化しない。**
- 効果検証（手順8）では `who` 別に集計し、self-verify が拾った Missed が人間指摘の前に先回りできているか（＝機械ゲートの寄与）も見る。

### 6. lens lint（事例メモ化の歯止め・必須）
蒸留後に必ず実行し、lens が「判断の枠」を保っているか検査する:
```bash
python3 ~/.claude/skills/extract-testable-module/scripts/lens-lint.py
```
違反（具体ファイル名・provenance 直書き）が出たら、その具体を `cases.jsonl` へ移し lens は汎化表現に直す。緑になるまで直す。

### 7. ウォーターマーク前進（増分スイープのみ）
増分スイープで完走したら `last_ts` を**手順1の NOW_TS**へ前進させ、`note` を更新する:
```bash
python3 - <<PY
import json,datetime
p="$ETM/.retro-state.json"; d=json.load(open(p))
d["last_ts"]="$NOW_TS"; d["note"]="増分retro実行: ここまでの補正発話を蒸留済み"
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
print("watermark ->",d["last_ts"])
PY
```
**狙い撃ちモードでは栞を動かさない**（過去の特定対象を見ただけなので）。

### 8. 効果検証レポート（E）
- **Covered/Missed 集計**: 今回の対象期間で「既存 lens がカバーできた指摘(Matched/既存lens) / できなかった指摘(Missed=new)」の件数を出す。
- **再発の縦断**: `cases.jsonl` の `lens` 別に Missed の時系列を見て、**同じ lens の Missed が新たに出ていない=定着**を確認。再発していれば lens の表現（兆候/処方）を見直す（提案＝承認制）。
  ```bash
  # lens 別の kind 分布（再発の俯瞰）
  python3 -c "import json,collections;c=collections.Counter((j['lens'],j['kind']) for j in map(json.loads,open('$ETM/cases.jsonl')));[print(k,v) for k,v in sorted(c.items())]"
  ```

## 閣下への報告（簡潔に）
- 対象期間/対象、採用した補正発話数、Missed/Matched 内訳
- 追記/昇格した lens（global/領域別・stage）と、承認待ちの構造変更があればそれ
- lens lint 結果、Covered/Missed 集計、栞の新 `last_ts`
- 事実（cases/lint の実行結果）と推論（昇格判断）を区別する

## 補足
- 完全自動の lens 生成を狙わない。「人間が出したズレを、以後同種コードで先回りさせる」のが目的。
- 最大リスクは **compliance theater（点検したフリ）＋ lens の事例メモ化**の複合（三者協議で名指し）。歯止めは
  (1) 点検側の `testability_inventory` 構造化出力（SKILL.md / ゲートフック）、(2) cases 側 Covered/Missed 集計、(3) lens lint。retro はこの3点のうち (2)(3) を担う。
