export const meta = {
	name: 'verify-shadow-audit',
	description: 'review-all の Cursor 検閲（Verify）を後追いで抜き打ち再検証し、不一致率を計測する影監査。本線（review-all.js）非依存 — 廃止するときはこのファイルを呼ぶのをやめるだけでよい（本線の変更ゼロ）',
	whenToUse: '手動または cron で、過去の review run の outDir（verify-*.json がある場所）を対象に実行する。レビュー本線からは呼ばれない。',
	phases: [
		{ title: 'Scan', detail: 'outDir 群から verify-*.json（Cursor 検閲の成果物）を収集し、監査対象（demoted の Critical/Major）を抽出' },
		{ title: 'Audit', detail: '監査対象を Claude が5軸プロトコルで独立再検証（Cursor の判定は照合用に最後だけ見る）' },
		{ title: 'Report', detail: 'Cursor 判定との不一致を出所別に集計し、~/.claude/logs/verify-shadow-audit.jsonl へ追記' },
	],
}
// 使い方: Workflow({ scriptPath: '~/.claude/workflows/verify-shadow-audit.js', args: { outDirs: ['<review run の outDir 絶対パス>', ...] } })
// ※ 5軸プロトコルの文言は review-all.js の verifyCore の複製（監査専用）。本家の契約変更時は同期を確認すること。
// ※ 廃止手順: このワークフローを呼ぶのをやめる（cron があれば削除する）だけ。review-all.js 側に依存箇所は無い。

const outDirs = Array.isArray(args?.outDirs) ? args.outDirs.filter(Boolean) : []
if (!outDirs.length) return { error: 'args.outDirs（review run の outDir 絶対パスの配列）を渡してください' }
const LOG_PATH = args?.logPath || '~/.claude/logs/verify-shadow-audit.jsonl'
const MAX_TARGETS = args?.maxTargets || 20

phase('Scan')
const SCAN_SCHEMA = {
	type: 'object',
	required: ['targets'],
	properties: {
		targets: {
			type: 'array',
			items: {
				type: 'object',
				required: ['findingId', 'severity', 'title', 'location', 'artifactPath', 'repoRoot', 'baseSha', 'slicePath', 'cursorVerdict'],
				properties: {
					findingId: { type: 'string' },
					severity: { type: 'string' },
					title: { type: 'string' },
					location: { type: 'string' },
					note: { type: 'string' },
					reportPath: { type: 'string' },
					artifactPath: { type: 'string' },
					repoRoot: { type: 'string' },
					baseSha: { type: 'string' },
					slicePath: { type: 'string' },
					cursorVerdict: { type: 'string' },
					cursorEvidence: { type: 'string' },
					cursorReason: { type: 'string' },
				},
			},
		},
		scannedArtifacts: { type: 'integer' },
	},
}
const scan = await agent(`次の各ディレクトリにある verify-*.json（.cursor-raw.md / .cursor-prompt.txt ではなく .json のみ）をすべて Read せよ:
${outDirs.map((d) => `- ${d}`).join('\n')}
各 artifact の results から **verdict が demoted で、findings 内の対応する指摘の severity が Critical か Major** のものだけを監査対象として抽出し、targets で返せ。各 target には artifact の repoRoot / baseSha / slicePath / artifactPath と、指摘の入力情報（findingId/severity/title/location/note/reportPath）、Cursor 側の判定（cursorVerdict/cursorEvidence/cursorReason）を同梱する。engine が cursor でない artifact と {"ok":false} の artifact は飛ばす。対象が ${MAX_TARGETS} 件を超える場合は artifact の ts が新しい順に ${MAX_TARGETS} 件で打ち切る。scannedArtifacts に読んだ artifact 数を入れる。`, { schema: SCAN_SCHEMA, label: 'scan', effort: 'low' })
const targets = scan?.targets || []
log(`Scan: artifact ${scan?.scannedArtifacts ?? '?'} 件 → 監査対象（demoted の C/M）${targets.length} 件`)
if (!targets.length) return { audited: 0, mismatches: 0, note: '監査対象（demoted の Critical/Major）なし', logPath: LOG_PATH }

