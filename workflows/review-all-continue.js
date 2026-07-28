export const meta = {
	name: 'review-all-continue',
	description: '俺様レビューオール（継続版・縮退）: 既存の impact/quality/security/Codex 所見を再利用し、未実行の bugbot・test健全性・Synthesize だけを回す。中断した試走の残りを完走するための継続スクリプト。※ Verify（C/M の独立検証）を実行しないため判定の信頼度は full 実行（review-all.js）より低い。SYNTH_SCHEMA とファイル命名規約を review-all.js から複製しており、本家の契約変更時は同期を確認すること。',
	whenToUse: '既に impact/quality/security 所見ファイルが outDir に存在し、bugbot/test-sanity と統合レポートだけ残っている中断 run を完走させたいとき。',
	phases: [
		{ title: 'Code-rest', detail: 'bugbot（全スライス）＋ test健全性（テスト有スライス）を fan-out' },
		{ title: 'Synthesize', detail: '既存39本＋新規＋Codex を合成し統合レポートを Write、メインには判定のみ返す' },
	],
}

const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
if (!A.outDir || !Array.isArray(A.slices) || !A.slices.length) {
	throw new Error('review-all-continue: args.outDir / args.slices 未設定。args=' + (typeof args === 'string' ? args.slice(0, 200) : JSON.stringify(A).slice(0, 200)))
}

const repoRoot = A.repoRoot || ''

// head 固定（review-all.js と同期・2026-07-11）: 作業ツリーは base ブランチのままでありうる（PR レビューは head を fetch するだけで checkout しない）。
// args.headSha は任意（旧 run の継続では未指定がありうる）— 未指定時は fail-closed の注意文に縮退する。
const headSha = A.headSha || ''
const headPin = headSha
	? `
■ head 固定（作業ツリー直読み禁止・必須）: レビュー対象の head は ${headSha}。ローカル作業ツリー（${repoRoot} の checkout）が head と一致する保証はない。
  - ファイル実読・存在/残存確認・grep は必ず head SHA を明示した git 読みで行う: \`git -C ${repoRoot} show ${headSha}:<path>\` / \`git -C ${repoRoot} grep <pattern> ${headSha} -- '<pathspec>'\` / 存在確認は \`git -C ${repoRoot} ls-tree -r --name-only ${headSha} -- <path>\`。
  - **ローカル作業ツリーへの直接 Read / grep / ls / find / git ls-files を検証根拠にしてはならない**（head で削除済みのファイルが作業ツリーに残っていて「残存している」と誤認する等）。例外は \`git -C ${repoRoot} rev-parse HEAD\` が ${headSha} と一致することを自分で確認した場合のみ。
  - Serena/LSP も作業ツリーを読む。シンボル位置の当たり付けに使うのはよいが、finding の最終根拠は上記 git 読み（または一致確認済みの作業ツリー）で取ること。`
	: `
■ head 固定: args.headSha 未指定のため、作業ツリーがレビュー対象 head と一致する保証がない。「ファイルが存在する / 残っている / 削除されていない」を根拠にする判定は断定せず、未確認としてラベルすること。`

// ───────────────────────── schemas（review-all.js と同一） ─────────────────────────

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

const REVIEW_SCHEMA = {
	type: 'object',
	required: ['reviewer', 'verdict', 'counts', 'reportPath'],
	properties: {
		reviewer: { type: 'string' },
		scope: { type: 'string' },
		verdict: { type: 'string', enum: ['GO', 'NO-GO', 'N/A'] },
		counts: COUNTS,
		findings: {
			type: 'array',
			items: {
				type: 'object',
				required: ['severity', 'title', 'location'],
				properties: {
					severity: { type: 'string', enum: ['Critical', 'Major', 'Minor', 'Info'] },
					title: { type: 'string' },
					location: { type: 'string' },
					note: { type: 'string' },
				},
			},
		},
		reportPath: { type: 'string' },
		notes: { type: 'string' },
	},
}

// 即効版 2-5 と同一の多値判定契約（review-all.js の SYNTH_SCHEMA と揃える）。
const SYNTH_SCHEMA = {
	type: 'object',
	required: ['overallVerdict', 'finalVerdict', 'reviewCompleteness', 'totals', 'reportPath'],
	properties: {
		// 互換用（既存の判定消費者向け）。finalVerdict から導出する。
		overallVerdict: { type: 'string', enum: ['GO', 'NO-GO'] },
		// 多値判定。「問題なし」と「未確認あり」を分離する。
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
			description: 'escalationRequired=true の reviewer（high-priority follow-up）',
			items: { type: 'object', properties: { reviewer: { type: 'string' }, scope: { type: 'string' } } },
		},
		summary: { type: 'string', description: '1〜3 行の総評（任意）' },
	},
}

// ───────────────────────── prompt 部品（review-all.js から流用） ─────────────────────────

