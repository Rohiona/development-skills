export const meta = {
	name: 'autodev-downstream',
	description:
		'autonomous-dev の下流（実装→客観ゲート→レビュー→修正→再検証）を決定論的に自走させる。レビューは review-all を子 Workflow として呼び、所見はファイル永続化・メインには判定のみ返す。人間判断が要る時は NEEDS_HUMAN を返して終了し、回答後に resumeFromRunId + attempt 加算で再開する。',
	whenToUse:
		'autonomous-dev スキルの下流フェーズ。上流（要件・設計の人間承認）完了後に呼ぶ。曖昧・不可逆・主観に当たると NEEDS_HUMAN で止まる。',
	phases: [
		{ title: 'Implement', detail: 'Cursor headless 委譲（フォールバック: 内蔵実装）＋実装規律（reuse境界検証・責務自己評価・tautology排除）' },
		{ title: 'Gate', detail: 'gate.sh all（typecheck/test/check 一括）→ 赤なら機械修正ループ（上限5・同一エラー/増加検知はコード化）' },
		{ title: 'Review', detail: 'review-all 子 Workflow（7観点＋Codex）。判定のみ回収' },
		{ title: 'Fix', detail: 'Critical/Major の解消（設計問題は NEEDS_HUMAN）' },
		{ title: 'Reverify', detail: 'ゲート再実行→review-all フル再実行（収束上限3）' },
	],
}

// ── args 正規化（harness によっては JSON 文字列で届く） ──
const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
for (const k of ['featureDir', 'runDir', 'repoRoot', 'requirementsPath', 'designContextPath', 'runId', 'ts']) {
	if (!A[k]) throw new Error(`autodev-downstream: args.${k} 未設定`)
}
const ATTEMPT = A.attempt ?? 0 // NEEDS_HUMAN 再開のたびにメインが +1 して渡す
const BACKEND = A.implBackend || 'cursor' // 'cursor' | 'agent'
const CURSOR_MODEL = A.cursorModel || 'composer-2.5'
// モデル指定（コスト事故防止）: agentM() は既定でセッションのモデルを継承する。args.model（例 'opus'）で全 agent＋子 review-all に強制できる。
const MODEL = A.model || null
const agentM = (prompt, opts) => agent(prompt, MODEL ? { ...opts, model: MODEL } : opts)
const SCRIPTS = A.scriptsDir || `${process.env.HOME}/.claude/skills/autonomous-dev/scripts`
const ANSWERS = A.answersPath || `${A.runDir}/escalations.jsonl`
const REVIEW_DIR = `${A.runDir}/stage-review`

// ── 共通スキーマ ──
const NEEDS_HUMAN_PROPS = {
	status: { type: 'string', enum: ['DONE', 'NEEDS_HUMAN'] },
	needs_human: {
		type: 'object',
		properties: {
			reason: { type: 'string' },
			category: { type: 'string', enum: ['ambiguous', 'irreversible', 'subjective'] },
			options: { type: 'array', items: { type: 'string' } },
		},
	},
}
const IMPL_SCHEMA = {
	type: 'object',
	required: ['status', 'changed_files'],
	properties: {
		...NEEDS_HUMAN_PROPS,
		changed_files: { type: 'array', items: { type: 'string' }, description: 'repo ルート相対パス' },
		backend_used: { type: 'string', enum: ['cursor', 'agent'] },
		summary: { type: 'string' },
		extraction_report: { type: 'string', description: 'extract-testable-module の自己評価結果（切り出し or 妥当と判断した理由）' },
		reuse_boundaries: { type: 'string', description: 'verify-reuse-boundary の検証結果（無ければ "なし"）' },
		test_results: { type: 'string' },
	},
}
const GATE_SCHEMA = {
	type: 'object',
	required: ['green', 'error_signatures'],
	properties: {
		green: { type: 'boolean' },
		gates: { type: 'object', additionalProperties: true },
		error_signatures: { type: 'array', items: { type: 'string' } },
	},
}
const FIX_SCHEMA = {
	type: 'object',
	required: ['status', 'changed_files'],
	properties: {
		...NEEDS_HUMAN_PROPS,
		changed_files: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
		wont_fix: { type: 'array', items: { type: 'string' }, description: '根拠付き据え置き（レビュー修正時のみ）' },
	},
}
const ANSWER_CHECK_SCHEMA = {
	type: 'object',
	required: ['accepted'],
	properties: { accepted: { type: 'boolean' }, answer_summary: { type: 'string' } },
}

