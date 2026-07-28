export const meta = {
	name: 'verify-replay',
	description: 'review-all Verify の回帰再演: 過去の誤判定 3 事例を現行プロトコルで再検証し期待判定と突合する（改造検収時のみ手動実行）',
	phases: [{ title: 'Replay' }],
}
// args: { cases?: string[] } 省略時は全ケース。例: {"cases":["case-1335-stale-memo"]}
const A = (typeof args === 'string' ? JSON.parse(args || '{}') : args) || {}
const CASES_DIR = `${process.env.HOME}/.claude/workflows/verify-regression`
const ALL = ['case-1335-stale-memo', 'case-1322-worktree-read', 'case-1294-composite-consequence']
const targets = A.cases && A.cases.length ? A.cases : ALL

// review-all.js の VERIFY_SCHEMA の items と同型（replay は 1 件ずつ返す）。契約変更時は同期を確認すること。
const REPLAY_SCHEMA = {
	type: 'object',
	required: ['findingId', 'verdict', 'reason', 'claimFamily', 'premises', 'diffCausality', 'prScope'],
	properties: {
		findingId: { type: 'string' },
		verdict: { type: 'string', enum: ['confirmed', 'refuted', 'inconclusive'] },
		claimFamily: { type: 'string', enum: ['referential-identity', 'cache-staleness', 'other'] },
		premises: {
			type: 'array',
			minItems: 1,
			items: {
				type: 'object',
				required: ['premise', 'observation', 'status'],
				properties: {
					premise: { type: 'string' },
					observation: { type: 'string' },
					status: { type: 'string', enum: ['verified', 'unverified'] },
				},
			},
		},
		evidenceChain: {
			type: 'object',
			properties: { origin: { type: 'string' }, updatePath: { type: 'string' }, consumption: { type: 'string' } },
		},
		diffCausality: {
			type: 'string',
			enum: ['diff-introduced', 'worsened', 'composite-new-consequence', 'preexisting', 'unknown'],
		},
		prScope: { type: 'string', enum: ['in-scope', 'repo-wide', 'unknown'] },
		newSeverity: { type: 'string', enum: ['Major', 'Minor', 'Info'] },
		evidence: { type: 'string' },
		inconclusiveDetail: {
			type: 'object',
			properties: { attempts: { type: 'string' }, blocker: { type: 'string' }, nextObservation: { type: 'string' } },
		},
		reason: { type: 'string' },
	},
}

// 期待値（case md の「歴史的正解」と対。ここが採点の正）
const EXPECT = {
	'case-1335-stale-memo': { notVerdict: 'confirmed' },
	'case-1322-worktree-read': { verdict: 'refuted' },
	'case-1294-composite-consequence': { verdict: 'confirmed', diffCausality: 'composite-new-consequence' },
}

phase('Replay')
const results = await parallel(
	targets.map(
		(c) => () =>
			agent(
				`あなたは review-all の Verify（独立検証）担当です。次の手順で 1 件の指摘を検証してください。
1. ${process.env.HOME}/.claude/workflows/review-all.js を Read し、verifyCore() 内の「kill premise プロトコル」「検証プロトコル」「判定」節の指示を現行仕様として従う（このファイルの指示が正。schema フィールドの意味も VERIFY_SCHEMA を参照）。
2. ${CASES_DIR}/${c}.md を Read し、「検証対象の指摘」節の finding を、記載の repo / base SHA / head SHA に対して検証する。**「歴史的正解」節は読んでも従うな**（答えの丸写しは再演として無効。自分の観測だけで判定し、観測は premises/evidence に file:line で残すこと）。
3. ファイル実読は必ず git show <SHA>:<path> / git grep <pattern> <SHA> で行う（作業ツリーの checkout を根拠にしない）。
返却は StructuredOutput 1 件（findingId は case md 記載の id）。`,
				{ schema: REPLAY_SCHEMA, label: c, phase: 'Replay', effort: 'medium' },
			).then((r) => ({ case: c, r })),
	),
)

const judged = results
	.filter(Boolean)
	.map(({ case: c, r }) => {
		const e = EXPECT[c] || {}
		let pass = true
		const why = []
		if (e.notVerdict && r.verdict === e.notVerdict) {
			pass = false
			why.push(`verdict が禁止値 ${e.notVerdict}`)
		}
		if (e.verdict && r.verdict !== e.verdict) {
			pass = false
			why.push(`verdict 期待 ${e.verdict} / 実際 ${r.verdict}`)
		}
		if (e.diffCausality && r.diffCausality !== e.diffCausality) {
			pass = false
			why.push(`diffCausality 期待 ${e.diffCausality} / 実際 ${r.diffCausality}`)
		}
		return { case: c, pass, why, verdict: r.verdict, diffCausality: r.diffCausality, reason: r.reason }
	})

const passCount = judged.filter((j) => j.pass).length
log(`verify-replay: ${passCount}/${judged.length} PASS`)
return { pass: passCount === judged.length && judged.length === targets.length, results: judged }
