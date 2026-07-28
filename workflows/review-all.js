export const meta = {
	name: 'review-all',
	description: '俺様レビューオール（背景 Workflow 版）: 全観点をサブエージェントで回し、所見はファイル永続化、メインには判定サマリーのみ返す。巨大 PR は lens routing と探索予算で総当たりを抑制、統合 PR は mode:integration で統合起因リスク限定レビュー。',
	whenToUse: 'PR / ブランチ / 作業ツリーの差分を、整合性・要件・設計・変更影響・品質・テスト健全性・セキュリティ・BugBot 観点で総合レビューしたいとき。巨大 PR でもメイン文脈を膨張させない。既レビュー済みテーマの統合 PR は args.mode=integration を渡す。',
	phases: [
		{ title: 'DeltaGate', detail: 'delta 明示時のみ: D0/D1/D2/M1 を決定論判定し fail-closed（wave 1）' },
		{ title: 'Partition', detail: '巨大 diff をパッケージ単位スライスに分割し risk tag を付与（閾値超過時のみ）' },
		{ title: 'Spec', detail: '仕様あり時: 整合性 / 要件・設計（1 体に統合）の 2 観点（分割時は要件駆動の選択読み。integration mode では skip）' },
		{ title: 'Code', detail: 'セキュリティ / テスト健全性 を lens routing で fan-out（常時 Claude）。変更影響 / 品質 / BugBot は Codex を primary にし（bugbot は args.bugbotEngine="cursor" 明示で旧 Cursor primary に復帰可・2026-07-09 統合）、失敗時のみ Claude を fallback 起動。integration mode は統合起因リスク限定 lens に差し替え' },
		{ title: 'Codex', detail: 'Codex を変更影響 / 品質の primary 検出器に（whole-diff・best-effort）。Partition/スライス不要のため MODE 確定直後 t=0 で前倒し起動（2026-07-09）。失敗時は Claude impact/quality へ fallback。integration mode でも統合起因リスク限定プロンプトで実行（2026-07-09 v4: Codex 全経路必須・閣下決定）' },
		{ title: 'Verify', detail: 'Critical/Major をソース群バッチ（early/codex/bugbot）ごとに検出完了し次第、スライス単位クラスタで独立検証。三値判定（confirmed/refuted/inconclusive）+ kill premise: 成立に必要な前提を全列挙し、未確認前提・evidence 欠落・lifecycle 系 evidenceChain 欠落・(e)(f) unknown の confirmed は JS 機械ゲートが inconclusive へ強制降格（2026-07-27 三者協議合意）。PR 上の扱い（blocker/降格/refuted/未確認リスク）は diffCausality×prScope から deriveVerifyDisposition() が機械導出。inconclusive は blocker に数えず nextObservation 付きで人間確認へ。既定は Claude 並列。args.verifyEngine="cursor" で Cursor 委譲可。ファイル実読は headSha 明示の git show/grep 必須＝作業ツリー直読み禁止（2026-07-11: 過去レビューの実例 誤 confirmed 対策）。回帰再演: workflows/verify-regression/' },
		{ title: 'Synthesize', detail: 'verify 結果を集計しレポートは cat 連結で組み立て、メインには多値判定のみ返す' },
	],
}

// args はこの harness では JSON 文字列で届く（実測 2026-06-23: typeof args === 'string'）。必ず正規化する。
const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
if (!A.diffPath) {
	throw new Error('review-all: args.diffPath 未設定。Phase 0 の準備が渡っていない。args=' + (typeof args === 'string' ? args.slice(0, 200) : JSON.stringify(args).slice(0, 200)))
}

// 即効版: integration mode は manual opt-in 原則（args.mode === 'integration' 明示時のみ）。
// PR 本文の「個別レビュー済み」記述は参考情報に留め、発動条件にはしない（未レビュー巨大 PR の誤爆回避）。
//
// mode 解決: full（既定）/ integration（統合起因リスク限定）/ delta（round≥2 再レビューの明示例外）。
// - integration と delta は相互排他（両方指定は安全側で full + mode_conflict）。
// - delta は wave 1 ゲート（D0/D1/D2/M1/M4）全 pass のときだけ有効（schemas 定義後に DeltaGate で評価）。
//   1 つでも fail / 判定不能 → fail-closed で full。設計正本: ~/.claude/skills/hahifuhe-review-all/references/delta-scope-design.md
const modeRequested = A.mode === 'integration' || A.mode === 'delta' ? A.mode : 'full'
let MODE = 'full'
let modeNote = ''
let effectiveDiffPath = A.diffPath
let deltaContext = null
if (modeRequested === 'delta' && A.integration) {
	modeNote = 'mode_conflict(integration+delta)→full'
} else if (modeRequested === 'integration') {
	MODE = 'integration'
}
// isFullReview は DeltaGate 評価後に確定（下記）
let isFullReview = true

// ───────────────────────── schemas ─────────────────────────

const COUNTS = {
	type: 'object',
	required: ['critical', 'major', 'minor', 'info'],
	properties: {
		critical: { type: 'integer' },
		major: { type: 'integer' },
		minor: { type: 'integer' },
		info: { type: 'integer' },
	},
}

const UNVERIFIED_RISK = {
	type: 'object',
	required: ['path', 'risk', 'riskLevel'],
	properties: {
		path: { type: 'string' },
		risk: { type: 'string', description: '未確認のリスク内容（短く）' },
		riskLevel: { type: 'string', enum: ['high', 'medium', 'low'] },
		reason: { type: 'string', description: '予算内に確認できなかった理由（短く）' },
	},
}

// 各 reviewer の返却（compact）。フル所見は reportPath、カバレッジ全件は coveragePath のファイルにのみ書く。
const REVIEW_SCHEMA = {
	type: 'object',
	required: ['reviewer', 'verdict', 'counts', 'reportPath', 'coveragePath', 'escalationRequired'],
	properties: {
		reviewer: { type: 'string', description: '観点名（impact/quality(テスト変更スライスでは test-sanity を内包)/security/bugbot/conformance/spec-doc(requirements+design 統合)/integration-*/fallback-general-light）' },
		scope: { type: 'string', description: 'レビューしたスライス（パッケージ名 or all）' },
		verdict: { type: 'string', enum: ['GO', 'NO-GO', 'N/A'] },
		counts: COUNTS,
		findings: {
			type: 'array',
			description: '見出しのみ（本文は書かない）。メインに載せる用の最小情報。',
			items: {
				type: 'object',
				required: ['severity', 'title', 'location'],
				properties: {
					id: { type: 'string', description: '安定 ID（`<reviewer>-<scope>-連番` 形式。Verify 突合用。必ず付け、レポート内の該当節見出しにも同じ ID を書く）' },
					severity: { type: 'string', enum: ['Critical', 'Major', 'Minor', 'Info'] },
					title: { type: 'string' },
					location: { type: 'string', description: 'file:line' },
					note: { type: 'string', description: '一言（任意・短く）' },
				},
			},
		},
		reportPath: { type: 'string', description: 'フル所見を書いた /tmp ファイルの絶対パス' },
		// 即効版 2-4: compact return は件数 + preview のみ。全件は coveragePath の JSON に逃がす。
		coveragePath: { type: 'string', description: 'カバレッジ全件 JSON（readFiles/reviewedFiles/skippedFiles/unverifiedRisks）を書いた絶対パス' },
		reviewedFilesCount: { type: 'integer' },
		readFilesCount: { type: 'integer' },
		skippedFilesCount: { type: 'integer' },
		unverifiedRisksCount: { type: 'integer' },
		escalationRequired: { type: 'boolean', description: '重大リスクの兆候があり追加調査が要る場合のみ true' },
		unverifiedRisksPreview: {
			type: 'array',
			description: '最大 5 件。high > medium > low、同 level なら重要 path 順で選ぶ（単純先頭5件にしない）。全件は coveragePath に。',
			items: UNVERIFIED_RISK,
		},
		budgetUsed: {
			type: 'object',
			description: '探索予算の消費（自己申告）',
			properties: { rounds: { type: 'integer' }, entrypoints: { type: 'integer' } },
		},
		budgetLimit: {
			type: 'object',
			description: '与えられた探索予算上限',
			properties: { rounds: { type: 'integer' }, entrypoints: { type: 'integer' } },
		},
		notes: { type: 'string', description: '実害ゲートで参考に落とした件数など（任意）' },
	},
}

const PARTITION_SCHEMA = {
	type: 'object',
	required: ['slices'],
	properties: {
		slices: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'label', 'slicePath'],
				properties: {
					id: { type: 'string' },
					label: { type: 'string' },
					slicePath: { type: 'string', description: 'このスライスの diff を書いた絶対パス' },
					lines: { type: 'integer' },
					hasTests: { type: 'boolean' },
					// 即効版 2-3: lens routing の入力。diff テキストの軽量 keyword scan のみで決定（Serena/LSP 探索はしない）。
					riskTags: {
						type: 'array',
						description: 'security/prod/public-api/shared-package/schema/migration/async-job/infra/feature-flag/config/generated/docs/test/fixture/rename-only 等',
						items: { type: 'string' },
					},
					suggestedLenses: {
						type: 'array',
						description: '当てるべき code lens（impact/quality/security/bugbot から）。該当なしは空配列（JS が fallback-general-light に回す）',
						items: { type: 'string' },
					},
				},
			},
		},
		note: { type: 'string' },
	},
}

const CODEX_SCHEMA = {
	type: 'object',
	required: ['lens', 'ok'],
	properties: {
		lens: { type: 'string' },
		ok: { type: 'boolean', description: 'codex が実行でき結果を得られたか' },
		counts: COUNTS,
		reportPath: { type: 'string', description: 'codex 出力ファイルのパス（/tmp/codex-*.txt）' },
		additionalFindings: {
			type: 'array',
			description: 'Codex の Critical/Major 全件＋Claude が見落としていそうな追加指摘の見出し（Verify の入力になるため location 必須）',
			items: { type: 'object', required: ['severity', 'title', 'location'], properties: { severity: { type: 'string' }, title: { type: 'string' }, location: { type: 'string', description: 'file:line' } } },
		},
		note: { type: 'string' },
	},
}

// Cursor 実行版 bugbot の返却: REVIEW_SCHEMA + cursorOk。
// cursorOk=false（cursor-agent 不在/異常終了/出力空）のスライスだけ JS が従来の Claude bugbot-review を fallback 起動する。
const CURSOR_REVIEW_SCHEMA = {
	...REVIEW_SCHEMA,
	required: [...REVIEW_SCHEMA.required, 'cursorOk'],
	properties: {
		...REVIEW_SCHEMA.properties,
		cursorOk: { type: 'boolean', description: 'cursor-agent が実行でき一次レビュー出力を得られたか。false なら JS 側が Claude bugbot-review を fallback 起動する（入力 diff 欠落は true のまま verdict N/A）' },
	},
}

// Verify（独立検証）の返却。三値判定 + kill premise（2026-07-27 導入・三者協議合意。過去レビューの実例 の誤 confirmed）。
// 事実判定（verdict）と PR 上の扱い（disposition）を分離し、disposition は JS 側 deriveVerifyDisposition() が機械導出する。
// 条件付き必須（refuted の evidence / lifecycle 系の evidenceChain / inconclusive の attempts 等）は schema で表現できないため JS 側ガードで強制する。
const VERIFY_SCHEMA = {
	type: 'object',
	required: ['results'],
	properties: {
		results: {
			type: 'array',
			items: {
				type: 'object',
				required: ['findingId', 'verdict', 'reason', 'claimFamily', 'premises', 'diffCausality', 'prScope'],
				properties: {
					findingId: { type: 'string' },
					verdict: {
						type: 'string',
						enum: ['confirmed', 'refuted', 'inconclusive'],
						description: '事実判定のみ（PR 上の扱いは JS が導出）。confirmed=実害を一次情報で確認 / refuted=反証を一次情報で確認 / inconclusive=どちらも確定できず',
					},
					claimFamily: {
						type: 'string',
						enum: ['referential-identity', 'cache-staleness', 'other'],
						description: '指摘の型。参照同一性（memo 依存・オブジェクト同一性・イベント再発火）= referential-identity / キャッシュ・invalidate・stale 表示 = cache-staleness / それ以外 = other',
					},
					premises: {
						type: 'array',
						minItems: 1,
						items: {
							type: 'object',
							required: ['premise', 'observation', 'status'],
							properties: {
								premise: { type: 'string', description: 'この指摘が実害として成立するために真である必要がある前提（kill premise）' },
								observation: { type: 'string', description: 'その前提の真偽を確認した観測（git show の file:line / lockfile / 配布物パス / 公式 docs URL）。未観測なら何が阻んだか' },
								status: { type: 'string', enum: ['verified', 'unverified'] },
							},
						},
						description: '成立に必要な前提の全列挙。unverified が 1 つでも残る confirmed は JS が inconclusive へ強制降格する',
					},
					evidenceChain: {
						type: 'object',
						properties: {
							origin: { type: 'string', description: '対象値の生成元（file:line）' },
							updatePath: { type: 'string', description: '更新経路（誰がいつ参照/内容を更新するか。file:line 列挙）' },
							consumption: { type: 'string', description: '消費点（依存として読む場所。file:line）' },
						},
						description: 'claimFamily が referential-identity / cache-staleness のとき必須（JS ガード）。コード内コメントを証拠に使う場合、そのコメントが指す変数と指摘対象の変数の同一性確認も updatePath に記す',
					},
					diffCausality: {
						type: 'string',
						enum: ['diff-introduced', 'worsened', 'composite-new-consequence', 'preexisting', 'unknown'],
						description: '(e)軸: base 実読の結果。diff-introduced/worsened/composite-new-consequence=この diff 由来 / preexisting=既存かつ非悪化 / unknown=確認できず（confirmed では不可）',
					},
					prScope: {
						type: 'string',
						enum: ['in-scope', 'repo-wide', 'unknown'],
						description: '(f)軸: 修正が本 PR 内で完結するか。repo-wide=全体波及・別 issue / unknown=確認できず（confirmed では不可）',
					},
					newSeverity: { type: 'string', enum: ['Major', 'Minor', 'Info'], description: 'refuted / preexisting / repo-wide の再分類先。既定は refuted=Info・それ以外=Minor' },
					evidence: {
						type: 'string',
						description: 'confirmed=実害確認の一次情報（file:line 必須） / refuted=反証の一次情報（file:line 必須。既存防御の場所/到達不能の証明/原実装の該当箇所）。書けない confirmed/refuted は JS が inconclusive へ強制降格する',
					},
					inconclusiveDetail: {
						type: 'object',
						properties: {
							attempts: { type: 'string', description: '実行した観測の列挙（何を読んだか）' },
							blocker: { type: 'string', description: '確定を阻んだもの（読めない資源・時間・権限等）' },
							nextObservation: { type: 'string', description: '確定に必要な追加観測を具体的に（何を読めば/実行すれば白黒つくか）。丸投げ禁止' },
						},
						description: 'inconclusive のとき必須（JS ガード: nextObservation 欠落の inconclusive はレポートで低品質フラグ）',
					},
					reason: { type: 'string', description: '判定理由（短く）' },
				},
			},
		},
		notes: { type: 'string' },
	},
}