const serenaLsp = `
■ コード探索: Serena + typescript-lsp を併用（Grep/Glob はコードに対し hook でブロックされる）。
  1) ToolSearch("select:mcp__plugin_serena_serena__find_symbol,mcp__plugin_serena_serena__get_symbols_overview,mcp__plugin_serena_serena__search_for_pattern,mcp__plugin_serena_serena__find_file,mcp__plugin_serena_serena__find_referencing_symbols,mcp__plugin_serena_serena__activate_project")
  2) ToolSearch("select:LSP")
  3) Serena は初回のみ activate_project（project="${repoRoot}"）が必要。
  設定/ドキュメント（.json/.md/.yml）には Read/Grep/Glob 可。`

function returnDiscipline(reportPath) {
	return `
■ 出力規律（最重要・コンテキスト膨張対策）:
  - フル所見（各 finding の本文・根拠・file:line・修正案・良好な点）は **Write で次のファイルにだけ書く**: ${reportPath}
  - 構造化返却（StructuredOutput）には **件数・GO/NO-GO・finding の見出し(severity/title/location)・reportPath だけ** を入れる。finding 本文は返却に入れない（ファイルにのみ残す）。
  - reportPath には上記絶対パスをそのまま入れること。`
}

function targetLock(slicePath) {
	return `
■ 対象固定（取り違え厳禁）: 一次入力は ${slicePath} の diff のみ。**このファイルが存在しない/空のときは、git diff を自前で再取得しない**（別ブランチを拾って対象 PR を取り違えるため）。その場合は reportPath に「入力 diff 欠落（${slicePath}）」と記し、counts 全 0・verdict 'N/A' で返すこと。`
}

const groundTruth = `
■ Ground Truth: finding を上げる前に対象コード・呼び出し元・既存防御を実際に読む。事実/推論/推測をラベルする。Major 以上は「意図的でないか・本番到達するか・test/prod 区別」を一次情報で確認してから severity 確定。`

