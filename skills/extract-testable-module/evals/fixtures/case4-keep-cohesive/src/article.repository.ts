import type { Article } from './types'

export interface ArticleRepository {
	findById(id: string): Promise<Article>
	update(article: Article): Promise<Article>
	list(): Promise<Article[]>
}