// verdict（事実判定）から PR 上の扱い（disposition）を機械導出する。LLM の判定ブレを排除する中心関数。
// 返り値: 'blocker'（actionable・severity 維持）/ 'demoted-existing' / 'demoted-scope' / 'refuted' / 'unverified-risk'
// kill premise ゲート: 未確認前提・evidence 欠落・lifecycle 系の evidenceChain 欠落・(e)(f) unknown の confirmed は inconclusive へ強制降格。
function deriveVerifyDisposition(r) {
	const gate = []
	if (r.verdict === 'confirmed') {
		if ((r.premises || []).some((p) => p.status === 'unverified')) gate.push('未確認前提あり')
		if (!(r.evidence && String(r.evidence).trim())) gate.push('evidence 欠落')
		if (
			(r.claimFamily === 'referential-identity' || r.claimFamily === 'cache-staleness') &&
			!(r.evidenceChain && r.evidenceChain.origin && r.evidenceChain.updatePath && r.evidenceChain.consumption)
		)
			gate.push('lifecycle 系の evidenceChain 欠落')
		if (r.diffCausality === 'unknown') gate.push('diff 由来判定が unknown')
		if (r.prScope === 'unknown') gate.push('PR スコープ判定が unknown')
		if (gate.length) {
			r.verdict = 'inconclusive'
			r.reason = `${r.reason || ''}（機械ゲート: confirmed 要件未充足 — ${gate.join('・')}）`.trim()
			r.inconclusiveDetail = r.inconclusiveDetail || { attempts: '', blocker: gate.join('・'), nextObservation: '欠落要件の観測を実施して再判定' }
		}
	}
	if (r.verdict === 'refuted' && !(r.evidence && String(r.evidence).trim())) {
		// 反証なき refuted は認めない（旧 demoted ルールの継承）
		r.verdict = 'inconclusive'
		r.reason = `${r.reason || ''}（機械ゲート: 反証 evidence 欠落）`.trim()
		r.inconclusiveDetail = r.inconclusiveDetail || { attempts: '', blocker: '反証 evidence 欠落', nextObservation: '反証の一次情報（file:line）を取得して再判定' }
	}
	if (r.verdict === 'confirmed') {
		if (r.diffCausality === 'preexisting') return 'demoted-existing'
		if (r.prScope === 'repo-wide') return 'demoted-scope'
		return 'blocker'
	}
	if (r.verdict === 'refuted') return 'refuted'
	return 'unverified-risk'
}

// Cursor 実行版 Verify の返却: VERIFY_SCHEMA + cursorOk。cursorOk:false のタスクだけ JS 側が
// Claude fallback（verifyPrompt）を起動する（検出段 bugbot の CURSOR_REVIEW_SCHEMA と同型の fail-open floor）。
const CURSOR_VERIFY_SCHEMA = {
	type: 'object',
	required: ['results', 'cursorOk'],
	properties: {
		...VERIFY_SCHEMA.properties,
		cursorOk: { type: 'boolean', description: 'cursor-agent の実行が成功したか（失敗時 false・results は空配列）' },
		guardDemotedToUnverifiable: {
			type: 'integer',
			description: '機械ガード（evidence の file:line 実在チェック）で demoted→unverifiable に昇格させた件数',
		},
	},
}

const DELTA_GATE_SCHEMA = {
	type: 'object',
	required: ['allPass', 'deltaDiffPath', 'filesCount', 'decisionPath', 'failClosedReason'],
	properties: {
		allPass: { type: 'boolean', description: 'D0/D1/D2/M1 全 pass かつ M4 永続化成功' },
		deltaDiffPath: { type: 'string', description: 'allPass 時の delta diff 絶対パス（fail 時は空文字可）' },
		filesCount: { type: 'integer', description: 'delta diff の変更ファイル数' },
		decisionPath: { type: 'string', description: 'deltaDecision.json の絶対パス' },
		failClosedReason: { type: ['string', 'null'], description: 'allPass=false 時の理由。全 pass なら null' },
	},
}

const SYNTH_SCHEMA = {
	type: 'object',
	required: ['overallVerdict', 'finalVerdict', 'reviewCompleteness', 'totals', 'reportPath'],
	properties: {
		// 互換用（既存の判定消費者向け）。finalVerdict から導出する。
		overallVerdict: { type: 'string', enum: ['GO', 'NO-GO'] },
		// 即効版 2-5: 多値判定。「問題なし」と「未確認あり」を分離する。
		finalVerdict: { type: 'string', enum: ['GO', 'GO_WITH_UNVERIFIED_RISKS', 'NO_GO', 'REVIEW_INCOMPLETE'] },
		reviewCompleteness: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
		totals: COUNTS,
		reportPath: { type: 'string', description: '統合レポートの絶対パス' },
		blockers: {
			type: 'array',
			description: 'Critical/Major の見出しのみ（NO_GO に算入したもの）',
			items: {
				type: 'object',
				properties: {
					severity: { type: 'string' },
					title: { type: 'string' },
					location: { type: 'string' },
					lens: { type: 'string' },
				},
			},
		},
		unverifiedRisksTotal: { type: 'integer', description: '全 reviewer の未確認リスク合計' },
		highRiskUnverified: {
			type: 'array',
			description: 'high riskLevel の未確認リスク見出し（GO_WITH_UNVERIFIED_RISKS の根拠）',
			items: { type: 'object', properties: { path: { type: 'string' }, risk: { type: 'string' }, reviewer: { type: 'string' } } },
		},
		escalations: {
			type: 'array',
			description: 'escalationRequired=true の reviewer（high-priority follow-up。追加 reviewer は起動しない）',
			items: { type: 'object', properties: { reviewer: { type: 'string' }, scope: { type: 'string' } } },
		},
		summary: { type: 'string', description: '1〜3 行の総評（任意）' },
		demotedCount: { type: 'integer', description: 'Verify で降格した Critical/Major 件数' },
		demotedFromCritical: { type: 'integer', description: 'Verify で降格したもののうち元 Critical の件数（要人間確認）' },
	},
}

// ───────────────────────── config ─────────────────────────

// partition 発火条件（初期較正値・実 PR で要調整）: 「非生成 diff 行 ≥ PARTITION_LINE_THRESHOLD」OR「非自明 top-level 領域数 ≥ PARTITION_AREA_THRESHOLD」。
// 行数は context・トークン逼迫の指標、領域数はレビュー品質の希釈（broad だが行数は中規模な PR を捕まえる）指標。生成物（*.gen.ts / migration snapshot / lockfile 等）は Phase 0 で除外して数える。
// changedAreaCount は code 領域（apps/<app>・packages/<pkg>・cdk）のみを数える（docs/.github/misc は spec 観点が PR 全体で見るため breadth に含めない）。Phase 0 が算出して渡す。
const PARTITION_LINE_THRESHOLD = 5000
const PARTITION_AREA_THRESHOLD = 4
const VERIFY_CLUSTER_MAX = 5 // 1 verifier が検証する finding 数の上限（超過はスライス内で分割）
const FORCED_PARTIAL_LINE_THRESHOLD = 12000 // 再分割後もなおこの行数を超えるスライスは網羅レビュー不能 → reviewCompleteness=complete を機械的に禁止

// モデル指定（コスト事故防止）: agent() は既定でセッションのモデルを継承するため、高価なモデルの
// セッションから直接起動すると全レビュアーがそのモデルで走る。args.model（例 'opus'）で全 agent に強制できる。
// /hahifuhe:review-all コマンド経由は frontmatter model:opus だが、直接 Workflow 起動時は args.model を渡すこと。
const MODEL = A.model || null
const agentM = (prompt, opts) => agent(prompt, MODEL ? { ...opts, model: MODEL } : opts)
const N_ROUNDS = 10 // 探索予算: 追加探索ラウンド上限（soft budget。8〜12 の中央。実測で再調整）
const M_ENTRYPOINTS = 8 // 探索予算: high-risk entrypoint 上限
const repoRoot = A.repoRoot || ''

// head 固定（2026-07-11 追加）: PR レビューの Phase 0 は head SHA を fetch するだけで checkout しない運用のため、
// ローカル作業ツリーは base ブランチのままでありうる。過去レビューの実例（outDir=/tmp/review-20260710-225927）で Verify が
// git ls-files / grep を作業ツリー（develop checkout）に撃ち、head では削除済みの生成ファイルを「残存」と誤認して Major を誤 confirmed。
const headSha = A.headSha || ''
const headPin = headSha
	? `
■ head 固定（作業ツリー直読み禁止・必須）: レビュー/検証対象の head は ${headSha}。ローカル作業ツリー（${repoRoot} の checkout）が head と一致する保証はない（PR レビューでは head を fetch するだけで checkout しない）。
  - ファイル実読・存在/残存確認・grep は必ず head SHA を明示した git 読みで行う: \`git -C ${repoRoot} show ${headSha}:<path>\` / \`git -C ${repoRoot} grep <pattern> ${headSha} -- '<pathspec>'\` / 存在確認は \`git -C ${repoRoot} ls-tree -r --name-only ${headSha} -- <path>\`。
  - **ローカル作業ツリーへの直接 Read / grep / ls / find / git ls-files を検証根拠にしてはならない**（head で削除済みのファイルが作業ツリーに残っていて「残存している」と誤認する等）。例外は \`git -C ${repoRoot} rev-parse HEAD\` が ${headSha} と一致することを自分で確認した場合のみ。
  - Serena/LSP も作業ツリーを読む。シンボル位置の当たり付けに使うのはよいが、finding / confirmed / demoted の最終根拠は上記 git 読み（または一致確認済みの作業ツリー）で取ること。`
	: `
■ head 固定: args.headSha 未指定のため、作業ツリーがレビュー対象 head と一致する保証がない。「ファイルが存在する / 残っている / 削除されていない」を根拠にする判定は断定せず、未確認としてラベルすること。`

const serenaLsp = `
■ コード探索: Serena + typescript-lsp を併用（Grep/Glob はコードに対し hook でブロックされる）。
  1) ToolSearch("select:mcp__plugin_serena_serena__find_symbol,mcp__plugin_serena_serena__get_symbols_overview,mcp__plugin_serena_serena__search_for_pattern,mcp__plugin_serena_serena__find_file,mcp__plugin_serena_serena__find_referencing_symbols,mcp__plugin_serena_serena__activate_project")
  2) ToolSearch("select:LSP")
  3) Serena は初回のみ activate_project（project="${repoRoot}"）が必要。
  設定/ドキュメント（.json/.md/.yml）には Read/Grep/Glob 可。`

// 探索予算（即効版 2-2）: soft budget。このハーネスはサブエージェントのターン数を hard cap できないため、
// プロンプト上の自己予算 + budgetUsed.rounds 自己申告で運用する。予算で止めても「未確認」を隠させない。
function exploreBudget() {
	return `
■ 探索予算（soft budget・このハーネスはターン hard cap 不可。自己管理すること）:
  - 追加コード探索は最大 ${N_ROUNDS} ラウンド（budgetLimit.rounds=${N_ROUNDS}）。1 ラウンド = 初期 diff 読み込み後に行う追加探索の意思決定単位（複数 tool call を含んでよい）。
  - まず diff と変更ファイル一覧から high-risk entrypoint を最大 ${M_ENTRYPOINTS} 個選ぶ（budgetLimit.entrypoints=${M_ENTRYPOINTS}）。
  - Major 以上を主対象。Minor/Info は既読範囲で明確なものだけ。
  - 予算内に確認できないリスクは finding にせず unverifiedRisks に記録（path/risk/riskLevel[high|medium|low]/reason）。「指摘なし」と「未確認」を必ず分離する。
  - budgetUsed.rounds を自己申告。${N_ROUNDS} 超過時は追加探索を打ち切り、残りは unverifiedRisks へ移す。
  - 重大リスクの兆候時のみ escalationRequired=true（ただし同一 reviewer 内で無制限に掘り続けない。追加調査が要る旨を返すに留める）。`
}

