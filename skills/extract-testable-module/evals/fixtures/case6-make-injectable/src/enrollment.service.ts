import { AppError, AppErrorCodes } from './app-error'
import { BillingHttpClient } from './billing-http-client'

export interface Enrollment {
	userId: string
	tier: string
	months: number
	subscriptionId: string
}

export class EnrollmentService {
	async enroll(userId: string, planCode: string): Promise<Enrollment> {
		const client = new BillingHttpClient(process.env.BILLING_TOKEN ?? '')
		const parts = planCode.split('-')
		if (parts.length !== 3 || parts[0] !== 'PLAN') {
			throw new AppError(AppErrorCodes.InvalidArgument, `planCode の形式が不正です: ${planCode}`)
		}
		const tier = parts[1].toLowerCase()
		if (tier !== 'basic' && tier !== 'pro' && tier !== 'enterprise') {
			throw new AppError(AppErrorCodes.InvalidArgument, `未知の tier: ${parts[1]}`)
		}
		const months = Number(parts[2])
		if (!Number.isInteger(months) || months < 1 || months > 36) {
			throw new AppError(AppErrorCodes.InvalidArgument, `契約月数が不正です: ${parts[2]}`)
		}
		const res = await client.createSubscription(userId, tier, months)
		if (res.status === 'error' || !res.subscriptionId) {
			throw new AppError(AppErrorCodes.InvalidArgument, `課金登録に失敗しました: ${res.errorCode ?? 'unknown'}`)
		}
		return { userId, tier, months, subscriptionId: res.subscriptionId }
	}
}