// ── ヘルパー ──
const stop = (phase, items, extra = {}) => ({ status: 'NEEDS_HUMAN', phase, items, runId: A.runId, ...extra })
const answersHint = `過去のエスカレーション回答が ${ANSWERS} にあれば全行読み、answer が埋まっている項目は確定済みの前提として従うこと。`
const autonomyHeader = `【自走モード】この実行は autonomous-dev パイプライン内。あなたは人間と対話できない。playbook やスキルの「ユーザーと合意」「承認待ち」は実行しない。判断に詰まらない限り DONE まで自走し、曖昧（解釈が割れる）/不可逆（本番・データ・公開APIに影響）/主観（価値判断）に当たったら質問せず status:"NEEDS_HUMAN"（reason/category/options 付き）を返して即終了せよ。グレーは停止側に倒す。`
const distilledDiscipline = `入力は distilled を正本にする: 要件 ${A.requirementsPath} / 設計 ${A.designContextPath}。verbose（requirements.md / architecture.md）は distilled が指す不足箇所のみピンポイント参照。コード読解は Serena（シンボル単位）優先、全文 Read しない。`

// NEEDS_HUMAN で止まったステージだけを attempt 番号付きで再実行するラッパー。
// k=0 のプロンプトは不変（完了済みならキャッシュ再生）。回答後の再開では k=1..ATTEMPT の
// 呼び出しが「回答を読んで続行せよ」という追記付きで走る（k<ATTEMPT の分もキャッシュ再生）。
async function resolveStage(call) {
	let r = await call(0)
	for (let k = 1; k <= ATTEMPT && r?.status === 'NEEDS_HUMAN'; k++) r = await call(k)
	return r
}
const attemptTag = (k) => (k > 0 ? `\n【再開 attempt=${k}】前回この作業は NEEDS_HUMAN で停止した。${answersHint} 回答を前提に続行せよ。` : '')

// ═══════════════════ Phase: Implement ═══════════════════
phase('Implement')

const cursorInstructions = `実装バックエンド: Cursor headless 委譲（既定）。手順:
1. \`export PATH="$HOME/.local/bin:$PATH"\` の上で \`cursor agent status\` を確認。ログイン不可/エラーなら内蔵実装（後述）へフォールバック。
2. 受け渡しプロンプトを組み立てる（要件 AC・スコープ・触ってはいけない核・下記の必須品質ゲートを含める。distilled の要点を貼る。verbose は貼らない）:
   - 必須品質ゲート: 実装を一区切りしたら /extract-testable-module を実行（責務自己評価→最小侵襲の切り出し→単体テスト green。分割しないのが妥当ならその理由を1行）。/tautology-test-detector を実行し無意味テストを作らない/除く。
   - 完了報告: 型/lint/テストの結果・変更ファイル一覧・切り出し判断の理由。
3. 起動: \`cd ${A.repoRoot} && nohup cursor agent -p --trust --force -w ${A.runId} --model ${CURSOR_MODEL} --output-format text "<プロンプト>" > ${A.runDir}/stage-impl/cursor.log 2>&1 &\`
   その後 \`until\` ループ（1回の Bash 呼び出しは9分以内に区切る）でプロセス終了まで待ち、ログを確認する。
4. 回収: worktree \`~/.cursor/worktrees/$(basename ${A.repoRoot})/${A.runId}\` の差分（tracked は git diff、untracked は status --porcelain で列挙してコピー）を ${A.repoRoot} の作業ツリーへ適用する。
5. Cursor の自己申告（green 等）は鵜呑みにしない（検証は後段ゲートが実施）。
フォールバック（Cursor 不可時 or backend=agent 指定時）: あなた自身が実装する。`
const selfImplInstructions = `実装バックエンド: 内蔵実装。あなた自身が設計に厳密に従って実装とユニットテストを書く。`