phase('Audit')
const AUDIT_SCHEMA = {
	type: 'object',
	required: ['verdict', 'reason'],
	properties: {
		verdict: { type: 'string', enum: ['confirmed', 'demoted', 'unverifiable'] },
		evidence: { type: 'string' },
		reason: { type: 'string' },
	},
}
const auditPrompt = (t) => `あなたは影監査担当（独立検証）です。過去のレビューで Cursor が「demoted（実害なしと反証済み）」と判定した Critical/Major 指摘を、先入観なしに再検証してください。まず自力で結論を出し、Cursor の判定は最後の照合でだけ見ること。

検証対象: [${t.findingId}] ${t.severity}: ${t.title}（${t.location}）${t.note ? ` — ${t.note}` : ''}
対象リポジトリ: ${t.repoRoot}（※当時の head から進んでいる可能性がある。baseSha=${t.baseSha}。当時のスライス diff: ${t.slicePath}。diff ファイルが消えていれば git 履歴で代替し、その旨を reason に書く）

■ 検証プロトコル（5軸）:
  (a) 到達性: 本番で現実に発火するか。 (b) 既存防御: 呼び出し元・型・既存テストで既にカバーされていないか。 (c) test/prod: 欠陥は production コードかテスト fixture か。 (d) 契約の実在性: 前提の不変条件・必須ガードが出典で実在するか（レビュアーの発明なら降格対象）。 (e) diff 由来か既存か: base を git show で読み、既存かつ非悪化なら demoted 相当。
■ 判定: confirmed=実害が一次情報で確認でき diff 由来／demoted=(a)〜(e) で反証できた（evidence に file:line 必須）／unverifiable=確認しきれない（fail-closed）。

参考（自力の結論を出した後で照合にのみ使う）: Cursor の判定=${t.cursorVerdict} / evidence=${t.cursorEvidence || '(なし)'} / reason=${t.cursorReason || '(なし)'}
返却: verdict / evidence / reason のみ。ファイルは書かない。`
const audits = await parallel(targets.map((t) => () =>
	agent(auditPrompt(t), { schema: AUDIT_SCHEMA, label: `audit:${t.findingId}`, phase: 'Audit', effort: 'medium' })
		.then((a) => ({ target: t, audit: a }))
))
const rows = audits.filter(Boolean).map(({ target, audit }) => ({
	findingId: target.findingId,
	severity: target.severity,
	source: String(target.findingId).split('-')[0] || 'unknown',
	artifactPath: target.artifactPath,
	cursorVerdict: target.cursorVerdict,
	auditVerdict: audit?.verdict || 'unverifiable',
	mismatch: (audit?.verdict || 'unverifiable') === 'confirmed',
	auditEvidence: audit?.evidence || '',
	auditReason: audit?.reason || '',
}))
const mismatches = rows.filter((r) => r.mismatch)

phase('Report')
await agent(`次の JSON 配列の各要素を、1行=1レコードの JSONL として ${LOG_PATH} に追記せよ（ディレクトリが無ければ mkdir -p。各行には実行時刻フィールド auditedAt を ISO8601 で追加すること。時刻は date コマンドで取得してよい）。追記した行数だけを返せ。
${JSON.stringify(rows)}`, { label: 'report', effort: 'low' })
const bySource = {}
for (const r of rows) {
	bySource[r.source] = bySource[r.source] || { audited: 0, mismatches: 0 }
	bySource[r.source].audited++
	if (r.mismatch) bySource[r.source].mismatches++
}
log(`影監査完了: audited=${rows.length} / mismatches(誤 demote 疑い)=${mismatches.length}`)
return {
	audited: rows.length,
	mismatches: mismatches.length,
	mismatchFindingIds: mismatches.map((r) => r.findingId),
	bySource,
	logPath: LOG_PATH,
	note: mismatches.length
		? '不一致あり: 該当指摘を人間確認へ。不一致率が継続的に高ければ B/E 構成（同期追い検閲・たすき掛け）を再検討する'
		: null,
}
