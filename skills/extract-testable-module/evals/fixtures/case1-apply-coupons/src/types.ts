export interface Order {
	id: string
	totalAmount: number
	discountAmount: number
	appliedCouponIds: string[]
}

export interface Coupon {
	id: string
	expiresAt: number
	minAmount: number
	discountAmount: number
	combinable: boolean
}