const implResult = await resolveStage((k) =>
	agentM(
		`${autonomyHeader}
${distilledDiscipline}
${answersHint}${attemptTag(k)}

■ タスク: 承認済み要件・設計に従い、対象リポジトリ（${A.repoRoot}、ブランチ ${A.branch || '現行'}）に実装とユニットテストを完成させる。
mkdir -p ${A.runDir}/stage-impl を最初に実行すること。

${BACKEND === 'cursor' ? cursorInstructions : selfImplInstructions}

■ 実装規律（バックエンドがどちらでも、最終コードに対してあなたが検証する）:
1. 再利用境界の検証: 実装が「既存を再利用/同形だから流用/相乗り/差し替え」の境界を引いた箇所は、~/.claude/skills/verify-reuse-boundary/SKILL.md の規律で一次情報検証（型→Serena、外部API→Context7）し事実/推論をラベル。非同一なら分岐。自明な再利用には適用しない。
2. 責務の自己評価: ~/.claude/skills/extract-testable-module/SKILL.md の規律で、書かれた全コードの責務を自己点検。厚い関数/関心混在は最小侵襲（Sprout優先）で純粋ロジックを切り出しテストを書く。妥当なら切り出さず通過可（過剰分割しない）。
3. 無意味テストの排除: 実装の言い換え・mock だけ検証するテストを作らない/除く（tautology-test-detector の5類型）。
4. load-bearing/不可逆な決定は該当コード直近に短い why コメント（不変条件＋一行理由）を残す。却下案・詳細 rationale はコードに書かない。
5. 型チェックとユニットテストを実行し green を確認してから返す。

■ NEEDS_HUMAN 条件: 設計に無い振る舞いの選択 / 既存APIが設計前提と食い違う / DBスキーマ・protobuf・公開APIの変更が要る / as any・@ts-ignore 無しに通らない / テストを通すのに要件解釈を緩める必要 / 切り出しが最小侵襲で収まらない。

■ 成果物（DONE 時に必ず全部）:
- ${A.runDir}/stage-impl/result.json（scratch: changed_files・切り出し判断・テスト結果・Cursor session 情報）
- ${A.featureDir}/implementation/context.json（distilled: decisions{rationale,alternatives_rejected} / address_items / pr_readiness / test_results。共有契約 ~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md 3.4 準拠）
- \`bash ${SCRIPTS}/bucket.sh phase ${A.featureDir} ${A.runDir} implement completed implementation/context.json\` を実行
- 構造化出力で changed_files（repo ルート相対）を返す`,
		{ label: `implement:${BACKEND}`, phase: 'Implement', schema: IMPL_SCHEMA },
	),
)
if (!implResult) return stop('implement', [{ reason: '実装エージェントが結果を返さず終了', category: 'ambiguous', options: [] }])
if (implResult.status === 'NEEDS_HUMAN') return stop('implement', [implResult.needs_human])

let changedFiles = [...new Set(implResult.changed_files || [])]
if (!changedFiles.length) return stop('implement', [{ reason: '実装が changed_files を報告しなかった', category: 'ambiguous', options: ['再実行', '手動確認'] }])
log(`Implement 完了 (${implResult.backend_used || BACKEND}): ${changedFiles.length} files`)

// ═══════════════════ Phase: Gate（客観ゲートループ・コード化された安全装置） ═══════════════════
phase('Gate')

