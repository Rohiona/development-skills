import { formatYen } from './money'

describe('formatYen', () => {
	it('3桁区切りで整形する', () => {
		expect(formatYen(12345)).toBe('¥12,345')
	})
})
