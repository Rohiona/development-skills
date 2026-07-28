# エントロピー評価と収束判定

## エントロピーレベル

### 高エントロピー（初期状態）

不確実性が高く、要件が固まっていない状態。

**指標**:
- must/should の unknowns が多数存在
- must_have 機能が未定義または曖昧
- 依存関係が未解決
- 品質チェックリストの多くが未達成

**アクション**:
- 積極的に質問を生成
- 既存コード分析を実施
- ブロッカーを優先的に解決

### 中エントロピー（進行中）

一部が固まり、残りの不確実性を解消中の状態。

**指標**:
- must の unknowns が残っている
- must_have 機能の一部が定義済み
- 主要な依存関係が解決
- 品質チェックリストの半分以上が達成

**アクション**:
- 残りのmust unknownsを質問
- 詳細化を進める
- 品質チェックで課題を発見

### 低エントロピー（収束間近）

ほぼ固まり、収束条件を満たす直前の状態。

**指標**:
- must/should の unknowns が空（could のみ可）
- must_have 機能が全て定義済み
- must_have の feasibility が全件検証済み（verified / verified_conditional）
- 依存関係が解決済み
- 品質チェックリストの大部分が達成

**アクション**:
- 最終確認
- 収束判定を実施
- 要件書生成の準備

## 収束判定条件

以下の条件を**すべて**満たした場合に収束:

### 1. Critical Unknowns が空

```
✅ 収束可能:
- unknowns.blocked_by: []
- unknowns.clarifications_needed (must): []
- unknowns.decisions_pending (must): []
- unknowns.investigations_required (must): []

⚠️ should は残っていてもOK
⚠️ could は残っていてもOK
```

### 2. Must-Have 完了

```
✅ 収束可能:
- functional_requirements.must_have に具体的な記述がある
- 各must_haveが実装可能な粒度で定義されている

❌ 収束不可:
- must_have が空
- must_have に曖昧な記述がある
```

### 3. 品質基準達成

```
✅ 収束可能:
- 一貫性: ⚠️以上
- 完全性: ⚠️以上
- 整合性: ⚠️以上
- 明確性: ⚠️以上
```

### 4. エントロピーが低

```
✅ 収束可能:
- entropy_level: "low"

❌ 収束不可:
- entropy_level: "high" または "medium"
```

### 5. 実現可能性検証済み（ツインピークス）

要件は「この方法で実現できる」という裏付けとセットで初めて収束と認める。

```
✅ 収束可能:
- 全 must_have の feasibility.status ∈ { verified, verified_conditional, risk_waived }
- verified / verified_conditional: evidence に label: fact の一次情報
  （公式ドキュメント URL または実コード file:line）が1件以上
- risk_waived: ユーザーの明示受け入れ（日付・要旨）が evidence に記録済み

❌ 収束不可:
- feasibility.status が unverified の must_have がある
  → investigations_required に積み、Researcher で調査する
- feasibility.status が infeasible_rejected の must_have がある
  → wont_have へ移動するか要件を再交渉するまで収束不可
- risk_waived が受け入れ記録なしで付いている（ユーザー判断の裏付けがない waive は無効）
```

**注意**: 条件①の `investigations_required (must): []` は「調査 unknown が一度も
登録されなければ空のまま真」になる。条件⑤は登録漏れに関係なく must_have 全件の
裏付けを直接要求する独立ゲートであり、条件①で代替できない。

## 収束判定フロー

```
[収束判定開始]
    ↓
blocked_by が空か? ─No→ [ブロッカー解決へ]
    ↓ Yes
must unknowns が空か? ─No→ [質問生成へ]
    ↓ Yes
must_have が定義済みか? ─No→ [要件定義へ]
    ↓ Yes
must_have の feasibility が全件 verified か?
    ─No(unverified あり)→ [Researcher 起動へ（phase-workflow.md Phase 3）]
    ─No(infeasible_rejected あり)→ [リカバリへ（wont_have 移動 or 再交渉）]
    ↓ Yes
品質基準を満たすか? ─No→ [品質改善へ]
    ↓ Yes
[収束！要件書生成へ]
```

## 収束報告テンプレート

```markdown
## 収束判定結果

### ステータス: 収束 / 未収束

### チェック結果

| 条件 | 状態 | 詳細 |
|------|------|------|
| Critical Unknowns | ✅/❌ | must: 0, should: N, could: M |
| Must-Have | ✅/❌ | N件定義済み |
| 品質基準 | ✅/❌ | 一貫性✅ 完全性✅ 整合性✅ 明確性✅ |
| エントロピー | 低/中/高 | - |
| 実現可能性 | ✅/❌ | verified: N, conditional: M, waived: W, unverified: 0, rejected: 0 |

### 次のアクション
- (収束の場合) 要件書を生成し、設計フェーズへ移行
- (未収束の場合) 残りの unknowns を解決
```

## unknowns優先度の基準

| criticality | 説明 | 優先度 |
|-------------|------|--------|
| blocked_by | ブロッカー | 最優先（即座に解決） |
| must | 必須 | 高（次のサイクルで質問） |
| should | 重要 | 中（mustの後に質問） |
| could | 任意 | 低（時間があれば質問） |

### 質問生成の順序

1. `blocked_by` があれば最優先で解決
2. `must` の unknowns を優先的に質問
3. `should` の unknowns を質問
4. `could` は収束判定で除外可能