const runGate = (files, tag) =>
	agentM(
		`次のコマンドを cd ${A.repoRoot} で正確に実行し、標準出力の最終行の JSON をそのまま構造化出力で返せ（解釈・要約しない）:
bash ${SCRIPTS}/gate.sh all --files ${files.join(' ')}
続けて、その JSON の gates 部分を state.json へ記録せよ:
bash ${SCRIPTS}/bucket.sh write ${A.runDir} gates '<gates オブジェクトの JSON>'`,
		{ label: `gate:${tag}`, phase: 'Gate', schema: GATE_SCHEMA, effort: 'low' },
	)

// 変更ファイル外の既存 typecheck エラーをマスクする（例: server-core の既存 TS2532。
// 直せない他人のエラーで修正ループに入るのを防ぐ。テスト赤・check 赤はマスクしない）
const TS_SIG = /^(.+?)\((\d+),(\d+)\): error TS/
function splitSigs(sigs, files) {
	const inScope = []
	const masked = []
	for (const s of sigs || []) {
		const m = TS_SIG.exec(s)
		if (!m) {
			if (!/ERR_PNPM_RECURSIVE_EXEC/.test(s)) inScope.push(s) // pnpm ラッパー行はノイズ
			continue
		}
		const sigFile = m[1].trim()
		files.some((f) => f.endsWith(sigFile) || sigFile.endsWith(f)) ? inScope.push(s) : masked.push(s)
	}
	return { inScope, masked }
}
function effective(gateJson, files) {
	const { inScope, masked } = splitSigs(gateJson.error_signatures, files)
	const gates = gateJson.gates || {}
	const redGates = Object.entries(gates).filter(([, g]) => g && g.green === false)
	// typecheck 赤のうち、in-scope な TS シグネチャが1つも無いものは既存エラーとしてマスク
	const unmaskedRed = redGates.filter(([name]) => {
		if (!name.startsWith('typecheck:')) return true
		return inScope.some((s) => TS_SIG.test(s))
	})
	return { green: unmaskedRed.length === 0, inScope, masked, redGateNames: unmaskedRed.map(([n]) => n) }
}

const warnings = []
let gateRaw = await runGate(changedFiles, 'round0')
if (!gateRaw) return stop('gate', [{ reason: 'ゲート実行エージェントが結果を返さなかった', category: 'ambiguous', options: [] }])
let eff = effective(gateRaw, changedFiles)
if (eff.masked.length) warnings.push(`既存エラーをマスク（変更ファイル外・要別対応）: ${eff.masked.slice(0, 5).join(' / ')}${eff.masked.length > 5 ? ` 他${eff.masked.length - 5}件` : ''}`)

