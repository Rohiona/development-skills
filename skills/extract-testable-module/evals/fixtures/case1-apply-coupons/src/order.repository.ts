import type { Order } from './types'

export interface OrderRepository {
	findById(id: string): Promise<Order>
	save(order: Order): Promise<Order>
}
