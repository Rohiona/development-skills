export interface RawWebhookEvent {
	webhookEventId: string
	type: string
	source: { userId: string }
	message?: { text: string }
}

export interface WebhookBody {
	events: RawWebhookEvent[]
}

export interface NormalizedEvent {
	eventId: string
	type: string
	userId: string
	text: string | null
}