let prevSigs = null
let round = 0
while (!eff.green && round < 5) {
	round++
	// 同一エラー再発検知: 前ラウンドと in-scope シグネチャ集合が同一なら修正が効いていない
	if (prevSigs && eff.inScope.length && eff.inScope.every((s) => prevSigs.has(s)) && prevSigs.size <= eff.inScope.length) {
		return stop('gate', [{ reason: `同一エラーが再発（round ${round}）。機械修正では収束しない`, category: 'subjective', options: eff.inScope.slice(0, 4) }], { warnings })
	}
	// エラー増加検知: 前ラウンドより in-scope エラーが増えたら直前修正をロールバック候補として停止
	if (prevSigs && eff.inScope.length > prevSigs.size) {
		return stop('gate', [{ reason: `修正でエラーが増加（${prevSigs.size}→${eff.inScope.length}）。直前修正が回帰を起こした可能性`, category: 'irreversible', options: ['直前修正を revert', '手動で確認'] }], { warnings })
	}
	prevSigs = new Set(eff.inScope)

	const fixResult = await resolveStage((k) =>
		agentM(
			`${autonomyHeader}${attemptTag(k)}
■ タスク: 対象リポジトリ（${A.repoRoot}）の客観ゲート赤を機械的に修正する（round ${round}）。
赤ゲート: ${eff.redGateNames.join(', ')}
対象エラー（これだけを直す。変更ファイル外の既存エラーには触れない）:
${eff.inScope.map((s) => `- ${s}`).join('\n')}
詳細ログ: ${Object.values(gateRaw.gates || {}).filter((g) => g && g.green === false).map((g) => g.log).filter(Boolean).join(' / ')}
実装の文脈: ${A.runDir}/stage-impl/result.json と ${distilledDiscipline}
修正カテゴリ A〜D（シグネチャ不整合・不足プロパティ・型不一致・import 解決・テスト期待値が実装バグ由来）は承認不要で即修正。
■ NEEDS_HUMAN 条件: ロジック/設計判断が絡む（カテゴリE）/ as any・@ts-ignore が要る / 要件解釈を緩める必要 / テスト失敗の原因が要件の曖昧さ。
修正後、変更したファイル一覧を構造化出力 changed_files で返す（ゲート再実行はこちらでやる。あなたは対象パッケージの型チェックだけ手元確認してよい）。`,
			{ label: `gate-fix:round${round}`, phase: 'Gate', schema: FIX_SCHEMA },
		),
	)
	if (!fixResult || fixResult.status === 'NEEDS_HUMAN') {
		return stop('gate', [fixResult?.needs_human || { reason: '修正エージェント無応答', category: 'ambiguous', options: [] }], { warnings })
	}
	changedFiles = [...new Set([...changedFiles, ...(fixResult.changed_files || [])])]
	gateRaw = await runGate(changedFiles, `round${round}`)
	if (!gateRaw) return stop('gate', [{ reason: 'ゲート再実行が結果を返さなかった', category: 'ambiguous', options: [] }], { warnings })
	eff = effective(gateRaw, changedFiles)
}
if (!eff.green) return stop('gate', [{ reason: '客観ゲートループ上限（5回）到達', category: 'subjective', options: eff.inScope.slice(0, 4) }], { warnings })
log(`Gate green（fix ${round} 回${warnings.length ? '・既存エラーのマスクあり' : ''}）`)

// ═══════════════════ Phase: Review → Fix → Reverify（収束ループ） ═══════════════════

const prepReview = (tag) =>
	agentM(
		`cd ${A.repoRoot} で review-all の入力を準備し、結果を構造化出力で返せ。手順:
1. mkdir -p ${REVIEW_DIR}/${tag}
2. 未追跡の変更ファイルがあれば \`git add -N <ファイル>\`（intent-to-add）で diff に含める
3. \`git diff HEAD > ${REVIEW_DIR}/${tag}/diff.patch\` → 直後に \`git reset -q\` で intent-to-add を戻す
4. 変更ファイル一覧を ${REVIEW_DIR}/${tag}/files.txt に1行1ファイルで書く（対象: ${changedFiles.join(' ')} ＋ git status で見える追加変更）
5. diff の行数（wc -l）、テストファイルを含むか、HEAD の sha を取得
返却: {diffPath, filesPath, totalDiffLines, hasTests, headSha}`,
		{
			label: `review-prep:${tag}`,
			phase: 'Review',
			effort: 'low',
			schema: {
				type: 'object',
				required: ['diffPath', 'filesPath', 'totalDiffLines', 'hasTests'],
				properties: {
					diffPath: { type: 'string' },
					filesPath: { type: 'string' },
					totalDiffLines: { type: 'number' },
					hasTests: { type: 'boolean' },
					headSha: { type: 'string' },
				},
			},
		},
	)

