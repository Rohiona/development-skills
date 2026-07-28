import type { NormalizedEvent } from './types'

export interface EventQueue {
	enqueue(event: NormalizedEvent): Promise<void>
}

export interface DedupStore {
	seen(eventId: string): Promise<boolean>
	mark(eventId: string): Promise<void>
}
