/**
 * YouTube Connector
 *
 * Fetches videos from YouTube Data API v3
 * Documentation: https://developers.google.com/youtube/v3
 */

import { env } from "../env";
import { YOUTUBE_CONFIG, type YouTubeConfig, type SortOption } from "../config";
import {
  BaseConnector,
  type FetchOptions,
  type FetchResult,
  type FetchedContentItem,
} from "./types";

// ============ API Types ============

interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    title: string;
    description: string;
    thumbnails: {
      high?: { url: string };
      medium?: { url: string };
      default?: { url: string };
    };
    channelTitle: string;
    publishedAt: string;
  };
}

interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];
  pageInfo?: {
    totalResults: number;
    resultsPerPage: number;
  };
  nextPageToken?: string;
  error?: {
    code: number;
    message: string;
  };
}

// ============ Connector Implementation ============

export class YouTubeConnector extends BaseConnector {
  readonly id = YOUTUBE_CONFIG.id;
  readonly name = YOUTUBE_CONFIG.name;
  readonly category = YOUTUBE_CONFIG.category;

  private config: YouTubeConfig = YOUTUBE_CONFIG;

  getConfig(): YouTubeConfig {
    return this.config;
  }

  isConfigured(): boolean {
    return Boolean(env.YOUTUBE_API_KEY);
  }

  async fetch(options: FetchOptions): Promise<FetchResult> {
    if (!this.isConfigured()) {
      this.logInfo("API key not configured, skipping fetch");
      return this.emptyResult("YOUTUBE_API_KEY not configured");
    }

    try {
      const query = this.buildQueryString(
        options.keywords,
        options.fallbackQuery,
      );
      const url = this.buildUrl(query, options);
      const debugUrl = new URL(url.toString());
      debugUrl.searchParams.set("key", "***");
      this.logInfo(`GET ${debugUrl.toString()}`);

      const response = await fetch(url.toString());

      if (!response.ok) {
        const errorText = await response.text();
        this.logError("API request", `${response.status} ${errorText}`);
        return this.emptyResult(`API error: ${response.status}`);
      }

      const data = (await response.json()) as YouTubeSearchResponse;

      if (data.error) {
        this.logError("API error", data.error.message);
        return this.emptyResult(data.error.message);
      }

      if (!data.items) {
        this.logError("Invalid response", "No items in response");
        return this.emptyResult("Invalid API response");
      }

      const items = this.transformVideos(data.items);
      const totalResults = data.pageInfo?.totalResults ?? items.length;
      this.logInfo(`Fetched ${items.length} items (total: ${totalResults})`);

      return {
        items,
        totalResults,
        hasMore: Boolean(data.nextPageToken),
      };
    } catch (error) {
      this.logError("fetch", error);
      return this.emptyResult(
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  // ============ Private Methods ============

  /**
   * Build YouTube query string from keywords.
   * YouTube uses pipe (|) for OR operator in search queries.
   * @see https://developers.google.com/youtube/v3/docs/search/list
   */
  private buildQueryString(keywords: string[], fallbackQuery?: string): string {
    if (keywords.length === 0) {
      return fallbackQuery ?? "";
    }
    // YouTube search uses | (pipe) for OR between terms
    // Simply join with pipe for broader matching
    return keywords.join("|");
  }

  private buildUrl(query: string, options: FetchOptions): URL {
    const { api } = this.config;
    const url = new URL(`${api.baseUrl}${api.endpoints.search}`);

    // Required params
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", query);
    url.searchParams.set("key", env.YOUTUBE_API_KEY!);
    url.searchParams.set("type", api.params.type);

    // Max results
    const maxResults = options.count ?? this.config.defaults.pageSize;
    url.searchParams.set("maxResults", String(maxResults));

    // Sort order
    const sortBy = options.sortBy ?? this.config.defaults.sortBy;
    const order = api.params.orderMapping[sortBy];
    url.searchParams.set("order", order);

    // Language
    url.searchParams.set("relevanceLanguage", api.params.relevanceLanguage);

    // Date filter - use 30 days ago minimum to ensure results
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const fromDate =
      options.since && options.since < thirtyDaysAgo
        ? options.since
        : thirtyDaysAgo;
    url.searchParams.set("publishedAfter", fromDate.toISOString());

    return url;
  }

  private transformVideos(items: YouTubeSearchItem[]): FetchedContentItem[] {
    return items
      .filter((item) => item.id.videoId && item.snippet.title)
      .map((item) => ({
        title: item.snippet.title,
        url: this.buildVideoUrl(item.id.videoId),
        description: item.snippet.description || null,
        imageUrl: this.getBestThumbnail(item.snippet.thumbnails),
        source: "youtube",
        category: this.category,
        author: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt
          ? new Date(item.snippet.publishedAt)
          : null,
        metadata: {
          videoId: item.id.videoId,
          channelTitle: item.snippet.channelTitle,
        },
      }));
  }

  private buildVideoUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  private getBestThumbnail(
    thumbnails: YouTubeSearchItem["snippet"]["thumbnails"],
  ): string | null {
    return (
      thumbnails.high?.url ||
      thumbnails.medium?.url ||
      thumbnails.default?.url ||
      null
    );
  }
}

// ============ Singleton Export ============

export const youtubeConnector = new YouTubeConnector();