const recordVerdict = (synth, tag, effSnapshot) => {
	const isGo = synth.finalVerdict === 'GO' || synth.finalVerdict === 'GO_WITH_UNVERIFIED_RISKS'
	const copyCmd = isGo && synth.reportPath ? `\nmkdir -p ${A.featureDir}/reviews && cp '${synth.reportPath}' ${A.featureDir}/reviews/` : ''
	return agentM(
		`次のコマンドを順に実行し {done:true} を返せ:
bash ${SCRIPTS}/bucket.sh write ${A.runDir} review '${JSON.stringify({ verdict: isGo ? 'GO' : 'NO-GO', finalVerdict: synth.finalVerdict, critical: synth.totals?.critical ?? null, major: synth.totals?.major ?? null, reportPath: synth.reportPath || '', round: tag })}'
bash ${SCRIPTS}/bucket.sh write ${A.runDir} gates_effective '${JSON.stringify({ green: true, masked: effSnapshot?.masked?.length ?? 0, note: 'マスク後の実効判定。生の結果は .gates' })}'
bash ${SCRIPTS}/bucket.sh phase ${A.featureDir} ${A.runDir} review ${isGo ? 'completed' : 'in_progress'}${copyCmd}`,
		{ label: `review-record:${tag}`, phase: 'Review', effort: 'low', schema: { type: 'object', properties: { done: { type: 'boolean' } } } },
	)
}