// 返却規律（全 reviewer 共通）: フル所見は reportPath、カバレッジ全件は coveragePath、返却は compact のみ。
function returnDiscipline(reportPath, coveragePath) {
	return `
■ 出力規律（最重要・コンテキスト膨張対策）:
  - フル所見（各 finding の本文・根拠・file:line・修正案・良好な点）は **Write で次のファイルにだけ書く**: ${reportPath}
  - カバレッジ全件（readFiles / reviewedFiles / skippedFiles[{path,reason}] / unverifiedRisks[{path,risk,riskLevel,reason}]）は **Write で次の JSON ファイルにだけ書く**: ${coveragePath}
  - 構造化返却（StructuredOutput）には **件数・GO/NO-GO・finding の見出し(id/severity/title/location)・reportPath・coveragePath・*Count・escalationRequired・unverifiedRisksPreview(最大5件, high>medium>low 優先)・budgetUsed/budgetLimit だけ** を入れる。finding 本文・カバレッジ全件リストは返却に入れない（ファイルにのみ残す）。
  - **各 finding に安定 ID を必ず付与**する（形式 \`<reviewer>-<scope>-連番\`、例 impact-pkg-server-core-01）。レポートファイル内の該当節見出しにも同じ ID を書く（後段 Verify が突合に使う）。
  - reportPath / coveragePath には上記絶対パスをそのまま入れること。`
}

// 対象固定（取り違え防止）: 入力 diff が読めなければ自前で git diff を作り直さない。
function targetLock(slicePath) {
	return `
■ 対象固定（取り違え厳禁）: 一次入力は ${slicePath} の diff のみ。**このファイルが存在しない/空のときは、git diff を自前で再取得しない**（別ブランチを拾って対象 PR を取り違えるため）。その場合は reportPath に「入力 diff 欠落（${slicePath}）」と記し、counts 全 0・verdict 'N/A' で返すこと。`
}

const groundTruth = `
■ Ground Truth: finding を上げる前に対象コード・呼び出し元・既存防御を実際に読む。事実/推論/推測をラベルする。Major 以上は「意図的でないか・本番到達するか・test/prod 区別・この diff 由来か既存か（既存かつ非悪化なら PR ブロッカーにせず別issue候補として記録）」を一次情報で確認してから severity 確定。`

// ───────────────────────── prompts ─────────────────────────

function deltaGatePrompt() {
	const decisionPath = `${A.outDir}/deltaDecision.json`
	const deltaDiffPath = `${A.outDir}/delta.diff`
	const headSha = A.headSha || ''
	const previousFull = A.previousFull || null
	const notImplementedGate = (id) => ({ status: 'not-implemented' })
	const gatesTemplate = {
		D0: { status: 'fail', note: '' },
		D1: { status: 'fail', note: '' },
		D2: { status: 'fail', note: '' },
		D3: notImplementedGate('D3'),
		D4: notImplementedGate('D4'),
		D5: notImplementedGate('D5'),
		D6: notImplementedGate('D6'),
		M1: { status: 'fail', note: '' },
		M2: notImplementedGate('M2'),
		M3: notImplementedGate('M3'),
		M4: { status: 'fail', note: '' },
		C0: notImplementedGate('C0'),
		C1: notImplementedGate('C1'),
		C2: notImplementedGate('C2'),
		C3: notImplementedGate('C3'),
	}
	return `あなたは review-all delta モードの pre-gate 判定担当です。**bash / git / jq / test / wc / grep の決定論コマンドだけ**で D0/D1/D2/M1 を判定し、結果を ${decisionPath} に書き、compact 返却する。**自分の推測で pass にしてはならない**。判定できない・迷う場合は fail（fail-closed）。

入力:
- repoRoot: ${repoRoot}
- outDir: ${A.outDir}
- headSha（現 HEAD）: ${headSha}
- previousFull: ${JSON.stringify(previousFull)}
- deltaDiffPath（書き出し先）: ${deltaDiffPath}
- decisionPath（判定 JSON 書き出し先）: ${decisionPath}

■ D0（前回フル実績）— fail 条件:
- previousFull が null / outDir または headSha 欠落 → fail
- previousFull.outDir 内に comprehensive-review-*.md が 1 件も無い → fail
- git -C ${repoRoot} cat-file -e <previousFull.headSha>^{commit} が非 0 → fail
pass 時: 見つかった comprehensive-review-*.md のパスを previousFullReportPath として記録

■ D1（対象 diff 固定）— fail 条件:
- git -C ${repoRoot} diff <previousFull.headSha>..${headSha} > ${deltaDiffPath} 後、ファイルが空 → fail
- git -C ${repoRoot} diff --name-only <previousFull.headSha>..${headSha} が空 → fail
pass 時: files 配列（変更ファイルパス一覧）を取得

■ D2（認証/セキュリティ カーブアウト）— いずれか該当で fail（= full へ）:
**主判定（パス名簿）**: 変更ファイルのパスが次のいずれかに一致（case-sensitive glob 相当。bash では casefold 付きパターンマッチで可）:
  **/auth/**, **/middleware/**, **/*guard*, **/*auth*, **/*token*, **/*secret*, **/*credential*, **/webhook/**, **/*signature*, cdk/**/iam*, **/*cors*, packages/data-access/**/tenant*
**補助判定（キーワード走査）**: ${deltaDiffPath} の hunk 本文（+/- 行）に auth|authoriz|token|secret|credential|cors|iam|signature|tenantId|webhook が現れる（grep -iE）
灰色・判定不能 → fail

■ M1（機械チェック green）— fail 条件:
- 変更ファイルから対象パッケージを特定:
  - packages/* 配下に 1 ファイルでも触れていれば: cd ${repoRoot} && pnpm build && pnpm check（+ 触れた packages に unit test script があれば filter で実行）
  - apps/* のみ: 触れた apps/<name> ごとに pnpm --filter <そのパッケージ名> build && pnpm --filter <そのパッケージ名> check（+ test:unit があれば。パッケージ名は package.json の name を使う）
  - その他（cdk 等）: リポジトリ慣例に従い最小の build/check
- いずれか exit ≠ 0 → fail
pass 時: 実行したコマンドと exit code を M1.note に記録

■ M4（証跡永続化）— 必須:
上記判定後、必ず ${decisionPath} に次 schema で Write する（未実装ゲートは "not-implemented" を省略/null 禁止）:
\`\`\`json
{
  "version": 1,
  "modeRequested": "delta",
  "modeResolved": "<allPass ? delta : full>",
  "baseSha": "${A.baseSha || ''}",
  "headSha": "${headSha}",
  "previousFullHeadSha": "<previousFull.headSha>",
  "previousFullReportPath": "<D0 で見つけた comprehensive-review-*.md>",
  "deltaDiffPath": "${deltaDiffPath}",
  "files": ["..."],
  "gates": { ... 上記 gatesTemplate 構造。D0-D2/M1 は pass|fail + note。D3-D6/M2-M3/C0-C3 は not-implemented。M4 は pass（書き込み成功時） },
  "failClosedReason": "<fail したゲートと理由。全 pass なら null>"
}
\`\`\`

■ 返却（StructuredOutput）:
- allPass: D0/D1/D2/M1 全 pass かつ M4 成功
- deltaDiffPath: allPass 時 ${deltaDiffPath}、さもなければ ""
- filesCount: files 配列の長さ
- decisionPath: ${decisionPath}
- failClosedReason: allPass なら null、さもなければ fail 理由（ゲート ID 付き）`
}

function partitionPrompt() {
	return `あなたは巨大 PR の diff をパッケージ単位に分割し、各スライスに軽量 risk タグを付ける担当です。レビューはしません。

入力:
- 変更ファイル一覧(JSON 配列): ${A.filesPath}
- マージベース SHA: ${A.baseSha}
- ヘッド ref/SHA: ${A.headSha}
- リポジトリルート: ${repoRoot}
- 出力先ディレクトリ: ${A.outDir}/slices

手順:
1. ${A.filesPath} を Read し、変更ファイルのパス一覧を得る。
2. **粗く少数に**グループ化する（過分割厳禁）。グループキーはパスの先頭セグメントで決める:
   - apps/<app名> → "app-<app名>"（例 apps/frontend → app-frontend）
   - packages/<pkg名> → "pkg-<pkg名>"
   - cdk/** → "cdk"（1 グループに集約）
   - design_doc/** → "design_doc"（1 グループ）、docs/** → "docs"、それ以外ルート直下 → "misc"
   **行数では割らない**（1 グループが大きくても 1 スライスにする）。**スライス総数は最大 20。** 超えそうなら apps/* と packages/* をそれぞれ "apps" "packages" へ更に粗くまとめて 20 以下に収める。
   **唯一の例外（変更集中型 PR）**: 単一グループの非生成 diff が 8000 行以上になる場合のみ、そのグループを第2セグメント（サブディレクトリ）単位で再分割してよい。サブスライスの label は「<親グループ>/<サブディレクトリ>」とし、note に同一親の兄弟スライス一覧を書く（レビュアーが親パッケージ内の結合を追えるように）。再分割後も総数上限 20 は維持。
3. 各グループについて、そのグループのファイルだけの diff を生成して個別ファイルに書く:
   mkdir -p ${A.outDir}/slices
   git -C ${repoRoot} diff ${A.baseSha} ${A.headSha} -- <そのグループのパス列> > ${A.outDir}/slices/<id>.patch
   （git diff / mkdir は許可済み。パスは適切にクォートする）
4. 自動生成物（*.gen.ts, *.pb.ts, generated.d.ts, buf 生成物, migration の meta snapshot 大型 JSON）は除外グループに入れずスキップしてよい（レビュー対象外）。
5. 各スライスについて lines（wc -l 相当）と hasTests（*.test.* / *.spec.* を含むか）を判定する。
6. **各スライスに軽量 risk タグを付ける（lens routing の入力）**。**重要: ここで追加のコード探索・Serena/LSP・呼び出し元追跡はしない。判定は変更パス・ファイル拡張子・diff hunk のテキスト（追加/削除行の keyword scan）の範囲だけで行う**（探索を増やすと本末転倒）:
   - riskTags: 該当するものを配列で付ける。keyword 例:
     - security: auth, permission, role, token, secret, session, cookie, webhook, upload, input, request, params, sql, prisma, drizzle, orm, query, where, fetch, axios, external, apiKey
     - prod: apps/ や packages/ の非テスト実装コード
     - public-api: route/handler/controller/openapi/proto/export 公開面
     - shared-package: packages/ 配下の共有ライブラリ
     - schema / migration: drizzle schema・migration ファイル
     - async-job / infra / feature-flag / config / env: queue/job/cron, cdk/, flag/env/config
     - generated / docs / test / fixture / rename-only: 機械生成・ドキュメント・テストのみ・fixture のみ・改名のみ
   - suggestedLenses: 上記から当てるべき code lens を配列で（impact / quality / security / bugbot から）。判断ルール:
     - security tag があれば security を必ず含める
     - prod / public-api / shared-package / schema / migration / async-job / infra / feature-flag / config のいずれかがあれば impact を含める
     - 明白な実装ロジック変更があれば bugbot を含める
     - generated / docs / fixture / rename-only のみなら quality は不要、当てる lens が無ければ空配列でよい（JS 側が fallback-general-light に回す）

返却: slices[] = {id,label,slicePath,lines,hasTests,riskTags,suggestedLenses}（**最大 20 件**）。slicePath は書き出した .patch の絶対パス。レビュー所見は返さない。`
}

function specPrompt(lens) {
	const coveragePath = `${A.outDir}/spec-${lens.key}.coverage.json`
	// 大規模 PR（partition 発火時）は全体 diff の丸読みを禁止し、要件駆動の選択読みに切り替える
	// （spec agent の per-agent 文脈爆発対策。非分割時は従来どおり全体 diff が一次入力＝既存互換）。
	const inputBlock = partitionRan
		? `入力（大規模 PR のため **全体 diff の丸読みは禁止**）:
- 変更ファイル一覧: ${A.filesPath} を Read（変更範囲の把握）
- スライス patch 一覧（必要なものだけ選択して Read する）:
${slices.map((s) => `  - ${s.id}（${s.label}${s.riskTags?.length ? ` / tags: ${s.riskTags.join(',')}` : ''}）: ${s.slicePath}`).join('\n')}
- 仕様 distilled: ${A.spec?.requirementsPath || '(なし)'} / ${A.spec?.contextPath || '(なし)'}（manifest: ${A.spec?.manifestPath || '(なし)'}）
- verbose 本体は不足時のみ該当セクションをピンポイントで開く

進め方（要件駆動）:
- **AC / 設計決定（DD）を1件ずつ起点に**、それが実装される場所を files.json と Serena で特定し、関係するスライス patch だけを Read して突合する（diff 全体を舐めない）。
- 仕様に無い実装（scope creep）の確認は、riskTags が実装系（prod/public-api/schema 等）のスライスを優先して label 単位で目視し、全量走査はしない。
- 予算内に確認しきれなかった AC / スライスは finding にせず unverifiedRisks に記録する（「確認済み」と「未確認」を混ぜない）。`
		: `入力:
- diff(PR 全体): ${effectiveDiffPath} を Read（これが一次入力）
- 仕様 distilled: ${A.spec?.requirementsPath || '(なし)'} / ${A.spec?.contextPath || '(なし)'}（manifest: ${A.spec?.manifestPath || '(なし)'}）
- verbose 本体は不足時のみ該当セクションをピンポイントで開く`
	return `あなたは${lens.jp}です。PR 全体（spec との突き合わせ）を 1 回でレビューします。

${inputBlock}
${lens.hint}
${serenaLsp}
${headPin}
${exploreBudget()}
${targetLock(partitionRan ? A.filesPath : effectiveDiffPath)}
${groundTruth}
■ ツール制約: 自動修正はしない（読み取り中心）。Write はレポート・カバレッジ保存のみ。
${returnDiscipline(`${A.outDir}/spec-${lens.key}.md`, coveragePath)}

scope は "all" とすること。reviewer は "${lens.key}"。`
}

