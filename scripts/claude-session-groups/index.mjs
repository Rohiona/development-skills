#!/usr/bin/env node

import { execSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClassicLevel } from 'classic-level'

const DEFAULT_DB_DIR = join(homedir(), 'Library/Application Support/Claude/Local Storage/leveldb')
const BACKUP_DIR = join(homedir(), '.claude/backups/claude-session-groups')
const SESSIONS_BASE = join(homedir(), 'Library/Application Support/Claude/claude-code-sessions')
const STORAGE_KEY_PREFIX = '_https://claude.ai'
const GROUP_FIELDS = [
	'customGroups',
	'customGroupAssignments',
	'customGroupOrder',
	'groupByByMode',
	'collapsedGroups',
	'pinnedOrder',
]

/**
 * localStorage キーを Buffer 形式で生成する
 */
function makeStorageKey(keyName) {
	return Buffer.concat([Buffer.from(STORAGE_KEY_PREFIX, 'utf8'), Buffer.from([0x00, 0x01]), Buffer.from(keyName, 'latin1')])
}

/**
 * LevelDB 値バッファをデコードする
 */
function decodeValue(buf) {
	if (!buf || buf.length === 0) {
		return ''
	}
	const type = buf[0]
	const body = buf.subarray(1)
	if (type === 0x01) {
		return body.toString('latin1')
	}
	if (type === 0x00) {
		return body.toString('utf16le')
	}
	return body.toString('utf8')
}

/**
 * 文字列を LevelDB 値バッファへエンコードする
 */
function encodeValue(str) {
	const allLatin1 = [...str].every((ch) => ch.codePointAt(0) <= 0xff)
	if (allLatin1) {
		return Buffer.concat([Buffer.from([0x01]), Buffer.from(str, 'latin1')])
	}
	return Buffer.concat([Buffer.from([0x00]), Buffer.from(str, 'utf16le')])
}

/**
 * ~ をホームディレクトリへ展開する
 */
function expandPath(p) {
	if (p.startsWith('~/')) {
		return join(homedir(), p.slice(2))
	}
	if (p === '~') {
		return homedir()
	}
	return p
}

/**
 * LevelDB を一時ディレクトリへコピーする（LOCK 削除済み）
 */
function copyDbToTemp(dbDir) {
	const tempDir = mkdtempSync(join(tmpdir(), 'csg-leveldb-'))
	cpSync(dbDir, tempDir, { recursive: true })
	const lockFile = join(tempDir, 'LOCK')
	if (existsSync(lockFile)) {
		unlinkSync(lockFile)
	}
	return tempDir
}

/**
 * classic-level で DB を開く
 */
async function openDb(dbPath) {
	return new ClassicLevel(dbPath, {
		keyEncoding: 'buffer',
		valueEncoding: 'buffer',
	})
}

/**
 * DB から指定キーの文字列値を取得する（無ければ null）
 */
async function dbGet(db, keyName) {
	try {
		const value = await db.get(makeStorageKey(keyName))
		return decodeValue(value)
	} catch (err) {
		if (err.notFound) {
			return null
		}
		throw err
	}
}

/**
 * コピー読み取りで dframe-store / slice を取得する
 */
async function readDbData(dbDir) {
	const tempDir = copyDbToTemp(dbDir)
	let db
	try {
		db = await openDb(tempDir)
		const dframeRaw = await dbGet(db, 'dframe-store')
		const sliceRaw = await dbGet(db, 'LSS-persisted.dframe-local-slice')
		return {
			dframeStore: dframeRaw ? JSON.parse(dframeRaw) : null,
			slice: sliceRaw ? JSON.parse(sliceRaw) : null,
		}
	} finally {
		if (db) {
			await db.close()
		}
		rmSync(tempDir, { recursive: true, force: true })
	}
}

/**
 * state からグループ関連フィールドを抽出する
 */
function extractGroupFields(state) {
	const fields = {}
	for (const key of GROUP_FIELDS) {
		fields[key] = state?.[key] ?? (key === 'customGroups' || key === 'pinnedOrder' ? [] : key === 'collapsedGroups' ? [] : {})
	}
	return fields
}

/**
 * グループのセッション数を数える
 */
function countSessionsForGroup(groupId, customGroupOrder, customGroupAssignments) {
	if (customGroupOrder?.[groupId]) {
		return customGroupOrder[groupId].length
	}
	return Object.values(customGroupAssignments ?? {}).filter((gid) => gid === groupId).length
}

/**
 * 定義のないグループへの割り当て件数を数える
 */
function countOrphanAssignments(customGroups, assignments) {
	const definedIds = new Set((customGroups ?? []).map((g) => g.id))
	let count = 0
	for (const gid of Object.values(assignments ?? {})) {
		if (!definedIds.has(gid)) {
			count++
		}
	}
	return count
}

