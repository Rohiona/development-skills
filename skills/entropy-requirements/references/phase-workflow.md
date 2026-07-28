# フェーズ詳細ワークフロー

## Phase 1: 初期化フェーズ

### 目的
要件情報JSONとプロセス状態JSONを作成し、初期unknownsを設定する。

### 入力
- ユーザーからの要求（自然言語）

### アクション
1. `design_doc/{機能名}/` ディレクトリを作成
2. `requirements.json` を空テンプレートから作成
3. `requirements.process.json` を作成
4. ユーザー要求から初期情報を抽出
   - basic.what, basic.why を設定
   - 初期unknownsを設定

### 出力
- `requirements.json`（初期状態）
- `requirements.process.json`（初期状態）

### 報告例
```markdown
## Phase 1: 初期化完了

- 作成: `design_doc/{機能名}/requirements.json`
- 作成: `design_doc/{機能名}/requirements.process.json`
- 初期unknowns: N件
- 現在のエントロピー: 高

次のPhase: 既存コード分析
```

---

## Phase 2: 既存コード分析フェーズ

### 目的
関連する既存コードを分析し、制約とパターンを抽出する。

### アクション
1. 関連コードを検索（Grep, Glob使用）
   - キーワード検索
   - ディレクトリ構造の分析
2. 関連ファイルを特定
3. 設計パターンを抽出
4. コードから制約を読み取る
5. `existing_code_analysis` セクションを更新
6. 新たなunknownsを追加

### 分析観点
- API パターン（エンドポイント形式、レスポンス形式）
- データモデル（既存エンティティ、スキーマ）
- インテグレーションポイント（外部連携）
- ビジネスロジック（ドメイン知識）

### 出力
- `requirements.json` の `existing_code_analysis` 更新
- 新たなunknowns追加

### 報告例
```markdown
## Phase 2: 既存コード分析完了

### 関連ファイル
- `src/api/xxx.ts` (high) - API定義
- `src/models/yyy.ts` (medium) - データモデル

### 発見した制約
- 既存のEventBrokerを使用する必要あり
- REST API形式を踏襲

### 新たなunknowns
- EventBrokerの拡張方法は？(must)

次のPhase: 質問生成
```

---

## Phase 3: 質問生成フェーズ

### 目的
優先度の高いunknownsから質問を生成し、ユーザーに提示する。

### アクション
1. unknownsを優先度でソート
   - blocked_by > must > should > could
2. 最優先のunknownを選択
3. 質問を生成
4. 選択肢があれば提示
5. `question_history` に記録

### 質問形式
```markdown
Q{N}（{criticality}）: {質問文}

選択肢（該当する場合）:
- A) ...
- B) ...
- C) ...

または自由回答でお願いします。
```

### 出力
- ユーザーへの質問提示
- `requirements.process.json` の `question_history` 更新

---

## Phase 4: 回答分類フェーズ

### 目的
ユーザーの回答を適切なフィールドに分類し、JSONを更新する。

### アクション
1. 回答を解析
2. 適切なフィールドを特定
   - 機能要件 → `functional_requirements`
   - 制約 → `constraints`
   - 前提 → `assumptions`
   - etc.
3. `requirements.json` を更新
4. `answer_history` に記録
5. 関連するunknownを解決済みにマーク

### 分類マッピング
| 回答内容 | 分類先 |
|----------|--------|
| 機能の説明 | functional_requirements |
| 技術的制約 | constraints.technical |
| ビジネス制約 | constraints.business |
| 前提条件 | assumptions |
| スコープ判断 | scope |
| 成功基準 | success_criteria |

### 出力
- `requirements.json` 更新
- `requirements.process.json` の `answer_history` 更新

---

## Phase 5: 不足検知フェーズ

### 目的
新たなunknownsを検出し、既存コードとの整合性をチェックする。

### アクション
1. 回答から派生する新たな疑問を検出
2. 既存コードとの整合性をチェック
3. 新たなunknownsを追加
4. 既存unknownsの優先度を更新

### 検出パターン
- 「〜の場合はどうする？」→ 新たなunknown
- 「〜と矛盾する」→ 整合性課題
- 「〜が未定義」→ 完全性課題

### 出力
- 新たなunknowns追加
- 課題リスト更新

---

## Phase 6: 品質検証フェーズ

### 目的
4要素のチェックリストを評価し、問題があればフィードバックする。

### アクション
1. 一貫性チェック
2. 完全性チェック
3. 整合性チェック
4. 明確性チェック
5. 品質サマリーを作成

### チェック詳細
`references/quality-criteria.md` を参照

### 出力
- 品質チェック結果
- 改善が必要な項目リスト

### 報告例
```markdown
## Phase 6: 品質検証結果

| 要素 | 状態 | 課題 |
|------|------|------|
| 一貫性 | ✅ | - |
| 完全性 | ⚠️ | 非機能要件が未定義 |
| 整合性 | ✅ | - |
| 明確性 | ⚠️ | 受け入れ基準が曖昧 |

### 改善が必要な項目
- 非機能要件（performance, security）を定義
- 受け入れ基準を測定可能な形式に
```

---

## Phase 7: 収束判定

### 目的
エントロピー評価を行い、収束条件を満たせば完了とする。

### アクション
1. エントロピーレベルを評価（高/中/低）
2. 収束条件をチェック
   - critical unknowns が空
   - must_have が完了
   - 品質基準達成
3. 収束判定を行う
4. 収束の場合：要件書生成へ
5. 未収束の場合：Phase 3へ戻る

### 収束条件詳細
`references/entropy-evaluation.md` を参照

### 出力
- 収束判定結果
- 次のアクション

### 報告例（収束時）
```markdown
## Phase 7: 収束判定

### ステータス: ✅ 収束

| 条件 | 状態 |
|------|------|
| Critical Unknowns | ✅ 0件 |
| Must-Have | ✅ 5件定義済み |
| 品質基準 | ✅ 全項目達成 |
| エントロピー | 低 |

### 次のアクション
要件書（requirements.md）を生成し、設計フェーズへ移行します。
```

---

## 他の役割への移行

### → Researcher（調査）
- 技術調査が必要になった場合
- `investigations_required` に調査項目がある場合

### → Architect（設計）
- 収束条件を満たした後、設計に進む場合
- 条件: エントロピーが「低」、要件書が作成された

### → Implementer（実装）
- 要件が明確で、設計が不要な小規模変更の場合