function codePrompt(lens, slice) {
	const coveragePath = `${A.outDir}/${lens.key}-${slice.id}.coverage.json`
	return `あなたは${lens.jp}です。

対象: 下記スライスの diff（PR の一部）。
- スライス diff: ${slice.slicePath} を Read（これが一次入力。git diff は再取得しない）
- スライス範囲: ${slice.label}
- 仕様 distilled（あれば文脈に使う）: ${A.spec?.contextPath || '(なし)'}
${lens.extra || ''}
${serenaLsp}
${headPin}
${targetLock(slice.slicePath)}
${groundTruth}
${exploreBudget()}
■ 実害ゲート: 各指摘は未対応時の実害（security/performance/UX/正しさ）と到達可能性を一段検証し、actionable と参考を分離する。既存防御があるものは「確認事項」に落とす。
${returnDiscipline(`${A.outDir}/${lens.key}-${slice.id}.md`, coveragePath)}

scope は "${slice.label}"。reviewer は "${lens.key}"。`
}

function codexPrompt(lens) {
	const JP = { impact: '変更影響', quality: 'コード品質', bugbot: '仮想 Bugbot（実バグ先回り）' }
	const focus = lens === 'impact'
		? '破壊的変更（シグネチャ/型/振る舞いの呼び出し元波及）・暗黙依存・パフォーマンス・セキュリティ影響'
		: lens === 'bugbot'
			? '本物 Cursor Bugbot が GitHub 上で指摘しそうな実バグの先回り（ロジック誤り・null/型の穴・競合状態・リソースリーク・DB 整合性・セキュリティ実害・FE↔BE バリデーション乖離）。スタイル・好み・裏取りなき推測の指摘は出さない'
			: 'アーキテクチャ準拠・コード品質（関数サイズ/ネスト/エラーハンドリング/命名）・パフォーマンス・テスト品質'
	// integration mode: Codex も統合起因リスクに限定（v4 で skip を廃止した際の重複指摘抑制）
	const integrationScope = MODE === 'integration'
		? '【スコープ限定】これは統合 PR（テーマは個別レビュー済み）。指摘は統合起因リスク（merge conflict 解消の意味変化 / テーマ間相互作用 / shared package・public API・schema・config の整合 / 統合後にしか通らない経路）に限定し、個別レビュー済みテーマ内部の通常品質・バグ指摘は出さないこと。'
		: ''
	const outFile = `${A.outDir}/codex-${lens}-review.txt`
	// Codex は impact/quality/bugbot の primary 検出器（Claude の同観点は Codex 失敗時のみ fallback）なので、/review-retro が育てた学習観点を Codex にも渡してループを閉じる。
	const lensFile = lens === 'bugbot' ? '~/.claude/agents/bugbot-review.lenses.md' : `~/.claude/agents/hahifuhe-${lens}-reviewer.lenses.md`
	const bugbotProjectRules = lens === 'bugbot'
		? ` また、${repoRoot}/.cursor/BUGBOT.md が存在すればそれも読ませ、プロジェクト固有ルール違反も実バグとして照合させる。`
		: ''
	return `あなたは Codex セカンドオピニオンを取得する担当です（best-effort）。Codex は ${lens} の primary 検出器なので、レビュー指摘から蒸留した学習観点も渡して照合させる。${bugbotProjectRules}

手順:
1. **学習観点を読む**: ${lensFile} を Read する（/review-retro が過去の実指摘から蒸留した「${JP[lens]}」観点集。存在しない/空なら本手順はスキップ）。
2. 次の wrapper を Bash で実行する（生 codex exec は使わない）。失敗/未ログイン/timeout なら ok:false で返す:
   ~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s read-only -C "${repoRoot}" -o ${outFile} "<下記プロンプト>"
   プロンプト内容: 「${JP[lens]}レビュアーとして、${effectiveDiffPath} の diff を読み、${focus} を分析。${integrationScope}finding 前に対象ファイルを実読。実読は必ず git -C ${repoRoot} show ${headSha}:<path>（変更前は git show ${A.baseSha}:<path>）、残存/存在確認は git -C ${repoRoot} grep <pattern> ${headSha} / git ls-tree ${headSha} で行う — 作業ツリーの checkout は head と一致しない場合があるため、作業ツリー直読みを finding の根拠にしない。**加えて、次の『学習観点』にも各 finding を照合し、過去に実レビュアーが指摘した型の見落としを先回りせよ: [手順1で読んだ lens 本文をここに差し込む。空ならこの段落ごと省略]**。出力は『総合評価/サマリー(件数)/指摘(severity・場所・問題・対応)』」
   ※ Codex はローカル FS を読めるので、プロンプト内で「${effectiveDiffPath} を読め」と指示してよい。学習観点本文が長くプロンプト引数に乗せにくければ、手順1の内容を ${A.outDir}/codex-${lens}-lenses.txt に書き、プロンプトで「そのファイルも読め」と指示してよい。
3. ${outFile} を Read し、件数と、**Critical/Major 全件＋Claude が見落としていそうな追加指摘**の見出し（severity/title/location=file:line を必須で）を additionalFindings に抽出する（後段 Verify の入力になるため location 欠落は不可。位置が特定できない指摘は note に回す）。
4. フル出力は ${outFile} に既にあるので、それ以上はファイルに書かない。

返却: {lens:"${lens}", ok, counts(取れれば), reportPath:"${outFile}", additionalFindings[](見出しのみ), note}。`
}

// Cursor 実行版 bugbot（/bugbot-review 単体コマンドと同構成）: 検出は cursor-agent（composer-2.5）、採点は後段 Verify。
// 実測（過去レビューの実例, 2026-07-03 / memory 1947）で「Cursor は速い・Claude トークンをほぼ使わない・精度も遜色なし」だったための構成。
// この wrapper agent は起動と構造化だけを担い、自分ではレビューしない（cursor-agent 失敗時は JS 側が Claude bugbot-review を fallback 起動）。
function cursorBugbotPrompt(slice) {
	const reportPath = `${A.outDir}/bugbot-${slice.id}.md`
	const rawPath = `${A.outDir}/bugbot-${slice.id}.cursor-raw.md`
	const coveragePath = `${A.outDir}/bugbot-${slice.id}.coverage.json`
	return `あなたは Cursor（cursor-agent）に仮想 Bugbot の一次レビューを実行させ、その出力を構造化する担当です。**自分ではレビューしない**（コード探索・指摘の追加・severity の再評価をしない。採点は後段 Verify の仕事）。

手順:
1. 次を Bash で実行する（プロンプト = 動的ヘッダ ＋ 固定プリアンブル ＋ 観点集の連結。観点集は実行時 cat なので /review-retro の更新が自動反映される）:
   PROMPT=$(mktemp -t bugbot-prompt.XXXXXX.md)
   {
     echo "## レビュー対象の差分（ファイルで与える）"
     echo ""
     echo "対象はこのリポジトリの PR 差分のうち 1 スライス分。diff 全文が ${slice.slicePath} にある。まず cat で全文を読み、その差分だけをレビュー範囲とすること。git diff を自前で再取得しない。"
     echo ""
     echo "スライス範囲: ${slice.label}"
     echo ""
     echo "作業ツリーの checkout は head（${headSha}）と一致するとは限らない。差分外コードの実読・存在/残存確認は git show ${headSha}:<path> / git grep <パターン> ${headSha} / git ls-tree ${headSha} で行い、作業ツリー直読みを指摘の最終根拠にしないこと。"
     echo ""
     cat ~/.claude/agents/bugbot-review.cursor-preamble.md
     cat ~/.claude/agents/bugbot-review.lenses.md
   } > "$PROMPT"
   cd ${repoRoot} && cursor-agent -p --force --model composer-2.5 --output-format text "$(cat "$PROMPT")" > ${rawPath} 2>&1; echo "exit=$?"
   （Bash ツールの timeout は 600000ms を明示指定する。既定 120 秒では Cursor のレビューが打ち切られ得る）
2. **失敗時**（cursor-agent が無い / exit≠0 / ${rawPath} が空またはエラーメッセージのみ）: cursorOk:false、verdict:"N/A"、counts 全 0、findings 空、reportPath:"${rawPath}"、coveragePath（${coveragePath}）には {"engine":"cursor","ok":false} だけ Write して返す。**自分で代わりにレビューしない**（Claude fallback は JS 側が起動する）。
3. 成功時: ${rawPath} を Read し、次の変換で ${reportPath} を Write する:
   - 冒頭に「<!-- engine=cursor(composer-2.5) slice=${slice.id} -->」を付ける
   - Cursor の各指摘見出し（### [High|Medium|Low] タイトル）に安定 ID を挿入して「### [bugbot-${slice.id}-01] [High] タイトル」の形式にする（連番 2 桁。本文は改変せず verbatim 維持。後段 Verify がこの ID で突合する）
4. findings（見出しのみ）を構造化する:
   - severity は機械変換のみ: High→Major / Medium→Minor / Low→Info（勝手な昇格・降格をしない。Critical は使わない）
   - location は各指摘の「該当:」行から file:line 形式へ（範囲なら先頭行）。location が取れない指摘は severity を Info に落とし note に「位置不明」と書く（Verify の入力に location 必須のため）
   - Cursor 出力末尾の「参考（対応不要の可能性）」「要目視」節の項目は findings に入れない（notes に件数のみ記す）
5. coveragePath（${coveragePath}）に {"engine":"cursor","ok":true,"reviewedFiles":[diff 内の変更ファイル一覧],"skippedFiles":[],"unverifiedRisks":[「要目視」の各項目を {path,risk,riskLevel:"medium",reason:"Cursor が確証を持てなかった点"} で]} を Write する。
6. 返却（compact）: reviewer:"bugbot"、scope:"${slice.label}"、cursorOk:true、verdict（Major 以上>0 なら "NO-GO"、それ以外 "GO"）、counts、findings（id/severity/title/location）、reportPath:"${reportPath}"、coveragePath、各 *Count、escalationRequired:false、budgetUsed/budgetLimit は {rounds:0,entrypoints:0}。
${targetLock(slice.slicePath)}
  （入力 diff 欠落のときは engine の問題ではないので cursorOk:true のまま verdict "N/A" で返す＝Claude fallback を起動させない）`
}