/**
 * グループ関連フィールドのサマリを表示する
 */
function printGroupSummary(groupFields) {
	const groups = groupFields.customGroups ?? []
	const assignments = groupFields.customGroupAssignments ?? {}
	console.log(`グループ ${groups.length} / 割り当て ${Object.keys(assignments).length}`)
	for (const g of groups) {
		const n = countSessionsForGroup(g.id, groupFields.customGroupOrder, groupFields.customGroupAssignments)
		console.log(`${g.name} (${g.id}): ${n} セッション`)
	}
	const orphans = countOrphanAssignments(groups, assignments)
	if (orphans > 0) {
		console.log(`(定義のないグループへの割り当て: ${orphans} 件)`)
	}
}

/**
 * セッションレジストリを走査してタイトル対応を作る
 */
function collectSessionTitles(assignments) {
	const titles = {}
	const needed = new Set()
	for (const key of Object.keys(assignments ?? {})) {
		const match = key.match(/(local_[a-f0-9-]+)/i)
		if (match) {
			needed.add(match[1])
		}
	}
	if (needed.size === 0 || !existsSync(SESSIONS_BASE)) {
		return titles
	}

	let accts
	try {
		accts = readdirSync(SESSIONS_BASE, { withFileTypes: true })
	} catch {
		return titles
	}

	for (const acct of accts) {
		if (!acct.isDirectory()) {
			continue
		}
		const acctPath = join(SESSIONS_BASE, acct.name)
		let orgs
		try {
			orgs = readdirSync(acctPath, { withFileTypes: true })
		} catch {
			continue
		}
		for (const org of orgs) {
			if (!org.isDirectory()) {
				continue
			}
			const orgPath = join(acctPath, org.name)
			let files
			try {
				files = readdirSync(orgPath)
			} catch {
				continue
			}
			for (const file of files) {
				if (!file.startsWith('local_') || !file.endsWith('.json')) {
					continue
				}
				const uuid = file.replace(/\.json$/, '')
				if (!needed.has(uuid)) {
					continue
				}
				try {
					const data = JSON.parse(readFileSync(join(orgPath, file), 'utf8'))
					titles[uuid] = data.title ?? data.cwd ?? uuid
				} catch {
					// 壊れたファイルはスキップ
				}
			}
		}
	}
	return titles
}

/**
 * バックアップファイル名用のタイムスタンプを生成する
 */
function formatBackupTimestamp(date) {
	const y = date.getFullYear()
	const m = String(date.getMonth() + 1).padStart(2, '0')
	const d = String(date.getDate()).padStart(2, '0')
	const h = String(date.getHours()).padStart(2, '0')
	const min = String(date.getMinutes()).padStart(2, '0')
	const s = String(date.getSeconds()).padStart(2, '0')
	return `${y}${m}${d}-${h}${min}${s}`
}

/**
 * 古いバックアップ履歴を削除する（直近30件を残す）
 */
function pruneOldBackups(backupDir) {
	let files
	try {
		files = readdirSync(backupDir)
			.filter((f) => f.startsWith('groups-') && f.endsWith('.json'))
			.sort()
	} catch {
		return
	}
	if (files.length <= 30) {
		return
	}
	const toDelete = files.slice(0, files.length - 30)
	for (const f of toDelete) {
		try {
			unlinkSync(join(backupDir, f))
		} catch {
			// 削除失敗はスキップ
		}
	}
}

/**
 * グループ関連フィールドをマージする
 */
function mergeGroupFields(current, snapshot) {
	const currentGroups = current.customGroups ?? []
	const snapshotGroups = snapshot.customGroups ?? []
	const groupMap = new Map()

	for (const g of currentGroups) {
		groupMap.set(g.id, { ...g })
	}
	for (const g of snapshotGroups) {
		if (groupMap.has(g.id)) {
			groupMap.set(g.id, { ...groupMap.get(g.id), name: g.name })
		} else {
			groupMap.set(g.id, { ...g })
		}
	}

	const customGroupAssignments = {
		...(current.customGroupAssignments ?? {}),
		...(snapshot.customGroupAssignments ?? {}),
	}
	const customGroupOrder = {
		...(current.customGroupOrder ?? {}),
		...(snapshot.customGroupOrder ?? {}),
	}

	const groupByByMode = { ...(current.groupByByMode ?? {}) }
	for (const [mode, value] of Object.entries(snapshot.groupByByMode ?? {})) {
		if (value === 'custom') {
			groupByByMode[mode] = 'custom'
		}
	}

	let pinnedOrder = current.pinnedOrder ?? []
	const snapshotPinned = snapshot.pinnedOrder ?? []
	const currentEmpty = !pinnedOrder || pinnedOrder.length === 0
	const snapshotHasContent = snapshotPinned.length > 0
	if (currentEmpty && snapshotHasContent) {
		pinnedOrder = snapshotPinned
	}

	return {
		customGroups: [...groupMap.values()],
		customGroupAssignments,
		customGroupOrder,
		groupByByMode,
		collapsedGroups: current.collapsedGroups ?? [],
		pinnedOrder,
	}
}

