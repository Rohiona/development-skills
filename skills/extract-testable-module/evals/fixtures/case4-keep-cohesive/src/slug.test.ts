import { buildSlug } from './slug'

describe('buildSlug', () => {
	it('空白をハイフンに変換して小文字化する', () => {
		expect(buildSlug('Hello World')).toBe('hello-world')
	})

	it('記号を除去し連続ハイフンを1つにする', () => {
		expect(buildSlug('  A -- B!? ')).toBe('a-b')
	})
})