// Verify の共通コア（検証対象リスト・5軸プロトコル・判定定義）。
// Claude 実行（verifyPrompt）と Cursor 委譲（cursorVerifyPrompt 内の検証指示）の両方が使う — 文言の二重管理によるドリフトを防ぐ。
function verifyCore(t) {
	return `検証対象（${t.findings.length} 件。location は下記スライスに属する）:
${t.findings.map((f) => `- [${f.id}] ${f.severity}: ${f.title}（${f.location}）${f.note ? ` — ${f.note}` : ''} / 根拠の詳細: ${f.reportPath} 内の [${f.id}] 節`).join('\n')}
${headPin}

■ kill premise プロトコル（最初に必ず実施・判定の骨格。2026-07-27 導入: 過去レビューの実例 誤 confirmed の再発防止）:
  各指摘について「実害として成立するために真である必要がある前提」を premises に全列挙し、前提ごとに真偽を区別する観測
  （git show の file:line / lockfile / 配布物 / 公式 docs）を実行して verified / unverified を記録する。
  **unverified の前提が 1 つでも残る限り confirmed にしない**（返しても JS の機械ゲートが inconclusive へ強制降格する）。
  - claimFamily を必ず判定する: 参照同一性（memo/useMemo 依存・オブジェクト同一性・イベント再発火）= referential-identity /
    キャッシュ・invalidate・stale 表示 = cache-staleness / それ以外 = other。
  - referential-identity / cache-staleness では evidenceChain（対象値の生成元 origin → 更新経路 updatePath → 消費点 consumption。
    いずれも file:line）を必須で埋める。ラッパーオブジェクトと中身（.value 等）は**別の値**として区別して追うこと。
  - **コード内コメントを証拠に使うときは、そのコメントが指す変数・値と、指摘対象の変数・値の同一性を必ず確認する**（転用禁止。
    実例: 「参照が変わらない」というコメントは definition.value（中身）を渡すヘッダ固有の話だったのに、ラッパーを依存にする
    useMemo へ転用して誤 confirmed — 2026-07-26 過去レビューの実例）。
  - 外部ライブラリの挙動が前提になるときは、head の lockfile（pnpm-lock.yaml）でバージョンを特定し、node_modules の配布物
    または公式 docs を実読して観測する。読めなければその前提は unverified のまま（一般知識・推測で verified にしない）。
  - 【安価な追観測 1 回ルール】inconclusive を返す前に、確定に必要な観測が今すぐ実行可能（git show / git grep / lockfile /
    配布物 Read）なら**その場で 1 回実行して**白黒を付ける。それでも確定しないときだけ inconclusive とし、
    inconclusiveDetail に attempts（実行した観測）/ blocker（阻んだもの）/ nextObservation（何を読めば確定するか・具体的に）を書く。

■ 検証プロトコル（観測の指針・この軸に限定。趣味の severity 再評価・スタイル論評はしない）:
  (a) 到達性: その経路は本番で現実に発火するか（mock 前提・到達不能シナリオ・dev 専用でないか）。
  (b) 既存防御: 呼び出し元・バリデーション・型・既存テストで既にカバーされていないか（対象コードと呼び出し元を実際に読む）。
  (c) test/prod: 欠陥は production コードか、テスト fixture か。
  (d) 契約の実在性: 「あるべき挙動 / 不変条件 / 必須ガード」を前提にした指摘なら、その契約が実在するか出典（移植元の原実装・設計書・要件）で確認する。レビュアーが発明した要件なら refuted 候補。
  (e) diffCausality（diff 由来か既存か）: base（変更前）を \`git show ${A.baseSha}:<path>\` 等で実際に読み、その欠陥が **base に既にあったか**を確認して次のいずれかを返す — ① diff-introduced / worsened: この diff が導入・悪化・顕在化させた（守っていたガードを外した / 意味を変えて潜在バグが発火する等）。② preexisting: 既存かつこの diff で悪化していない（同じ欠陥が base にもあり、この変更は無関係）。evidence に「base の該当 file:line で既存」を記す。③ composite-new-consequence【②より優先】: 欠陥の機構自体は base 既存でも、この diff が新設した防御・状態・資源（status ゲート/フィルタ/不変条件/スケジュール等）と組み合わさって **base では起き得なかった新しい帰結**が生じる。判定は機構でなく**帰結**で行う: 「この欠陥の帰結は base でも起きたか？」に No なら PR 由来（実例: 既存の ERROR→SUSPENDED 遷移が、本 diff 新設の webhook ゲート対象集合 {ARCHIVED, ERROR} から離脱してゲートを外し計測が再開する — 2026-07-15 過去レビューの実例 誤降格の再発防止）。確認できなければ unknown（confirmed は不可になる）。
  (f) prScope（修正が本 PR 内で完結するか）: 機構が実在しても、根本原因が**リポジトリ全体に波及する構造**（deploy パイプラインの順序・共有基盤・schema 変更を含む全 PR に共通する前提 等）にあり、ついで修正すると PR のスコープが膨れるものは repo-wide を返す（evidence に共有構造側の file:line。例: deploy workflow の needs グラフ。この PR 固有の運用手当てで足りる場合はその確認事項も reason に添える）。本 PR 内で完結するなら in-scope。確認できなければ unknown（confirmed では不可になる）。

■ 判定（1件ずつ・**事実判定のみ**。ブロッカー/降格/別 issue の扱いは JS が diffCausality と prScope から機械導出するので、ここでは決めない）:
  - confirmed: 実害を一次情報で確認でき、premises が全て verified・evidence（file:line）あり・diffCausality / prScope とも unknown でない。
  - refuted: 反証を一次情報で確認できた。evidence に反証の file:line 必須（既存防御の場所 / 到達不能の証明 / 原実装の該当箇所）。**反証を書けないなら refuted にしてはならない**（inconclusive にする）。
  - inconclusive: どちらも確定できない。安易な逃げ場ではない — 追観測 1 回ルールを先に適用し、inconclusiveDetail（attempts / blocker / nextObservation）を必ず埋める。`
}

function verifyPrompt(t) {
	return `あなたは独立検証担当（skeptic）です。レビュアーが出した Critical/Major 指摘が「本当に実害か」を一次情報で検証します。レビューのやり直し・指摘の追加はしません。

入力:
- スライス diff: ${t.slice.slicePath} を Read（一次入力）
- 各指摘の根拠: 検証対象リスト記載の reportPath の該当節だけをピンポイントで読む（レポート全文を読まない）
- 仕様 distilled（あれば）: ${A.spec?.contextPath || '(なし)'}
${serenaLsp}
${targetLock(t.slice.slicePath)}

${verifyCore(t)}

返却は results 配列（findingId ごと）のみ。レポートファイルは書かない。`
}

// Cursor 実行版 Verify（ADR: 三者協議 2026-07-03「C 強化版」採用。同期検閲は Cursor が全件担当・
// 失敗タスクのみ Claude verifyPrompt へ fallback＝検出段 bugbot と同型の fail-open floor）。
// wrapper は起動・構造化・機械ガード・成果物永続化のみを行い、自分では検証・severity 再評価をしない。
// 機械ガード: demoted の evidence が引用する file:line の実在を機械確認し、不実在なら unverifiable へ昇格
//（Cursor の「根拠の事実誤認」への安価な防御。判定内容の是非は評価しない）。
// 成果物 verify-*.json は後日の影監査（verify-shadow-audit.js・本線非依存）が読む。監査を廃止しても無害なログ。
function cursorVerifyPrompt(t) {
	// batch を含める: Verify パイプライン化（2026-07-09）で同一スライスが複数バッチに現れ得るため、成果物 verify-*.json の衝突を防ぐ
	const suffix = `${t.batch ? `${t.batch}-` : ''}${t.slice.id}${t.part ? `-${t.part}` : ''}`
	const promptPath = `${A.outDir}/verify-${suffix}.cursor-prompt.txt`
	const rawPath = `${A.outDir}/verify-${suffix}.cursor-raw.md`
	const artifactPath = `${A.outDir}/verify-${suffix}.json`
	return `あなたは Cursor（cursor-agent）に Verify（独立検証）を実行させ、その出力を構造化する担当です。**自分では検証しない**（コード探索・判定の変更・severity 再評価をしない。仕事は起動・構造化・機械ガード・永続化のみ）。

手順:
1. 次の検証指示テキストを ${promptPath} に Write する（--- の内側をそのまま。先頭末尾の --- 行は含めない）:
---
あなたは独立検証担当（skeptic）です。レビュアーが出した Critical/Major 指摘が「本当に実害か」を一次情報で検証します。レビューのやり直し・指摘の追加はしません。
対象リポジトリ: ${repoRoot}（**作業ツリーの checkout が検証対象の head とは限らない** — 作業ツリー直読みを検証根拠にしない）
head SHA: ${headSha || '(未指定 — 作業ツリー一致の保証なし。存在/残存を根拠にする判定は断定しない)'}（変更後コードは git show ${headSha}:<path> / git grep <pattern> ${headSha} で読む）
base SHA: ${A.baseSha}（変更前コードは git show ${A.baseSha}:<path> で読む）
一次入力 diff: ${t.slice.slicePath}
各指摘の根拠: 検証対象リスト記載の reportPath の該当節だけをピンポイントで読む

${verifyCore(t)}

出力: 検証が終わったら、最後に \`\`\`json フェンスで JSON 配列を1個だけ出力する（全件分）:
[{"findingId":"...","verdict":"confirmed|refuted|inconclusive","claimFamily":"referential-identity|cache-staleness|other","premises":[{"premise":"...","observation":"file:line 等","status":"verified|unverified"}],"evidenceChain":{"origin":"file:line","updatePath":"file:line","consumption":"file:line"},"diffCausality":"diff-introduced|worsened|composite-new-consequence|preexisting|unknown","prScope":"in-scope|repo-wide|unknown","newSeverity":"Major|Minor|Info","evidence":"一次情報 file:line","inconclusiveDetail":{"attempts":"...","blocker":"...","nextObservation":"..."},"reason":"1〜3文"}]
レポートファイルは書かない。
---
2. Bash で cursor-agent を1回実行する（timeout 600000 を明示）:
   cursor agent -p --trust --force --workspace=${repoRoot} --model composer-2.5 --output-format text "$(cat ${promptPath})" > ${rawPath} 2>&1
3. **成功時**: ${rawPath} の json フェンスから results 配列を抽出する（各件の verdict/evidence/reason は改変しない）。
4. **機械ガード（confirmed / refuted の evidence・必須）**: 各 confirmed / refuted の evidence（と evidenceChain）から file:line / ファイルパス参照を抽出し、実在を機械確認する —
   head 側: git -C ${repoRoot} cat-file -e ${headSha}:<path> の成否と、git -C ${repoRoot} show ${headSha}:<path> | wc -l で行番号が範囲内か（作業ツリーへの test -f / wc は使わない — checkout が head とは限らない）。base 側: git -C ${repoRoot} cat-file -e ${A.baseSha}:<path> の成否。
   **1つも実在を確認できない confirmed / refuted は verdict を inconclusive に変更**し、reason 末尾に「(機械ガード: evidence の file:line 不実在)」を追記する。変更件数を guardDemotedToUnverifiable に入れる（0 なら 0。フィールド名は互換のため据え置き）。実在が確認できれば判定はそのまま（内容の是非は評価しない）。
5. **成果物の永続化**: ${artifactPath} に次の JSON を Write する（後日の影監査が読む。監査を廃止しても無害なログ）:
   {"engine":"cursor","ts":"${A.ts}","slice":"${suffix}","repoRoot":"${repoRoot}","baseSha":"${A.baseSha}","slicePath":"${t.slice.slicePath}","findings":<検証対象の入力（id/severity/title/location/note/reportPath）をそのまま配列で>,"results":<機械ガード適用後の最終 results>}
6. **失敗時**（cursor-agent が無い / exit≠0 / ${rawPath} から JSON を抽出できない）: cursorOk:false、results は空配列、guardDemotedToUnverifiable:0 で返し、${artifactPath} には {"engine":"cursor","ok":false} だけ Write する。**自分で代わりに検証しない**（Claude fallback は JS 側が起動する）。

返却: results（機械ガード適用後）/ cursorOk / guardDemotedToUnverifiable。`
}

