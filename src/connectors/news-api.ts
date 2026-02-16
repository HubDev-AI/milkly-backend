/**
 * News API Connector
 *
 * Fetches news articles from newsapi.org
 * Documentation: https://newsapi.org/docs
 */

import { env } from "../env";
import {
  NEWS_API_CONFIG,
  type NewsApiConfig,
  type SortOption,
} from "../config";
import {
  BaseConnector,
  type FetchOptions,
  type FetchResult,
  type FetchedContentItem,
} from "./types";

// ============ API Types ============

interface NewsAPIArticle {
  title: string;
  url: string;
  description: string | null;
  urlToImage: string | null;
  source: { name: string };
  author: string | null;
  publishedAt: string;
}

interface NewsAPIResponse {
  status: string;
  totalResults: number;
  articles: NewsAPIArticle[];
  code?: string;
  message?: string;
}

// ============ Connector Implementation ============

export class NewsApiConnector extends BaseConnector {
  readonly id = NEWS_API_CONFIG.id;
  readonly name = NEWS_API_CONFIG.name;
  readonly category = NEWS_API_CONFIG.category;

  private config: NewsApiConfig = NEWS_API_CONFIG;

  getConfig(): NewsApiConfig {
    return this.config;
  }

  isConfigured(): boolean {
    return Boolean(env.NEWS_API_KEY);
  }

  async fetch(options: FetchOptions): Promise<FetchResult> {
    if (!this.isConfigured()) {
      this.logInfo("API key not configured, skipping fetch");
      return this.emptyResult("NEWS_API_KEY not configured");
    }

    try {
      const query = this.buildQueryString(
        options.keywords,
        options.fallbackQuery,
      );
      const url = this.buildUrl(query, options);
      const debugUrl = new URL(url.toString());
      debugUrl.searchParams.set("apiKey", "***");
      this.logInfo(`GET ${debugUrl.toString()}`);

      const response = await fetch(url.toString());

      if (!response.ok) {
        const errorText = await response.text();
        this.logError("API request", `${response.status} ${errorText}`);
        return this.emptyResult(`API error: ${response.status}`);
      }

      const data = (await response.json()) as NewsAPIResponse;

      if (data.status !== "ok" || !data.articles) {
        this.logError("Invalid response", data.message ?? "Unknown error");
        return this.emptyResult(data.message ?? "Invalid API response");
      }

      const items = this.transformArticles(data.articles);
      this.logInfo(
        `Fetched ${items.length} items (total: ${data.totalResults})`,
      );

      return this.successResult(items, data.totalResults);
    } catch (error) {
      this.logError("fetch", error);
      return this.emptyResult(
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  // ============ Private Methods ============

  /**
   * Build News API query string from keywords.
   * News API supports OR operator for multiple terms.
   * @see https://newsapi.org/docs/endpoints/everything
   */
  private buildQueryString(keywords: string[], fallbackQuery?: string): string {
    if (keywords.length === 0) {
      return fallbackQuery ?? "";
    }
    // News API uses OR between terms for broader matching
    // Wrap multi-word phrases in quotes
    const terms = keywords.map((k) => (k.includes(" ") ? `"${k}"` : k));
    return terms.join(" OR ");
  }

  private buildUrl(query: string, options: FetchOptions): URL {
    const { api } = this.config;
    const url = new URL(`${api.baseUrl}${api.endpoints.everything}`);

    // Required params
    url.searchParams.set("q", query);
    url.searchParams.set("apiKey", env.NEWS_API_KEY!);

    // Page size
    const pageSize = options.count ?? this.config.defaults.pageSize;
    url.searchParams.set("pageSize", String(pageSize));

    // Sort order
    const sortBy = options.sortBy ?? this.config.defaults.sortBy;
    const apiSortBy = api.params.sortByMapping[sortBy];
    url.searchParams.set("sortBy", apiSortBy);

    // Language
    url.searchParams.set("language", api.params.language);

    // Date filter - use 7 days ago minimum to ensure results
    // The "since last fetch" filter is too narrow for news discovery
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fromDate =
      options.since && options.since < sevenDaysAgo
        ? options.since
        : sevenDaysAgo;
    url.searchParams.set("from", fromDate.toISOString().slice(0, 10)); // Use date only, not time

    return url;
  }

  private transformArticles(articles: NewsAPIArticle[]): FetchedContentItem[] {
    return articles
      .filter((article) => {
        // Filter out removed articles
        if (!article.title || !article.url) return false;
        if (article.title === "[Removed]") return false;
        return true;
      })
      .map((article) => ({
        title: article.title,
        url: article.url,
        description: article.description,
        imageUrl: article.urlToImage,
        source: this.normalizeSourceName(article.source.name),
        category: this.category,
        author: article.author,
        publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
        metadata: {
          sourceName: article.source.name,
        },
      }));
  }

  private normalizeSourceName(name: string): string {
    return name.toLowerCase().replace(/\s+/g, "-");
  }
}

// ============ Singleton Export ============

export const newsApiConnector = new NewsApiConnector();
