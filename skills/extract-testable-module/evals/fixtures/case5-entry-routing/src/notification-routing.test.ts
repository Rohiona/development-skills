import { resolveNotificationRoute } from './notification-routing'

describe('resolveNotificationRoute', () => {
	it('messageAttributes の channel を優先して振り分ける', () => {
		const envelope = { messageAttributes: { channel: { stringValue: 'push' } }, body: { channel: 'email' } }
		expect(resolveNotificationRoute(envelope)).toEqual({ queue: 'push-dispatch' })
	})

	it('channel が無ければ email に振り分ける', () => {
		expect(resolveNotificationRoute({})).toEqual({ queue: 'email-dispatch' })
	})
})