function synthPrompt(payload) {
	const reportPath = `${A.outDir}/comprehensive-review-${A.ts}.md`
	const integrationNote = MODE === 'integration'
		? '■ これは integration mode（統合起因リスク限定レビュー）の結果である。**レポート冒頭に「通常 full review ではなく統合起因リスク限定レビュー」と必ず明記**する。Spec/Codex/通常の総当たりは意図的に行っていない。\n'
		: ''
	const deltaNote = MODE === 'delta' && payload.delta
		? `■ これは delta mode（前回フル ${payload.delta.previousFullHeadSha} 以降の差分限定再レビュー）の結果である。**レポート冒頭に「本レポートは delta（${payload.delta.previousFullHeadSha} 以降の差分限定）。前回フル: ${payload.delta.previousFullReportPath || '(deltaDecision.json 参照)'}」と必ず明記**する。delta を full review と称しない。deltaDecision: ${payload.delta.decisionPath}\n`
		: ''
	const triageNote = A.triage?.declaration
		? `■ 入口トリアージ（Phase 0.5）が実行された run である。**レポート冒頭に「実行プロファイル: ${PROFILE}」の節を置き、次の宣言を転記**する: ${A.triage.declaration}\n`
		: ''
	return `あなたは統合レポート作成担当です。各 reviewer が書いた所見ファイルとカバレッジファイルを読み、1 つの統合レポートにまとめます。
${integrationNote}${deltaNote}${triageNote}
入力（各 reviewer の compact 結果。本文は reportPath、カバレッジ全件は coveragePath のファイルにある）:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

手順:
1. **レポート本文（reportPath）は Read しない**（手順6で cat 連結して組み立てる。判定材料は payload の compact findings / counts / verify 結果で足りる）。blockers の文言確認等でどうしても必要な場合のみ、該当 1 ファイルの該当節をピンポイントで開く。
2. unverifiedRisks（未確認リスク）全件は coveragePath 群から **Bash の jq で抽出**する（compact の unverifiedRisksPreview は上位5件のみ。ファイルを Read で開かない）。
3. 観点別に集計し、F(BugBot)と G(セキュリティ)で重複する security 指摘は 1 件に寄せて二重計上しない。
3.5. **Verify 結果を集計して severity を確定する（payload.verify がある場合）**: 一次コードの裏取りは前段 Verify（独立検証）が実施済み。各 Critical/Major を verify.results の verdict で確定する —
   - **payload.verify.dispositions[findingId]**（JS 機械導出・改変禁止）で各 C/M を確定する:
   - **blocker** → actionable として算入（severity 維持）。
   - **demoted-existing / demoted-scope** → newSeverity（既定 Minor）へ再分類して NO_GO 根拠から外し、レポートの**「降格済み指摘」独立セクション**に元 severity / 根拠（evidence の file:line）/ 理由（既存事項・別 issue 候補 / 全体波及・別 issue 起票推奨）を記録する（**削除しない**）。demotedCount へ計上し、元 Critical の降格は demotedFromCritical で返す。
   - **refuted** → 誤検知として newSeverity（既定 Info）で「降格済み指摘」節に反証 evidence とともに記録する（NO_GO 根拠に入れない・削除しない）。demotedCount へ合算しつつ、レポートでは refuted（事実として誤り）である旨を demoted（実在するが非ブロッカー）と区別して明記する。
   - **unverified-risk（inconclusive）** → **blocker に数えない**。ただし黙殺せず、元 severity・inconclusiveDetail（attempts / blocker / nextObservation）を「未確認リスク集約」へ riskLevel=high（元 Critical）/ medium（元 Major）として記載し人間確認へ回す（finalVerdict の GO_WITH_UNVERIFIED_RISKS 判定の入力になる）。nextObservation が空の項目は「低品質 inconclusive」と注記する。
   - verify.results に無い C/M（クラスタ漏れ）→ severity 維持で算入し「未検証（verify 対象外）」と注記する。
   **payload.verify が null の場合（C/M=0 で skip、または縮退経路）のみ**、従来どおり Codex 由来の Critical/Major を一次コード（Serena/LSP。ただし作業ツリーの checkout は head と一致しない場合があるため、ファイルの存在/残存・内容の最終確認は git show ${headSha}:<path> / git grep <pattern> ${headSha} で行い、作業ツリー直読みを根拠にしない）で (a)到達性 (b)既存防御 (c)test/prod (d)契約実在性 (e)diff由来か既存か（base を読み、既存かつ非悪化なら降格して「既存事項・別issue候補」と記録に残す。ただし機構が既存でも本 diff 新設の防御/状態との合成で base に無い帰結が生じるなら既存扱いせず維持＝帰結で判定）の5軸で裏取りしてから算入し、裏取りできないものは fail-closed で維持しつつ「要出典確認」を明記する。
4. **多値の総合判定**を出す（「問題なし」と「未確認あり」を分離する）:
   - NO_GO: actionable な Critical>0 または Major>0。
   - GO_WITH_UNVERIFIED_RISKS: Critical=0 かつ Major=0 だが、riskLevel=high の unverifiedRisks が残る。
   - REVIEW_INCOMPLETE: budgetUsed.rounds > budgetLimit.rounds の reviewer が重要領域を覆っている、または tool failure 等で重要領域がほぼ未確認。
   - GO: Critical=0 かつ Major=0 かつ high の unverifiedRisks なし。
   ※ F/G の actionable な Critical/Major のみ算入、参考は算入しない。test-sanity の Minor は判定を変えない。
   reviewCompleteness: complete（全 reviewer 予算内で重要領域確認済み）/ partial（一部 reviewer が予算超過 or 未確認残）/ blocked（重要領域が確認できていない）。
   **payload.forcedPartial が非空の場合、complete を返してはならない**（当該スライスは規模超過で網羅レビュー不能＝機械条件。partial 以下とし、対象スライス ID をレポートに明記する）。
   overallVerdict（互換用）: finalVerdict が GO か GO_WITH_UNVERIFIED_RISKS なら 'GO'、NO_GO か REVIEW_INCOMPLETE なら 'NO-GO'。
5. escalationRequired=true の reviewer は「要追加調査（high-priority follow-up）」として集約するに留める。**このレポートで追加 reviewer は起動しない**（即効版方針）。
6. 統合レポートを次の絶対パスに**「組み立て」**で作る（レポート本文を自分の文脈に載せない）: ${reportPath}
   - (i) **自筆パート（Write）**: エグゼクティブサマリー（多値総合判定 + reviewCompleteness + 統計表 + 降格済み指摘セクション + 未確認リスク集約 + 要追加調査 + 次のアクション）を ${reportPath} に Write する。
   - (ii) **観点別フル所見（cat 連結）**: 各 reviewer の reportPath ファイルを Bash で ${reportPath} へ順次追記する（例: \`{ echo; echo '---'; echo '## <観点名> (<scope>)'; cat '<reportPath>'; } >> ${reportPath}\`。観点ごとに見出し区切りを挟み、存在しないパスは「未生成」と 1 行追記。Codex の reportPath も同様に連結）。**Read で開いて書き写さない**。

返却: {overallVerdict, finalVerdict, reviewCompleteness, totals, reportPath:"${reportPath}", blockers[], unverifiedRisksTotal, highRiskUnverified[], escalations[], summary, demotedCount, demotedFromCritical}。
■ 返却に finding 本文を入れない（レポートファイルにのみ書く）。メインに載るのはこの compact のみ。`
}

// ── DeltaGate（wave 1: D0/D1/D2/M1/M4。mode=delta 明示時のみ） ──
if (modeRequested === 'delta' && !A.integration) {
	phase('DeltaGate')
	const gate = await agentM(deltaGatePrompt(), { agentType: 'general-purpose', schema: DELTA_GATE_SCHEMA, phase: 'DeltaGate', label: 'delta-gate', effort: 'medium' })
	if (gate?.allPass && gate.deltaDiffPath) {
		MODE = 'delta'
		effectiveDiffPath = gate.deltaDiffPath
		modeNote = 'delta-gates-all-pass'
		deltaContext = {
			decisionPath: gate.decisionPath,
			previousFullHeadSha: A.previousFull?.headSha || '',
			previousFullReportPath: A.previousFull?.reportPath || '',
			filesCount: gate.filesCount,
		}
		log(`DeltaGate pass: delta diff=${effectiveDiffPath} (${gate.filesCount} files) / decision=${gate.decisionPath}`)
	} else {
		modeNote = `delta-fail-closed: ${gate?.failClosedReason || 'gate-evaluation-failed-or-incomplete'}`
		log(`DeltaGate fail-closed → full: ${modeNote}`)
	}
}
isFullReview = MODE === 'full'

// ── profile（入口トリアージ 2026-07-09 v4。正本: review-all-workflow.md Phase 0.5） ──
// Phase 0.5 が「危険領域なし・既存の独立レビューあり・小規模」を機械確認できたときだけ light を渡してくる。
// fail-closed: light は MODE=full のときのみ受理。かつ light でも観点は落とさない（Spec は spec.found に従い、
// security/bugbot/Codex/Verify は常時）。light の実体は「トリアージ宣言のレポート記録」であり、
// 将来の縮退ポイントを 1 箇所に集約するための knob（黙って軽くしない原則）。
const PROFILE = A.profile === 'light' && MODE === 'full' ? 'light' : 'full'
if (A.profile === 'light' && PROFILE !== 'light') log(`profile: light 要求は mode=${MODE} のため無効（fail-closed で full 扱い）`)

// ── bugbot エンジン（2026-07-09 閣下決定: 観点を Codex に統合・可逆） ──
// 既定 'codex': bugbot lens も Codex が回す（retro が育てた bugbot-review.lenses.md + .cursor/BUGBOT.md を照合。
// 学習ループは従来どおり /review-retro → lenses 蒸留 → 次回レビューで Codex が読む、で閉じる）。
// 'cursor' 明示で旧 Cursor（cursor-agent, composer-2.5）primary へ即復帰できる（切替ノブ＝可逆性の担保。
// 旧構成の実測根拠: 過去レビューの実例 / memory 1947。Codex 統合版の検出カバー率は /review-retro の突合で継続計測する）。
const BUGBOT_ENGINE = A.bugbotEngine === 'cursor' ? 'cursor' : 'codex'

// ───────────────────────── pipeline ─────────────────────────

log(`review-all[${MODE}/${PROFILE}]: target=${A.target?.kind || '?'} ref=${A.target?.ref || '-'} / diff≈${A.totalDiffLines ?? '?'}行 / spec=${A.spec?.found ? 'あり' : 'なし'} / tests=${A.hasTests ? 'あり' : 'なし'}${modeNote ? ` / mode:${modeNote}` : ''}${A.triage?.declaration ? ` / triage:${A.triage.declaration}` : ''}`)

// ── Codex 前倒し起動（2026-07-09 高速化: 旧配置は Cursor bugbot 完了後の直列起動） ──
// Codex は whole-diff（effectiveDiffPath）を丸ごと読む方式で Partition/スライスに依存しないため、
// MODE と effectiveDiffPath が確定したこの時点（t=0）で起動できる。
// 実測（run 20260708-154552）: 旧配置は「Partition(1.5分)→Cursor(9分)→Codex(6.5分)」の数珠つなぎとなり
// 検出クリティカルパスの主因だった。A.partitionOnly（partition 検証テストフック）では起動しない。
// integration mode でも Codex は落とさない（2026-07-09 v4: どんなに軽いレビューにも Codex を必ず入れる・閣下決定）。
// integration 時は codexPrompt 内で統合起因リスク限定の注記が付く（個別レビュー済みテーマ内部の重複指摘は抑制）。
// bugbot lens は BUGBOT_ENGINE='codex'（既定）のとき Codex whole-diff で回す（integration では従来どおり bugbot なし）。
const codexLensKeys = A.partitionOnly ? [] : ['impact', 'quality', ...(BUGBOT_ENGINE === 'codex' && MODE !== 'integration' ? ['bugbot'] : [])]
const codexThunks = codexLensKeys.map((k) => () =>
	agentM(codexPrompt(k), { agentType: 'general-purpose', schema: CODEX_SCHEMA, phase: 'Codex', label: `codex:${k}`, effort: 'low' })
)
if (MODE === 'integration') log('integration mode: Codex は統合起因リスク限定プロンプトで実行（v4: Codex 全経路必須）')
if (BUGBOT_ENGINE === 'cursor') log('bugbotEngine=cursor 明示: bugbot は旧 Cursor primary 経路で実行')
const codexPromise = parallel(codexThunks)

// ── Phase: Partition ──
// routing/即効版は partitionRan を発火条件にする（巨大 PR が 1 パッケージに集中し slices.length===1 でも routing を効かせるため）。
// Phase 0 が nonGeneratedDiffLines / changedAreaCount を渡せば「行 OR 領域」で判定。渡されない（旧 Phase 0）場合は totalDiffLines を行閾値で代替（後方互換・領域トリガーは無効）。
const partitionLines = A.nonGeneratedDiffLines ?? A.totalDiffLines ?? 0
const partitionAreas = A.changedAreaCount ?? 0
const partitionByLines = partitionLines >= PARTITION_LINE_THRESHOLD
const partitionByAreas = partitionAreas >= PARTITION_AREA_THRESHOLD
const partitionRan = partitionByLines || partitionByAreas
if (partitionRan) log(`partition 発火: 非生成行=${partitionLines}(≥${PARTITION_LINE_THRESHOLD}:${partitionByLines}) / 領域数=${partitionAreas}(≥${PARTITION_AREA_THRESHOLD}:${partitionByAreas})`)
let slices
if (partitionRan) {
	phase('Partition')
	const part = await agentM(partitionPrompt(), { agentType: 'general-purpose', schema: PARTITION_SCHEMA, phase: 'Partition', label: 'partition', effort: 'medium', model: 'sonnet' })
	slices = (part?.slices || []).filter((s) => s && s.slicePath)
	// 過分割 fail-fast: 先頭セグメント粒度なら最大 20 のはず。暴走（観点×スライスのエージェント爆発）を構造的に防ぐ。
	if (slices.length > 40) {
		throw new Error(`review-all: partition 過分割 (${slices.length} スライス)。先頭ディレクトリ粒度で最大 20 のはず。partitionPrompt の粒度指定を要確認。`)
	}
	if (!slices.length) slices = [{ id: 'all', label: 'all', slicePath: effectiveDiffPath, hasTests: !!A.hasTests }]
	log(`partition: ${slices.length} スライス`)
} else {
	slices = [{ id: 'all', label: 'all', slicePath: effectiveDiffPath, hasTests: !!A.hasTests }]
}

// 規模超過スライス: 再分割後もなお巨大なら reviewCompleteness=complete を機械的に禁止する（agent の自己申告に依存しない）
const forcedPartial = slices.filter((s) => (s.lines || 0) >= FORCED_PARTIAL_LINE_THRESHOLD).map((s) => s.id)
if (forcedPartial.length) log(`forcedPartial: ${forcedPartial.join(', ')}（${FORCED_PARTIAL_LINE_THRESHOLD} 行超 → complete 禁止）`)

// テスト用フック: partition の妥当性だけを安価に検証する（本番では渡さない）
if (A.partitionOnly) {
	return { sliceCount: slices.length, forcedPartial, slices: slices.map((s) => ({ id: s.id, label: s.label, lines: s.lines, hasTests: s.hasTests, slicePath: s.slicePath, riskTags: s.riskTags, suggestedLenses: s.suggestedLenses })) }
}

// ── Phase: Spec（仕様あり時のみ・PR 全体に対し各 1 回。integration mode では skip） ──
const specLenses = [
	{ key: 'conformance', jp: '整合性レビュアー（要件↔設計↔実装の一致）', agentType: 'hahifuhe-conformance-reviewer', hint: 'まず agents/hahifuhe-conformance-reviewer.md を Read しプレイブックとして実行。' },
	// 要件レビューと設計レビューは同一 agentType（hahifuhe-reviewer）で対象も PR 全体 diff＋仕様文書と重なるため、1 体に統合して同じ入力を二度読みしない。観点は両方を通しで適用し、finding ごとに由来観点を明記して retro の振り分けを維持する。
	{ key: 'spec-doc', jp: '要件・設計文書レビュアー（requirements の質 + design の妥当性 + 逆おこし鮮度）', agentType: 'hahifuhe-reviewer', hint: 'まず ~/.claude/commands/hahifuhe:review-requirements.md と ~/.claude/commands/hahifuhe:review-architecture.md（必要なら agents/hahifuhe-reviewer.md）を両方 Read し playbook として実行。次の 2 観点を 1 パスで通しで適用する: (1) requirements 文書の質（完全性 / 検証可能性 / 値域表記の一貫性 / 追補記録）、(2) design 文書の妥当性 + 逆おこし鮮度（補助文書↔実装/diff の乖離を最重要に）。各 finding の title 冒頭に由来観点 [requirements] か [design] を必ず付け、後段の retro 振り分けが効くようにする。' },
]
let specResults = []
let specPromise = null
if (MODE === 'integration') {
	log('integration mode: Spec フェーズ skip（テーマは個別 review 済み・統合起因リスクに集中）')
} else if (A.spec?.found) {
	phase('Spec')
	// Spec は Claude API 主体でローカル CLI と競合しないため barrier にしない（2026-07-04）。
	// Code 検出（Cursor bugbot / Codex）と並走させる。完了し次第 Verify の early バッチが消費し（2026-07-09 パイプライン化）、
	// 生値の回収は Synthesize 入力の組み立て時（specResults は cmFindings 構築と Synthesize でしか使わない）。
	specPromise = parallel(specLenses.map((l) => () =>
		agentM(specPrompt(l), { agentType: l.agentType, schema: REVIEW_SCHEMA, phase: 'Spec', label: `spec:${l.key}`, effort: 'high' })
	))
} else {
	log(`spec: なし（理由: ${A.spec?.reason || '専用/関連 spec を特定できず'}）→ Phase 1 スキップ`)
}

