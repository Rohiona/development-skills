# 要件情報 JSON スキーマ

## 要件情報JSON構造

`design_doc/{機能名}/requirements.json`:

```json
{
  "basic": {
    "what": "何を作るか",
    "why": "なぜ必要か（ビジネス価値）",
    "who": {
      "stakeholders": ["ステークホルダー"],
      "users": ["エンドユーザー"],
      "owner": "意思決定者"
    },
    "where": "どこで使われるか",
    "when": {
      "deadline": "期限",
      "milestones": ["マイルストーン"]
    },
    "how": "実現方法の大枠"
  },
  "constraints": {
    "technical": ["技術的制約"],
    "business": ["ビジネス上の制約"],
    "legal": ["法的・規制上の制約"],
    "resource": {
      "budget": "予算",
      "team": "チーム構成",
      "timeline": "タイムライン"
    }
  },
  "assumptions": {
    "confirmed": ["確認済みの前提"],
    "unconfirmed": ["未確認の前提（要検証）"]
  },
  "scope": {
    "in_scope": ["スコープ内"],
    "out_of_scope": ["スコープ外"],
    "deferred": ["後回し"]
  },
  "functional_requirements": {
    "must_have": ["必須機能"],
    "should_have": ["重要だが必須ではない"],
    "could_have": ["あると良い"],
    "wont_have": ["今回は実装しない"]
  },
  "non_functional_requirements": {
    "performance": ["パフォーマンス要件"],
    "security": ["セキュリティ要件"],
    "usability": ["ユーザビリティ要件"],
    "reliability": ["信頼性要件"],
    "scalability": ["スケーラビリティ要件"]
  },
  "risks": {
    "identified": [
      {
        "description": "リスク",
        "impact": "high|medium|low",
        "probability": "high|medium|low",
        "mitigation": "対策"
      }
    ],
    "open_issues": [
      {
        "description": "課題",
        "blocking": true,
        "owner": "担当者"
      }
    ]
  },
  "dependencies": {
    "systems": ["依存する既存システム"],
    "services": ["依存する外部サービス"],
    "data": ["依存するデータソース"],
    "decisions": ["依存する意思決定"]
  },
  "existing_code_analysis": {
    "related_files": [
      {
        "path": "パス",
        "relevance": "high|medium|low",
        "reason": "理由"
      }
    ],
    "design_patterns": ["既存の設計パターン"],
    "constraints_from_code": ["コードから読み取れる制約"],
    "api_patterns": [
      {
        "pattern": "パターン",
        "example": "例",
        "location": "場所"
      }
    ],
    "data_models": [
      {
        "entity": "エンティティ",
        "schema_location": "パス"
      }
    ],
    "integration_points": [
      {
        "type": "api|database|event",
        "description": "説明"
      }
    ],
    "business_logic": [
      {
        "domain": "ドメイン",
        "location": "場所",
        "summary": "概要"
      }
    ]
  },
  "unknowns": {
    "clarifications_needed": [
      {
        "question": "質問",
        "criticality": "must|should|could",
        "weight": 1.0,
        "urgency": 0.5
      }
    ],
    "decisions_pending": [
      {
        "question": "決定が必要な論点",
        "criticality": "must|should|could",
        "weight": 1.0,
        "urgency": 0.5
      }
    ],
    "investigations_required": [
      {
        "question": "調査が必要な項目",
        "criticality": "must|should|could",
        "weight": 1.0,
        "urgency": 0.5
      }
    ],
    "blocked_by": [
      {
        "blocker": "ブロッカーの内容",
        "weight": 2.0,
        "urgency": 1.0
      }
    ]
  },
  "success_criteria": {
    "acceptance_criteria": ["受け入れ基準"],
    "kpis": [
      {
        "metric": "指標",
        "target": "目標値"
      }
    ]
  },
  "meta": {
    "version": "1.0.0",
    "last_updated": "ISO8601形式",
    "status": "discovery|definition|approved",
    "confidence_level": "low|medium|high"
  }
}
```

## プロセス状態JSON構造

`design_doc/{機能名}/requirements.process.json`:

```json
{
  "process_id": "req-discovery-YYYY-MM-DD-NNN",
  "requirement_doc_path": "./requirements.json",
  "created_at": "ISO8601形式",
  "updated_at": "ISO8601形式",
  "current_phase": "code_analysis|question_generation|awaiting_answer|classifying|gap_detection|quality_check|converged|blocked",
  "cycle_count": 0,
  "current_cycle": 0,
  "entropy_level": "high|medium|low",
  "question_history": [
    {
      "cycle": 1,
      "question_id": "q-001",
      "question_text": "質問",
      "status": "answered|pending|skipped"
    }
  ],
  "answer_history": [
    {
      "cycle": 1,
      "question_id": "q-001",
      "answer_text": "回答",
      "classified_into": "分類先フィールド"
    }
  ],
  "convergence_status": {
    "unknowns_empty": false,
    "critical_unknowns_empty": false,
    "must_have_complete": false,
    "is_converged": false,
    "convergence_note": "収束判定の補足"
  }
}
```

## フィールド説明

### basic（基本情報）

| フィールド | 説明 | 必須 |
|-----------|------|------|
| what | 何を作るか | ✅ |
| why | なぜ必要か（ビジネス価値） | ✅ |
| who | 関係者情報 | ✅ |
| where | どこで使われるか | - |
| when | 期限・マイルストーン | - |
| how | 実現方法の大枠 | - |

### unknowns（不明点）

| タイプ | 説明 | 優先度 |
|--------|------|--------|
| blocked_by | ブロッカー | 最優先 |
| clarifications_needed | 確認が必要な項目 | criticality依存 |
| decisions_pending | 決定が必要な論点 | criticality依存 |
| investigations_required | 調査が必要な項目 | criticality依存 |

### criticality（重要度）

| 値 | 説明 |
|----|------|
| must | 必須（収束に必要） |
| should | 重要（できれば解決） |
| could | 任意（時間があれば） |