let reviewRound = 0
let synth = null
while (true) {
	reviewRound++
	const tag = `round${reviewRound}`
	phase('Review')
	const prep = await prepReview(tag)
	if (!prep) return stop('review', [{ reason: 'レビュー入力の準備に失敗', category: 'ambiguous', options: [] }], { warnings })

	synth = await workflow('review-all', {
		...(A.model ? { model: A.model } : {}),
		diffPath: prep.diffPath,
		filesPath: prep.filesPath,
		outDir: `${REVIEW_DIR}/${tag}`,
		repoRoot: A.repoRoot,
		ts: `${A.ts}-r${reviewRound}`,
		target: { kind: 'worktree', ref: A.branch || 'worktree' },
		baseSha: prep.headSha,
		headSha: prep.headSha,
		totalDiffLines: prep.totalDiffLines,
		hasTests: prep.hasTests,
		spec: {
			found: true,
			requirementsPath: A.requirementsPath,
			contextPath: A.designContextPath,
			manifestPath: `${A.featureDir}/manifest.json`,
		},
	})
	if (!synth) return stop('review', [{ reason: 'review-all 子 Workflow が結果を返さなかった', category: 'ambiguous', options: [] }], { warnings })
	await recordVerdict(synth, tag, eff)
	log(`Review ${tag}: ${synth.finalVerdict} (Critical=${synth.totals?.critical} Major=${synth.totals?.major})`)

	if (synth.finalVerdict === 'GO') break

	if (synth.finalVerdict === 'GO_WITH_UNVERIFIED_RISKS') {
		// 未確認リスク受容は主観判断＝閣下に確認。回答済みなら受容/差し戻しを answers から読む
		const check = await resolveStage((k) =>
			k === 0
				? Promise.resolve({ accepted: false, answer_summary: '' })
				: agentM(
						`${ANSWERS} を読み、「未確認リスクの受容」に関する最新の回答（answer が非 null の行）を探せ。回答が「受容/accept/GO で進める」趣旨なら accepted:true、「差し戻し/検証する」趣旨なら accepted:false を返せ。該当回答が無ければ accepted:false。attempt=${k}`,
						{ label: `risk-accept-check:${tag}:a${k}`, phase: 'Review', effort: 'low', schema: ANSWER_CHECK_SCHEMA },
					),
		)
		// resolveStage は status フィールドを見るため、accepted ベースで自前判定する
		if (check?.accepted) {
			warnings.push(`未確認リスクを閣下が受容して GO 扱い: ${check.answer_summary || '(回答参照)'}`)
			break
		}
		return stop(
			'review',
			(synth.highRiskUnverified || []).map((r) => ({
				reason: `未確認リスク: ${r.risk}（${r.path} / ${r.reviewer}）`,
				category: 'subjective',
				options: ['受容して進める', '検証を指示する'],
			})),
			{ warnings, reportPath: synth.reportPath, finalVerdict: synth.finalVerdict },
		)
	}

	if (synth.finalVerdict === 'REVIEW_INCOMPLETE') {
		return stop('review', [{ reason: `レビューが完了しなかった（completeness=${synth.reviewCompleteness}）`, category: 'ambiguous', options: ['再実行', 'レポート確認'] }], { warnings, reportPath: synth.reportPath })
	}

	// NO_GO → Fix
	if (reviewRound >= 3) {
		return stop('review', [{ reason: '収束ループ上限（3回）到達。Critical/Major が解消しない', category: 'subjective', options: (synth.blockers || []).slice(0, 4).map((b) => `${b.severity}: ${b.title}`) }], { warnings, reportPath: synth.reportPath })
	}
	phase('Fix')
	const reviewFix = await resolveStage((k) =>
		agentM(
			`${autonomyHeader}
${distilledDiscipline}${attemptTag(k)}
■ タスク: review-all の Critical/Major findings を解消する（round ${reviewRound}）。
- 統合レポート: ${synth.reportPath} を Read（blockers: ${JSON.stringify((synth.blockers || []).slice(0, 10))}）
- 観点別の所見ファイル: ${REVIEW_DIR}/${tag}/ 配下を必要な分だけ Read
- 設計に明記された範囲・機械的に正しい修正は承認不要で進める。won't-fix は根拠を wont_fix に残す。
- 修正で公開APIやDBスキーマに触れる必要が出たら NEEDS_HUMAN（irreversible）。
- レビューが割れている/指摘の妥当性が疑わしい場合は NEEDS_HUMAN（subjective、論点を options に）。
- 修正後、対象パッケージの型チェック・テストを手元確認してから changed_files を返す。`,
			{ label: `review-fix:${tag}`, phase: 'Fix', schema: FIX_SCHEMA },
		),
	)
	if (!reviewFix || reviewFix.status === 'NEEDS_HUMAN') {
		return stop('fix', [reviewFix?.needs_human || { reason: '修正エージェント無応答', category: 'ambiguous', options: [] }], { warnings, reportPath: synth.reportPath })
	}
	changedFiles = [...new Set([...changedFiles, ...(reviewFix.changed_files || [])])]

	// Reverify: ゲート再実行（回帰検知: 一度緑になったゲートが赤に戻ったら停止）
	phase('Reverify')
	gateRaw = await runGate(changedFiles, `reverify-r${reviewRound}`)
	if (!gateRaw) return stop('reverify', [{ reason: 'ゲート再実行が結果を返さなかった', category: 'ambiguous', options: [] }], { warnings })
	eff = effective(gateRaw, changedFiles)
	if (!eff.green) {
		return stop('reverify', [{ reason: `レビュー修正が客観ゲートの回帰を起こした（${eff.redGateNames.join(', ')}）。直前修正を revert 候補として確認`, category: 'irreversible', options: ['revert して再修正', 'このまま手動確認'] }], { warnings })
	}
	// ループ先頭に戻り review-all をフル再実行（部分再レビュー禁止・GO まで）
}

// ═══════════════════ 完了監査 ═══════════════════
const audit = await agentM(
	`完了監査（audit v2）。次のコマンドを実行し、最終行の JSON を構造化出力でそのまま返せ:
bash ${SCRIPTS}/audit.sh ${A.featureDir} ${A.runDir}`,
	{
		label: 'audit',
		phase: 'Reverify',
		effort: 'low',
		schema: {
			type: 'object',
			required: ['audit'],
			properties: { audit: { type: 'string', enum: ['pass', 'fail'] }, checks: { type: 'object', additionalProperties: true }, missing: { type: 'array', items: { type: 'string' } } },
		},
	},
)
log(`完了監査: ${audit?.audit}${audit?.missing?.length ? ` (missing: ${audit.missing.join(', ')})` : ''}`)

return {
	status: audit?.audit === 'pass' ? 'GO' : 'GO_WITH_AUDIT_GAPS',
	changed_files: changedFiles,
	reportPath: synth?.reportPath || null,
	finalVerdict: synth?.finalVerdict || null,
	gateFixRounds: round,
	reviewRounds: reviewRound,
	warnings,
	audit: audit || null,
	runId: A.runId,
}