// ── Phase: Code ──
phase('Code')

// full mode の code lens（lens routing で per-slice に絞る）
const codeLenses = [
	{ key: 'impact', jp: '変更影響レビュアー', agentType: 'hahifuhe-impact-reviewer', extra: '■ 変更影響は LSP の incomingCalls(シグネチャ変更の呼び出し元)/goToImplementation(interface 実装列挙)/hover(型) が最も効く。' },
	{ key: 'quality', jp: 'コード品質レビュアー', agentType: 'hahifuhe-quality-reviewer', extra: '■ 設計で意図的に選んだ判断（spec distilled 参照）を品質問題と誤指摘しないこと。' },
	{ key: 'security', jp: 'セキュリティレビュアー（OWASP 級チェックリストで体系 sweep）', agentType: 'hahifuhe-security-reviewer', extra: '■ まず agents/hahifuhe-security-reviewer.md を Read。7 軸(認証認可/injection/入力検証/秘密/SSRF・CORS/プロジェクト固有/その他)を sweep し、対象変更なしの軸も明記。' },
	// bugbot の通常実行は Cursor（cursorBugbotPrompt）。この lens 定義（agentType/extra）は cursor-agent 失敗時の Claude fallback 用。
	{ key: 'bugbot', jp: '仮想 Bugbot レビュアー（実バグ先回り）', agentType: 'bugbot-review', extra: '■ まず agents/bugbot-review.md と lenses、対象差分に関わる .cursor/BUGBOT.md(ルート＋変更ファイル親方向) を Read。' },
]
// テスト健全性は Claude の独立 lens（Codex は test 健全性を見ないため非重複＝常時 Claude が回す）。
const testLens = { key: 'test-sanity', jp: 'テスト健全性レビュアー（トートロジー/メタ検出）', agentType: 'general-purpose', model: 'sonnet', extra: '■ まず ~/.claude/skills/tautology-test-detector/SKILL.md と references/detection-criteria.md を Read し playbook として実行。対象はテストの追加/変更行のみ。5 類型に照らし誤検出ガードと突き合わせる。severity 既定 Minor。' }
// 分類不能スライスの保険（安全側で明白な実害だけ軽く確認）
const FALLBACK_LENS = { key: 'fallback-general-light', jp: '軽量汎用レビュアー（分類不能スライスの保険）', agentType: 'general-purpose', model: 'sonnet', effort: 'low', extra: '■ このスライスは risk 分類で明確な lens に該当しなかった。明白な実害（壊れる/security/データ不整合）だけを軽く確認し、深掘りはしない。' }

// integration mode の code lens（統合起因リスク限定）
const integrationChecklist = `■ 統合起因リスク限定レビュー（通常 full review はしない）。見る対象を次に限定する:
  - merge conflict 解消で意味が変わった箇所
  - テーマ間相互作用（個別にレビュー済みの変更が組み合わさって壊れる所）
  - shared package / public API / schema / config の整合
  - migration とアプリコードの整合
  - 統合後にしか通らない経路（個別 PR では到達しなかった経路）
  - 統合後経路をテストが押さえているか
  ※ 個別 review 済みのテーマ内部実装の通常品質/バグ指摘は対象外（重複レビューしない）。`
const integrationConsistencyLens = { key: 'integration-consistency', jp: '統合起因整合性レビュアー', agentType: 'hahifuhe-impact-reviewer', extra: integrationChecklist }
const integrationSecurityLens = { key: 'integration-security', jp: '統合起因セキュリティレビュアー', agentType: 'hahifuhe-security-reviewer', extra: '■ 統合で露出面（public endpoint / auth / secret / config）が変わった所のみ。個別 review 済みの内部実装は対象外。' }
const integrationTestLens = { key: 'integration-test', jp: '統合後経路テスト確認レビュアー', agentType: 'general-purpose', model: 'sonnet', extra: '■ 統合後にしか通らない経路をテストが押さえているかのカバレッジ観点のみ。トートロジー検出は対象外。' }

// lens routing（即効版 2-3）: partition が付けた suggestedLenses を allowlist に、security/impact は必須条件で強制。
const ROUTABLE = new Set(['impact', 'quality', 'security', 'bugbot'])
const IMPACT_TAGS = ['prod', 'impact', 'public-api', 'shared-package', 'schema', 'migration', 'async-job', 'infra', 'feature-flag', 'config', 'env']
function routeLensesForSlice(slice) {
	if (!partitionRan) return codeLenses // 小 PR（非分割）は従来どおり全 lens＝既存互換
	const suggested = Array.isArray(slice.suggestedLenses) ? slice.suggestedLenses.filter((k) => ROUTABLE.has(k)) : null
	const tags = Array.isArray(slice.riskTags) ? slice.riskTags : null
	if (suggested === null && tags === null) return codeLenses // partition がタグ付けに失敗 → 安全側で全 lens
	const chosen = new Set(suggested || [])
	if (tags && tags.includes('security')) chosen.add('security')
	if (tags && IMPACT_TAGS.some((t) => tags.includes(t))) chosen.add('impact')
	const lenses = codeLenses.filter((l) => chosen.has(l.key))
	return lenses.length ? lenses : [FALLBACK_LENS] // 分類不能 → fallback-general-light（安全側）
}

const codeTasks = []
if (MODE === 'integration') {
	for (const s of slices) {
		codeTasks.push({ lens: integrationConsistencyLens, slice: s })
		if (Array.isArray(s.riskTags) && s.riskTags.includes('security')) codeTasks.push({ lens: integrationSecurityLens, slice: s })
	}
	// test-sanity は per-slice で復活させず、テスト変更があれば統合後経路の確認 1 体に留める。
	if (slices.some((s) => s.hasTests)) codeTasks.push({ lens: integrationTestLens, slice: { id: 'all', label: 'all', slicePath: effectiveDiffPath } })
	log(`integration mode: 統合起因リスク限定 ${codeTasks.length} 体（Spec/Codex skip・通常総当たりなし）`)
} else {
	// impact/quality/bugbot も含めて per-slice の codeTasks を組む。実行段で impact/quality は Codex primary、bugbot は Cursor primary に振り分け、失敗時のみ Claude を fallback 起動する（下記 Phase: Code + Codex 参照）。
	for (const s of slices) for (const lens of routeLensesForSlice(s)) codeTasks.push({ lens, slice: s })
	for (const s of slices) if (s.hasTests) codeTasks.push({ lens: testLens, slice: s })
	if (partitionRan) {
		const bruteForce = codeLenses.length * slices.length + slices.filter((s) => s.hasTests).length
		log(`lens routing: ${slices.length} スライス → ${codeTasks.length} 体（総当たり ${bruteForce} 体から削減・impact/quality${BUGBOT_ENGINE === 'codex' ? '/bugbot' : ''} は Codex${BUGBOT_ENGINE === 'cursor' ? '、bugbot は Cursor' : ''} primary）`)
	}
}

// ── Phase: Code + Codex ──
// impact/quality は Codex を primary 検出器にする（実測 n=4: Codex が actionable Major を取る傾向。whole-diff を一括で読むためクロススライスの統合バグに強い）。
// Claude の impact/quality は「Codex が best-effort で失敗（ok:false）した lens」だけ fallback 起動し、網羅の floor を保つ。
// security / test-sanity / fallback-general-light は Codex が回さない非重複観点なので常時 Claude が回す。
// bugbot は BUGBOT_ENGINE で切替（2026-07-09 閣下決定・可逆）: 既定 'codex' は Codex whole-diff が retro 観点集
// （bugbot-review.lenses.md）+ .cursor/BUGBOT.md を照合して先回りし、失敗時のみ Claude bugbot-review へ per-slice fallback。
// 'cursor' 明示時は旧構成 = Cursor（cursor-agent, composer-2.5）primary（実測 過去レビューの実例: 速い・Claude トークンほぼゼロ・
// 精度遜色なし）。cursor-agent 失敗（cursorOk:false / agent 死亡）のスライスのみ Claude bugbot-review へ fallback。
// Codex の過剰指摘（false-positive Major）の降格は Synthesize 段が一次コードで裏取りして行う（synthPrompt 参照。従来は Claude impact reviewer が担っていた役割を移設）。
// BUGBOT_ENGINE='codex'（既定）では bugbot も Codex 側の集合に入る: per-slice の bugbot タスクは
// Codex whole-diff がカバーし、Codex が ok を返せなかったときだけ Claude bugbot-review が per-slice fallback。
// 'cursor' 明示時は旧構成（bugbot=Cursor primary + Claude fallback）に完全復帰する。
const CODEX_LENSES = BUGBOT_ENGINE === 'codex' ? new Set(['impact', 'quality', 'bugbot']) : new Set(['impact', 'quality'])
const CURSOR_LENSES = BUGBOT_ENGINE === 'cursor' ? new Set(['bugbot']) : new Set()
const alwaysTasks = codeTasks.filter((t) => !CODEX_LENSES.has(t.lens.key) && !CURSOR_LENSES.has(t.lens.key))
const codexCoveredTasks = codeTasks.filter((t) => CODEX_LENSES.has(t.lens.key))
const cursorBugbotTasks = codeTasks.filter((t) => CURSOR_LENSES.has(t.lens.key))

// ── 並走レイアウト（2026-07-09 改訂: Cursor×Codex 並走・「ローカル CLI 同時1本」直列を撤廃） ──
// 旧直列（Cursor→Codex）の根拠は 過去レビューの実例の実測（cursor 単体 2:51 / 他CLI並列で 10分 timeout）だったが、
// (1) もう1つの根拠 run 20260703-230122 はビデオ会議の外部負荷が交絡と当時のコメント自身が認定済み、
// (2) run 20260708-154552 では cursor-agent 4本同時が全数完走（15:51-15:56 成果物実測）— cursor 同士4本が
//     共存できるなら cursor×codex の2本並走が致命的とは考えにくい。
// 失敗しても cursorOk:false / ok:false → Claude fallback が拾う fail-open 設計なので壊れず遅くなるだけ。
// timeout 多発が再現したら review-all.js.bak-20260709-pre-parallel-pipeline へ cp で戻す。
// Codex は Partition 前（t=0）に起動済み。ここでは Claude 系（API 主体）と Cursor bugbot を即時並走起動する。
// cursorBugbotRaw は filter(Boolean) しない（cursorBugbotTasks と index を揃えて失敗スライスを特定するため）。
const alwaysPromise = parallel(alwaysTasks.map((t) => () =>
	agentM(codePrompt(t.lens, t.slice), { agentType: t.lens.agentType, schema: REVIEW_SCHEMA, phase: 'Code', label: `${t.lens.key}:${t.slice.id}`, effort: t.lens.effort || 'high', ...(t.lens.model ? { model: t.lens.model } : {}) })
)).then((r) => r.filter(Boolean))
const cursorBugbotRawPromise = parallel(cursorBugbotTasks.map((t) => () =>
	agentM(cursorBugbotPrompt(t.slice), { agentType: 'general-purpose', schema: CURSOR_REVIEW_SCHEMA, phase: 'Code', label: `bugbot(cursor):${t.slice.id}`, effort: 'low' })
))

// bugbot chain: cursor-agent 成功分を採用し、失敗（cursorOk:false / agent 死亡で null）分は Claude bugbot fallback を
// 即起動する（API 主体なのでローカル CLI と競合しない）。await せず chain にするのは、完了し次第
// Verify の bugbot バッチを起動するため（下記 Verify パイプライン参照）。
const cursorChainPromise = cursorBugbotRawPromise.then(async (cursorBugbotRaw) => {
	const cursorOkResults = []
	const cursorFallbackTasks = []
	cursorBugbotTasks.forEach((t, i) => {
		const r = cursorBugbotRaw[i]
		if (r && r.cursorOk) cursorOkResults.push(r)
		else cursorFallbackTasks.push(t)
	})
	if (cursorFallbackTasks.length) log(`Claude bugbot fallback 起動: ${cursorFallbackTasks.length} 体（cursor-agent 未成功）`)
	const cursorFallbackResults = cursorFallbackTasks.length
		? (await parallel(cursorFallbackTasks.map((t) => () =>
				agentM(codePrompt(t.lens, t.slice), { agentType: t.lens.agentType, schema: REVIEW_SCHEMA, phase: 'Code', label: `${t.lens.key}:${t.slice.id}(fallback)`, effort: t.lens.effort || 'high' })
			))).filter(Boolean)
		: []
	return { cursorOkResults, cursorFallbackResults }
})

