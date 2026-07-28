import { truncateText } from './text'

describe('truncateText', () => {
	it('上限以下ならそのまま返す', () => {
		expect(truncateText('abc', 3)).toBe('abc')
	})

	it('上限を超えたら切り詰めて省略記号を付ける', () => {
		expect(truncateText('abcdef', 3)).toBe('abc…')
	})
})
