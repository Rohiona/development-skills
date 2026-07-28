export interface SubscriptionResult {
	status: 'ok' | 'error'
	subscriptionId?: string
	errorCode?: string
}

export class BillingHttpClient {
	constructor(private readonly token: string) {}

	async createSubscription(userId: string, tier: string, months: number): Promise<SubscriptionResult> {
		// 実際は外部課金 API を叩く（fixture ではネットワーク未接続）
		throw new Error('network unavailable in fixture')
	}
}
