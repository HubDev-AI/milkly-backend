/**
 * TikTok Subconnector
 *
 * Fetches videos from TikTok via hashtag search or trending feed.
 * Uses keywords as hashtags when provided, falls back to trending.
 */

import type { FetchOptions, FetchResult, FetchedContentItem } from "../types";
import type {
  SocialSubConnector,
  TikTokHashtagResponse,
  TikTokTrendingResponse,
  TikTokVideo,
} from "./types";
import { makeApiRequestWithRetry, logSubConnector } from "./base";
import { SOCIAVAULT_CONFIG } from "../../config";

class TikTokSubConnector implements SocialSubConnector {
  readonly platform = "tiktok";
  readonly platformName = "TikTok";

  async fetch(
    options: FetchOptions,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    const config = SOCIAVAULT_CONFIG.api.platforms.tiktok;

    // Use keywords as hashtags if provided, otherwise fetch trending
    if (options.keywords.length > 0) {
      return this.fetchByHashtags(options.keywords, config, apiKey, baseUrl);
    } else {
      return this.fetchTrending(config, apiKey, baseUrl);
    }
  }

  private async fetchByHashtags(
    keywords: string[],
    config: typeof SOCIAVAULT_CONFIG.api.platforms.tiktok,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    // Use first 3 keywords as hashtags
    const hashtags = keywords
      .slice(0, 3)
      .map((k) => k.toLowerCase().replace(/[#\s]/g, ""));

    logSubConnector(
      this.platform,
      `Fetching hashtags: #${hashtags.join(", #")}`,
    );

    // Fetch from all hashtags in parallel
    const results = await Promise.all(
      hashtags.map((hashtag) =>
        this.fetchHashtag(hashtag, config, apiKey, baseUrl),
      ),
    );

    // Aggregate all videos
    let allItems: FetchedContentItem[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.error) {
        errors.push(result.error);
      }
      allItems.push(...result.items);
    }

    // Sort by date
    allItems.sort((a, b) => {
      const dateA = a.publishedAt?.getTime() ?? 0;
      const dateB = b.publishedAt?.getTime() ?? 0;
      return dateB - dateA;
    });

    logSubConnector(this.platform, `Total: ${allItems.length} videos`);

    return {
      items: allItems,
      totalResults: allItems.length,
      hasMore: false,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  }

  private async fetchHashtag(
    hashtag: string,
    config: typeof SOCIAVAULT_CONFIG.api.platforms.tiktok,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    const response = await makeApiRequestWithRetry<TikTokHashtagResponse>({
      endpoint: config.hashtagEndpoint,
      params: {
        hashtag,
        region: config.defaultRegion,
      },
      apiKey,
      baseUrl,
    });

    if (response.error) {
      logSubConnector(
        this.platform,
        `Error for #${hashtag}: ${response.error}`,
        "warn",
      );
      return { items: [], error: `#${hashtag}: ${response.error}` };
    }

    const videos = response.data?.aweme_list;
    if (!videos || !Array.isArray(videos)) {
      logSubConnector(
        this.platform,
        `#${hashtag}: No videos in response`,
        "warn",
      );
      return { items: [], error: `#${hashtag}: No videos found` };
    }

    const items = this.transformVideos(videos);
    logSubConnector(this.platform, `#${hashtag}: ${items.length} videos`);

    return { items, totalResults: items.length, hasMore: false };
  }

  private async fetchTrending(
    config: typeof SOCIAVAULT_CONFIG.api.platforms.tiktok,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    logSubConnector(
      this.platform,
      `Fetching trending (${config.defaultRegion})`,
    );

    const response = await makeApiRequestWithRetry<TikTokTrendingResponse>({
      endpoint: config.trendingEndpoint,
      params: {
        region: config.defaultRegion,
      },
      apiKey,
      baseUrl,
    });

    if (response.error) {
      logSubConnector(
        this.platform,
        `Error fetching trending: ${response.error}`,
        "warn",
      );
      return { items: [], error: `Trending: ${response.error}` };
    }

    const videos = response.data?.aweme_list;
    if (!videos || !Array.isArray(videos)) {
      logSubConnector(this.platform, `Trending: No videos in response`, "warn");
      return { items: [], error: `Trending: No videos found` };
    }

    const items = this.transformVideos(videos);
    logSubConnector(this.platform, `Trending: ${items.length} videos`);

    return {
      items,
      totalResults: items.length,
      hasMore: false,
    };
  }

  private transformVideos(videos: TikTokVideo[]): FetchedContentItem[] {
    return videos
      .filter((video) => video.aweme_id && video.desc)
      .filter((video) => !video.is_ad)
      .map((video) => ({
        title: this.truncateText(video.desc, 280),
        url:
          video.url ??
          `https://www.tiktok.com/@${video.author?.unique_id ?? "user"}/video/${video.aweme_id}`,
        description: null,
        imageUrl: this.getCoverImage(video),
        source: this.platform,
        category: "social" as const,
        author: video.author ? `@${video.author.unique_id}` : "Unknown",
        publishedAt: video.create_time
          ? new Date(video.create_time * 1000)
          : null,
        metadata: {
          playCount: video.statistics?.play_count ?? 0,
          likeCount: video.statistics?.digg_count ?? 0,
          commentCount: video.statistics?.comment_count ?? 0,
          shareCount: video.statistics?.share_count ?? 0,
          platform: this.platformName,
          videoId: video.aweme_id,
          authorName: video.author?.nickname,
          isVerified: video.author?.verified ?? false,
          musicTitle: video.music?.title,
          musicAuthor: video.music?.author,
        },
      }));
  }

  private getCoverImage(video: TikTokVideo): string | null {
    // Try dynamic cover first (animated), then static cover
    const dynamicCover = video.video?.dynamic_cover?.url_list?.[0];
    if (dynamicCover) return dynamicCover;

    const cover = video.video?.cover?.url_list?.[0];
    if (cover) return cover;

    return null;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
  }
}

export const tiktokSubConnector = new TikTokSubConnector();
