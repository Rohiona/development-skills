import type { OrderRepository } from './order.repository'
import type { Coupon, Order } from './types'

export class OrderService {
	constructor(private readonly repo: OrderRepository) {}

	async applyCoupons(orderId: string, coupons: Coupon[]): Promise<Order> {
		// TODO: 注文取得 → クーポン検証（期限/最低額/併用可否）→ 割引計算（注文額で上限クリップ）→ 注文へ反映して保存
		throw new Error('not implemented')
	}
}