function codePrompt(lens, slice) {
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
■ 実害ゲート: 各指摘は未対応時の実害（security/performance/UX/正しさ）と到達可能性を一段検証し、actionable と参考を分離する。既存防御があるものは「確認事項」に落とす。
${returnDiscipline(`${A.outDir}/${lens.key}-${slice.id}.md`)}

scope は "${slice.label}"。reviewer は "${lens.key}"。`
}

function synthPrompt(payload) {
	const reportPath = `${A.outDir}/comprehensive-review-${A.ts}.md`
	return `あなたは統合レポート作成担当です。各 reviewer が書いた所見ファイルとカバレッジファイルを読み、1 つの統合レポートにまとめます。

入力（各 reviewer の compact 結果。本文は reportPath、カバレッジ全件は coveragePath のファイルにある）:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

手順:
1. 各 reportPath ファイルを Read してフル所見を取得する（存在しないパスは「未生成」と扱う）。Codex の reportPath も読む。
2. 各 coveragePath ファイルを Read し、unverifiedRisks（未確認リスク）全件を集約する（compact の unverifiedRisksPreview は上位5件のみなので、全件はファイルから取る）。
3. **counts は各 reportPath ファイルの実所見から自分で集計し直す**（payload の counts が null/未指定でもファイルから数える）。観点別に集計し、F(BugBot)と G(セキュリティ)で重複する security 指摘は 1 件に寄せて二重計上しない。
4. **多値の総合判定**を出す（「問題なし」と「未確認あり」を分離する）:
   - NO_GO: actionable な Critical>0 または Major>0。
   - GO_WITH_UNVERIFIED_RISKS: Critical=0 かつ Major=0 だが、riskLevel=high の unverifiedRisks が残る。
   - REVIEW_INCOMPLETE: budgetUsed.rounds > budgetLimit.rounds の reviewer が重要領域を覆っている、または tool failure 等で重要領域がほぼ未確認。
   - GO: Critical=0 かつ Major=0 かつ high の unverifiedRisks なし。
   ※ F/G の actionable な Critical/Major のみ算入、参考は算入しない。test-sanity の Minor は判定を変えない。
   reviewCompleteness: complete（全 reviewer 予算内で重要領域確認済み）/ partial（一部 reviewer が予算超過 or 未確認残）/ blocked（重要領域が確認できていない）。
   overallVerdict（互換用）: finalVerdict が GO か GO_WITH_UNVERIFIED_RISKS なら 'GO'、NO_GO か REVIEW_INCOMPLETE なら 'NO-GO'。
5. escalationRequired=true の reviewer は「要追加調査（high-priority follow-up）」として集約するに留める。**このレポートで追加 reviewer は起動しない**（即効版方針）。
6. 統合レポートを次の絶対パスに Write する: ${reportPath}
   - 構成: エグゼクティブサマリー（多値総合判定 + reviewCompleteness + 統計表）/ 各観点セクション（指摘=findings）/ **「未確認リスク(unverifiedRisks)」セクションを独立で設ける**（findings と必ず分離）/ 「要追加調査(escalations)」/ 次のアクション。
   - スライス分割した観点は、スライスを跨いで観点ごとにまとめる。

返却: {overallVerdict, finalVerdict, reviewCompleteness, totals, reportPath:"${reportPath}", blockers[], unverifiedRisksTotal, highRiskUnverified[], escalations[], summary}。
■ 返却に finding 本文を入れない（レポートファイルにのみ書く）。メインに載るのはこの compact のみ。`
}

// ───────────────────────── pipeline ─────────────────────────

const slices = A.slices
// synthOnly: bugbot/test-sanity も既に outDir に揃っている中断 run（Synthesize だけ残）を、追加 agent ゼロで合成だけ完走させる。
const synthOnly = A.synthOnly === true
log(`review-all-continue: target=pr#${A.target?.ref} / slices=${slices.length} / synthOnly=${synthOnly}${synthOnly ? '' : ` / bugbot=${slices.length}・test-sanity=${slices.filter((s) => s.hasTests).length}`}`)

// ── Phase: Code-rest（bugbot 全スライス ＋ test健全性 テスト有スライス）。synthOnly なら skip ──
let restResults = []
if (!synthOnly) {
	phase('Code-rest')
	const bugbotLens = { key: 'bugbot', jp: '仮想 Bugbot レビュアー（実バグ先回り）', agentType: 'bugbot-review', extra: '■ まず agents/bugbot-review.md と lenses、対象差分に関わる .cursor/BUGBOT.md(ルート＋変更ファイル親方向) を Read。' }
	const testLens = { key: 'test-sanity', jp: 'テスト健全性レビュアー（トートロジー/メタ検出）', agentType: 'general-purpose', extra: '■ まず ~/.claude/skills/tautology-test-detector/SKILL.md と references/detection-criteria.md を Read し playbook として実行。対象はテストの追加/変更行のみ。5 類型に照らし誤検出ガードと突き合わせる。severity 既定 Minor。' }

	const restTasks = []
	for (const s of slices) restTasks.push({ lens: bugbotLens, slice: s })
	for (const s of slices) if (s.hasTests) restTasks.push({ lens: testLens, slice: s })

	restResults = (await parallel(restTasks.map((t) => () =>
		agent(codePrompt(t.lens, t.slice), { agentType: t.lens.agentType, schema: REVIEW_SCHEMA, phase: 'Code-rest', label: `${t.lens.key}:${t.slice.id}`, effort: 'high' })
	))).filter(Boolean)

	log(`Code-rest 完了: ${restResults.length}/${restTasks.length} 観点が返却`)
} else {
	log('synthOnly: Code-rest（bugbot/test-sanity）を skip。既存所見ファイルのみで合成する')
}

// ── Phase: Synthesize ──
phase('Synthesize')

// 既存（前 run で生成済み）の所見を payload に再構成（synth が reportPath/coveragePath ファイルを Read する）。
// synthOnly のときは bugbot/test-sanity も existingCodeLenses に含めて渡す。
const existingReviews = []
for (const lensKey of (A.existingCodeLenses || [])) {
	for (const s of slices) {
		existingReviews.push({
			reviewer: lensKey,
			scope: s.label,
			verdict: null,
			counts: null,
			reportPath: `${A.outDir}/${lensKey}-${s.id}.md`,
			coveragePath: `${A.outDir}/${lensKey}-${s.id}.coverage.json`,
			findings: [],
		})
	}
}

const codeReviews = existingReviews.concat(
	restResults.map((r) => ({ reviewer: r.reviewer, scope: r.scope, verdict: r.verdict, counts: r.counts, reportPath: r.reportPath, coveragePath: r.coveragePath, findings: r.findings, unverifiedRisksCount: r.unverifiedRisksCount, unverifiedRisksPreview: r.unverifiedRisksPreview, escalationRequired: r.escalationRequired, budgetUsed: r.budgetUsed, budgetLimit: r.budgetLimit }))
)

const codexReviews = (A.codexPaths || []).map((p) => ({ lens: p.includes('impact') ? 'impact' : 'quality', ok: true, counts: null, reportPath: p, additionalFindings: [] }))

const payload = {
	target: A.target,
	spec: { found: false },
	slices: slices.map((s) => ({ id: s.id, label: s.label })),
	specReviews: [],
	codeReviews,
	codexReviews,
}

const synth = await agent(synthPrompt(payload), { agentType: 'general-purpose', schema: SYNTH_SCHEMA, phase: 'Synthesize', label: 'synthesize', effort: 'high' })

log(`review-all-continue 完了: ${synth?.finalVerdict} (${synth?.reviewCompleteness}) / Critical=${synth?.totals?.critical} Major=${synth?.totals?.major} / 未確認=${synth?.unverifiedRisksTotal ?? '?'} / report=${synth?.reportPath}`)
return synth
