import type { DedupStore, EventQueue } from './ports'

export interface HandleResult {
	accepted: number
	skipped: number
}

export class WebhookHandler {
	constructor(
		private readonly channelSecret: string,
		private readonly queue: EventQueue,
		private readonly dedup: DedupStore,
	) {}

	async handle(headers: Record<string, string | undefined>, rawBody: string): Promise<HandleResult> {
		// TODO: x-webhook-signature 取得 → HMAC-SHA256 署名検証（不一致は拒否）→ JSON パース → eventId で重複排除 → 正規化して enqueue
		throw new Error('not implemented')
	}
}
