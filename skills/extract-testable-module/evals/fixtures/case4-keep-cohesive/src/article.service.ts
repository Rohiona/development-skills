import type { ArticleRepository } from './article.repository'
import { buildSlug } from './slug'
import type { Article, ArticleSummary } from './types'

export class ArticleService {
	constructor(private readonly repo: ArticleRepository) {}

	async renameArticle(id: string, title: string): Promise<Article> {
		const article = await this.repo.findById(id)
		const updated: Article = { ...article, title: title.trim(), slug: buildSlug(title) }
		return this.repo.update(updated)
	}

	async listSummaries(): Promise<ArticleSummary[]> {
		const articles = await this.repo.list()
		return articles.map((a) => this.toSummary(a))
	}

	private toSummary(article: Article): ArticleSummary {
		return { id: article.id, title: article.title }
	}
}
