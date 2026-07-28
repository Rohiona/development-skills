export interface NotificationEnvelope {
	messageAttributes?: { channel?: { stringValue?: string } }
	body?: { channel?: string }
}

export interface Route {
	queue: string
}
