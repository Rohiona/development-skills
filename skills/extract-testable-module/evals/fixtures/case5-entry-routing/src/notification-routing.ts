import { AppError, AppErrorCodes } from './app-error'
import type { NotificationEnvelope, Route } from './types'

export function resolveNotificationRoute(envelope: NotificationEnvelope): Route {
	const channel = envelope.messageAttributes?.channel?.stringValue ?? envelope.body?.channel ?? 'email'
	switch (channel) {
		case 'email':
			return { queue: 'email-dispatch' }
		case 'push':
			return { queue: 'push-dispatch' }
		case 'sms':
			return { queue: 'sms-dispatch' }
		default:
			throw new AppError(AppErrorCodes.InvalidArgument, `未知の channel: ${channel}`)
	}
}