/**
 * マージ結果を state に適用する
 */
function applyMergeToState(currentState, snapshot) {
	const merged = mergeGroupFields(currentState, snapshot)
	return {
		...currentState,
		...merged,
	}
}

/**
 * Claude アプリが起動中か確認する
 */
function isClaudeRunning() {
	try {
		// [.] は自己一致（この pgrep コマンド自身の文字列に反応する誤検知）の回避
		execSync('pgrep -f "Claude[.]app/Contents"', { stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

/**
 * LevelDB が実際に開けるか（ロックされていないか）を確かめる
 */
async function probeDbWritable(dbDir) {
	const db = new ClassicLevel(dbDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
	try {
		await db.open()
		await db.close()
		return null
	} catch (err) {
		try {
			await db.close()
		} catch {
			// close 失敗は無視
		}
		return err
	}
}

/**
 * 復元結果を LevelDB に書き込む
 */
async function writeRestore(dbDir, currentDframeStore, mergedState, currentSlice, mergedGroupFields) {
	const db = await openDb(dbDir)
	try {
		const newDframe = {
			...currentDframeStore,
			state: mergedState,
		}
		await db.put(makeStorageKey('dframe-store'), encodeValue(JSON.stringify(newDframe)))

		const sliceBase = currentSlice ?? { value: {}, tabId: '', timestamp: Date.now() }
		const newSlice = {
			...sliceBase,
			value: {
				...sliceBase.value,
				customGroupAssignments: mergedGroupFields.customGroupAssignments,
				customGroupOrder: mergedGroupFields.customGroupOrder,
				pinnedOrder: mergedGroupFields.pinnedOrder,
			},
			timestamp: Date.now(),
		}
		await db.put(makeStorageKey('LSS-persisted.dframe-local-slice'), encodeValue(JSON.stringify(newSlice)))
	} finally {
		await db.close()
	}
}

/**
 * CLI 引数を解析する
 */
function parseArgs(argv) {
	const args = argv.slice(2)
	const result = {
		command: null,
		json: false,
		db: null,
		file: null,
		dryRun: false,
		ifUnlocked: false,
		unknown: false,
	}

	if (args.length === 0) {
		return result
	}

	result.command = args[0]
	for (let i = 1; i < args.length; i++) {
		const arg = args[i]
		if (arg === '--json') {
			result.json = true
		} else if (arg === '--dry-run') {
			result.dryRun = true
		} else if (arg === '--if-unlocked') {
			result.ifUnlocked = true
		} else if (arg === '--db') {
			if (!args[i + 1]) {
				result.unknown = true
				break
			}
			result.db = expandPath(args[++i])
		} else if (arg === '--file') {
			if (!args[i + 1]) {
				result.unknown = true
				break
			}
			result.file = expandPath(args[++i])
		} else {
			result.unknown = true
			break
		}
	}
	return result
}

/**
 * 使い方を表示する
 */
function showUsage() {
	console.log(`使い方:
  node index.mjs show [--json] [--db <dir>]
  node index.mjs backup [--db <dir>]
  node index.mjs restore [--file <path>] [--dry-run] [--if-unlocked] [--db <dir>]
    --if-unlocked: ロック中（アプリ起動中）や控え無しのとき、エラーでなく案内だけ出して正常終了（自動実行用）`)
}

/**
 * show コマンド
 */
async function cmdShow(opts) {
	const dbDir = opts.db ?? DEFAULT_DB_DIR
	const { dframeStore } = await readDbData(dbDir)
	if (!dframeStore?.state) {
		console.log('dframe-store が見つかりません')
		return
	}

	const groupFields = extractGroupFields(dframeStore.state)
	printGroupSummary(groupFields)

	if (opts.json) {
		console.log(JSON.stringify(groupFields, null, 2))
	}
}

/**
 * backup コマンド
 */
async function cmdBackup(opts) {
	const dbDir = opts.db ?? DEFAULT_DB_DIR
	const { dframeStore } = await readDbData(dbDir)
	if (!dframeStore?.state) {
		console.log('dframe-store が見つかりません')
		process.exit(1)
	}

	const groupFields = extractGroupFields(dframeStore.state)
	const sessionTitles = collectSessionTitles(groupFields.customGroupAssignments)
	const savedAt = new Date().toISOString()
	const snapshot = {
		...groupFields,
		sessionTitles,
		savedAt,
	}

	mkdirSync(BACKUP_DIR, { recursive: true })
	const timestamp = formatBackupTimestamp(new Date())
	const historyPath = join(BACKUP_DIR, `groups-${timestamp}.json`)
	writeFileSync(historyPath, JSON.stringify(snapshot, null, 2), 'utf8')

	const groupCount = (groupFields.customGroups ?? []).length
	const assignmentCount = Object.keys(groupFields.customGroupAssignments ?? {}).length
	const latestPath = join(BACKUP_DIR, 'latest.json')
	if (groupCount > 0 || assignmentCount > 0) {
		writeFileSync(latestPath, JSON.stringify(snapshot, null, 2), 'utf8')
	} else if (!existsSync(latestPath)) {
		writeFileSync(latestPath, JSON.stringify(snapshot, null, 2), 'utf8')
	}

	pruneOldBackups(BACKUP_DIR)
	console.log(`グループ ${groupCount} / 割り当て ${assignmentCount}`)
	console.log(`保存先: ${historyPath}`)
}

/**
 * restore コマンド
 */
async function cmdRestore(opts) {
	const dbDir = opts.db ?? DEFAULT_DB_DIR
	const filePath = opts.file ?? join(BACKUP_DIR, 'latest.json')
	if (!existsSync(filePath)) {
		if (opts.ifUnlocked) {
			return
		}
		console.error('バックアップファイルが見つかりません')
		process.exit(1)
	}

	let snapshot
	try {
		snapshot = JSON.parse(readFileSync(filePath, 'utf8'))
	} catch {
		console.error('バックアップファイルの読み込みに失敗しました')
		process.exit(1)
	}

	const { dframeStore, slice } = await readDbData(dbDir)
	if (!dframeStore?.state) {
		console.error('dframe-store が見つかりません')
		process.exit(1)
	}

	const mergedState = applyMergeToState(dframeStore.state, snapshot)
	const mergedGroupFields = extractGroupFields(mergedState)

	if (opts.dryRun) {
		console.log('ドライラン: マージ結果のサマリ')
		printGroupSummary(mergedGroupFields)
		return
	}

	// 書き戻しても何も変わらないなら何もしない（自動実行時の無駄な書き込み・控えの山を防ぐ）
	const currentGroupFields = extractGroupFields(dframeStore.state)
	if (JSON.stringify(currentGroupFields) === JSON.stringify(mergedGroupFields)) {
		console.log('グループ構造は控えと一致しています（書き戻し不要）')
		return
	}

	// 判定はロック実測のみ（プロセス名検知は誤検知・検知漏れの両方があるため参考情報に格下げ）
	const probeErr = await probeDbWritable(dbDir)
	if (probeErr) {
		if (opts.ifUnlocked) {
			console.log('グループの書き戻しが必要ですが、アプリ起動中のためスキップしました。')
			console.log('→ 崩れていたら: アプリを完全終了して claude-session-sync --restore-groups')
			return
		}
		console.error(
			'保存領域がロックされていて書き込めません。Claude アプリを完全終了（Cmd+Q）し、数秒待ってから再実行してください',
		)
		if (isClaudeRunning()) {
			console.error('（参考: Claude アプリらしきプロセスがまだ動いています）')
		}
		console.error(`詳細: ${probeErr.cause?.message ?? probeErr.message}`)
		process.exit(1)
	}

	mkdirSync(BACKUP_DIR, { recursive: true })
	const backupPath = join(BACKUP_DIR, `leveldb-before-restore-${Date.now()}`)
	cpSync(dbDir, backupPath, { recursive: true })
	console.log(`復元前バックアップ: ${backupPath}`)

	await writeRestore(dbDir, dframeStore, mergedState, slice, mergedGroupFields)
	printGroupSummary(mergedGroupFields)
	console.log('次回アプリ起動時に反映されます')

	// 復元前バックアップ（leveldb 丸ごと控え）は直近10件だけ残す
	const dbBackups = readdirSync(BACKUP_DIR)
		.filter((f) => f.startsWith('leveldb-before-restore-'))
		.sort()
	for (const f of dbBackups.slice(0, Math.max(0, dbBackups.length - 10))) {
		rmSync(join(BACKUP_DIR, f), { recursive: true, force: true })
	}
}

/**
 * エントリポイント
 */
async function main() {
	const opts = parseArgs(process.argv)
	if (!opts.command) {
		showUsage()
		process.exit(0)
	}
	if (opts.unknown || !['show', 'backup', 'restore'].includes(opts.command)) {
		showUsage()
		process.exit(1)
	}

	try {
		if (opts.command === 'show') {
			await cmdShow(opts)
		} else if (opts.command === 'backup') {
			await cmdBackup(opts)
		} else if (opts.command === 'restore') {
			await cmdRestore(opts)
		}
	} catch (err) {
		console.error(`エラー: ${err.message}`)
		process.exit(1)
	}
}

main()