// Codex chain: 結果回収 → ok を返せなかった lens の Claude per-slice fallback を起動。
// integration mode は codexThunks=[]・codexCoveredTasks=[]（integration lens は key が impact/quality でないため
// CODEX_LENSES に該当せず全て alwaysTasks 側に落ちる）ため実質 no-op。
const codexChainPromise = codexPromise.then(async (codexRaw) => {
	const codexResults = codexRaw.filter(Boolean)
	const codexOkByLens = new Map(codexResults.map((r) => [r.lens, !!r.ok]))
	const codexFallbackTasks = codexCoveredTasks.filter((t) => !codexOkByLens.get(t.lens.key))
	if (codexFallbackTasks.length) {
		const failedLenses = [...new Set(codexFallbackTasks.map((t) => t.lens.key))].join(',')
		log(`Claude fallback 起動: ${codexFallbackTasks.length} 体（理由: Codex 未成功 lens=${failedLenses}）`)
	}
	const codexFallbackResults = codexFallbackTasks.length
		? (await parallel(codexFallbackTasks.map((t) => () =>
				agentM(codePrompt(t.lens, t.slice), { agentType: t.lens.agentType, schema: REVIEW_SCHEMA, phase: 'Code', label: `${t.lens.key}:${t.slice.id}(fallback)`, effort: t.lens.effort || 'high' })
			))).filter(Boolean)
		: []
	return { codexResults, codexFallbackResults }
})

// ── Phase: Verify（2026-07-09 パイプライン化: 検出完了したソース群から順次裏取り） ──
// 旧: 全検出（Spec+Claude常設+Cursor+Codex）を barrier で待ってから一括クラスタリング→検証（終盤の直列 ~8分）。
// 新: 3 バッチ — early（Spec+Claude常設）/ codex（Codex+その fallback）/ bugbot（Cursor+その fallback）——
//     ごとに、そのソース群が終わり次第クラスタリング→検証を起動する。バッチ内は従来同様スライス単位クラスタで
//     重複指摘の dedup が効く。バッチ間の同一箇所重複（bugbot×security 等）は別々に検証される（トークン若干増・
//     突合は Synthesize が行う）。全バッチ合計 C+M=0 なら verify=null（従来の skip と同義・Synthesize の代替裏取り経路が効く）。
// 実行エンジン既定は Claude（verifyPrompt・バッチ内全タスク並列）。API 主体でローカル CPU/メモリ負荷と無縁のため、
// ビデオ会議等の外部負荷や他 CLI との資源競合で落ちない。
// Cursor 委譲（ADR: 三者協議 2026-07-03「C 強化版」）は 2026-07-04 に既定から降格:
// 実測 run 20260703-230122 で外部負荷（ビデオ会議中）により cursor-agent が 600s 無出力 timeout → 10 分全損。
// 成功時 2.5 分 vs 失敗時 15 分超の期待値で Claude 並列が優位。
// 再評価したいときは args.verifyEngine="cursor" を明示（コード温存。shadow-audit 用 verify-*.json 成果物は Cursor 経路のみ生成）。
const verifyEngine = A.verifyEngine === 'cursor' ? 'cursor' : 'claude'

function collectCm(reviewResults, batch) {
	const out = []
	for (const r of reviewResults) {
		for (const f of r.findings || []) {
			if (f.severity !== 'Critical' && f.severity !== 'Major') continue
			out.push({
				id: f.id || `${r.reviewer}-${r.scope || 'all'}-${batch}${out.length + 1}`,
				severity: f.severity, title: f.title, location: f.location, note: f.note, reportPath: r.reportPath,
			})
		}
	}
	return out
}
function collectCmFromCodex(codexResults) {
	const out = []
	for (const c of codexResults) {
		if (!c.ok) continue
		for (const f of c.additionalFindings || []) {
			if (!/critical|major/i.test(f.severity || '')) continue
			out.push({
				id: `codex-${c.lens}-${out.length + 1}`,
				severity: /critical/i.test(f.severity) ? 'Critical' : 'Major', title: f.title, location: f.location, reportPath: c.reportPath,
			})
		}
	}
	return out
}

const cmCounts = { early: 0, codex: 0, bugbot: 0 }

async function runVerifyBatch(cmFindings, batch) {
	if (!cmFindings.length) return []
	const sliceFor = (location) => {
		const p = String(location || '').split(':')[0]
		const seg = p.split('/')
		const name = seg[0] === 'apps' || seg[0] === 'packages' ? seg[1] : seg[0]
		return slices.find((s) => s.id !== 'all' && name && (String(s.id).includes(name) || String(s.label).includes(name))) || slices[0]
	}
	const clusters = new Map()
	for (const f of cmFindings) {
		const s = sliceFor(f.location)
		if (!clusters.has(s.id)) clusters.set(s.id, { slice: s, findings: [] })
		clusters.get(s.id).findings.push(f)
	}
	const verifyTasks = []
	for (const { slice, findings } of clusters.values()) {
		for (let i = 0; i < findings.length; i += VERIFY_CLUSTER_MAX) {
			verifyTasks.push({ slice, findings: findings.slice(i, i + VERIFY_CLUSTER_MAX), part: Math.floor(i / VERIFY_CLUSTER_MAX), batch })
		}
	}
	log(`Verify[${batch}]: Critical/Major ${cmFindings.length} 件を ${verifyTasks.length} 体で独立検証（engine=${verifyEngine}）`)
	let verifyResults
	if (verifyEngine === 'cursor') {
		// Cursor 委譲経路（opt-in）。index を verifyTasks と揃えて失敗タスクを特定するため filter(Boolean) しない。
		// バッチ内は従来どおり 1 体ずつ直列（パイプライン化によりバッチ間の重なりは起こり得る＝Cursor×Codex 並走と同思想）。
		const cursorVerifyRaw = []
		for (const t of verifyTasks) {
			cursorVerifyRaw.push(
				await agentM(cursorVerifyPrompt(t), {
					agentType: 'general-purpose',
					schema: CURSOR_VERIFY_SCHEMA,
					phase: 'Verify',
					label: `verify(cursor):${batch}:${t.slice.id}${t.part ? `-${t.part}` : ''}`,
					effort: 'low',
				}),
			)
		}
		const verifyFallbackTasks = verifyTasks.filter((_, i) => !cursorVerifyRaw[i] || cursorVerifyRaw[i].cursorOk === false)
		if (verifyFallbackTasks.length)
			log(`Verify[${batch}]: cursor 失敗 ${verifyFallbackTasks.length}/${verifyTasks.length} タスクを Claude fallback で再検証`)
		const fallbackVerifyResults = verifyFallbackTasks.length
			? (
					await parallel(
						verifyFallbackTasks.map(
							(t) => () =>
								agentM(verifyPrompt(t), {
									agentType: 'general-purpose',
									schema: VERIFY_SCHEMA,
									phase: 'Verify',
									label: `verify(fallback):${batch}:${t.slice.id}${t.part ? `-${t.part}` : ''}`,
									effort: 'medium',
								}),
						),
					)
				).filter(Boolean)
			: []
		verifyResults = [...cursorVerifyRaw.filter((r) => r && r.cursorOk !== false), ...fallbackVerifyResults]
	} else {
		// Claude 並列経路（既定）。API 主体なのでタスク間の資源競合が無く、バッチ内全クラスタを同時に検証できる。
		verifyResults = (
			await parallel(
				verifyTasks.map(
					(t) => () =>
						agentM(verifyPrompt(t), {
							agentType: 'general-purpose',
							schema: VERIFY_SCHEMA,
							phase: 'Verify',
							label: `verify:${batch}:${t.slice.id}${t.part ? `-${t.part}` : ''}`,
							effort: 'medium',
						}),
				),
			)
		).filter(Boolean)
	}
	return verifyResults.flatMap((r) => r.results || [])
}

// バッチ配線: 各ソース群の完了 promise に verify を連結する（ここでは await しない＝検出と検証が重なって走る）。
const verifyEarlyPromise = Promise.all([specPromise || Promise.resolve([]), alwaysPromise]).then(([specRaw, alwaysResults]) => {
	const cm = collectCm([...specRaw.filter(Boolean), ...alwaysResults], 'early')
	cmCounts.early = cm.length
	return runVerifyBatch(cm, 'early')
})
const verifyCodexPromise = codexChainPromise.then(({ codexResults, codexFallbackResults }) => {
	const cm = [...collectCmFromCodex(codexResults), ...collectCm(codexFallbackResults, 'codex')]
	cmCounts.codex = cm.length
	return runVerifyBatch(cm, 'codex')
})
const verifyBugbotPromise = cursorChainPromise.then(({ cursorOkResults, cursorFallbackResults }) => {
	const cm = collectCm([...cursorOkResults, ...cursorFallbackResults], 'bugbot')
	cmCounts.bugbot = cm.length
	return runVerifyBatch(cm, 'bugbot')
})

// ── 検出＋検証の回収（Synthesize 入力。ここで初めて全体を await する） ──
const { cursorOkResults, cursorFallbackResults } = await cursorChainPromise
const { codexResults, codexFallbackResults } = await codexChainPromise
const alwaysResults = await alwaysPromise
if (specPromise) specResults = (await specPromise).filter(Boolean)
const codeResults = [...alwaysResults, ...cursorOkResults, ...codexFallbackResults, ...cursorFallbackResults]

const verifyResultsMerged = [...(await verifyEarlyPromise), ...(await verifyCodexPromise), ...(await verifyBugbotPromise)]
const cmTotal = cmCounts.early + cmCounts.codex + cmCounts.bugbot
let verify = null
if (cmTotal) {
	// 三値判定 + kill premise の機械ゲート & disposition 導出（条件付き必須を JS で強制。2026-07-27 三者協議合意）
	const dispositions = {}
	for (const r of verifyResultsMerged) dispositions[r.findingId] = deriveVerifyDisposition(r)
	const dv = Object.values(dispositions)
	verify = {
		results: verifyResultsMerged,
		dispositions,
		confirmedCount: dv.filter((d) => d === 'blocker').length,
		demotedCount: dv.filter((d) => d === 'demoted-existing' || d === 'demoted-scope').length,
		refutedCount: dv.filter((d) => d === 'refuted').length,
		inconclusiveCount: dv.filter((d) => d === 'unverified-risk').length,
	}
	log(
		`Verify 完了: blocker=${verify.confirmedCount} / demoted=${verify.demotedCount} / refuted=${verify.refutedCount} / inconclusive=${verify.inconclusiveCount}（C/M 内訳 early=${cmCounts.early} codex=${cmCounts.codex} bugbot=${cmCounts.bugbot}）`,
	)
} else {
	log('Verify: Critical/Major 0 件のため skip')
}

// ── Phase: Synthesize（合成専用エージェント。メインには判定のみ返す） ──
phase('Synthesize')
const payload = {
	mode: MODE,
	modeResolved: MODE,
	isFullReview,
	delta: deltaContext
		? {
			decisionPath: deltaContext.decisionPath,
			previousFullHeadSha: deltaContext.previousFullHeadSha,
			previousFullReportPath: deltaContext.previousFullReportPath,
			deltaDiffPath: effectiveDiffPath,
			filesCount: deltaContext.filesCount,
		}
		: null,
	target: A.target,
	spec: A.spec?.found && MODE !== 'integration' ? { manifestPath: A.spec.manifestPath } : { found: false },
	slices: slices.map((s) => ({ id: s.id, label: s.label, riskTags: s.riskTags, suggestedLenses: s.suggestedLenses })),
	specReviews: specResults.map((r) => ({ reviewer: r.reviewer, scope: r.scope, verdict: r.verdict, counts: r.counts, reportPath: r.reportPath, coveragePath: r.coveragePath, findings: r.findings, unverifiedRisksCount: r.unverifiedRisksCount, unverifiedRisksPreview: r.unverifiedRisksPreview, escalationRequired: r.escalationRequired, budgetUsed: r.budgetUsed, budgetLimit: r.budgetLimit })),
	codeReviews: codeResults.map((r) => ({ reviewer: r.reviewer, scope: r.scope, verdict: r.verdict, counts: r.counts, reportPath: r.reportPath, coveragePath: r.coveragePath, findings: r.findings, unverifiedRisksCount: r.unverifiedRisksCount, unverifiedRisksPreview: r.unverifiedRisksPreview, escalationRequired: r.escalationRequired, budgetUsed: r.budgetUsed, budgetLimit: r.budgetLimit })),
	codexReviews: codexResults.map((r) => ({ lens: r.lens, ok: r.ok, counts: r.counts, reportPath: r.reportPath, additionalFindings: r.additionalFindings })),
	verify,
	forcedPartial,
}
const synth = await agentM(synthPrompt(payload), { agentType: 'general-purpose', schema: SYNTH_SCHEMA, phase: 'Synthesize', label: 'synthesize', effort: 'high' })

log(`review-all[${MODE}] 完了: ${synth?.finalVerdict} (${synth?.reviewCompleteness}) / Critical=${synth?.totals?.critical} Major=${synth?.totals?.major} / 未確認=${synth?.unverifiedRisksTotal ?? '?'} / report=${synth?.reportPath}`)
return synth
