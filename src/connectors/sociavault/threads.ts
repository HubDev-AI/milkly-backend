/**
 * Threads Subconnector
 *
 * Fetches posts from Threads using keyword search.
 * This is the primary source for keyword-based social content.
 */

import type { FetchOptions, FetchResult, FetchedContentItem } from "../types";
import type {
  SocialSubConnector,
  ThreadsSearchResponse,
  ThreadsPost,
} from "./types";
import {
  makeApiRequestWithRetry,
  buildKeywordQuery,
  logSubConnector,
} from "./base";
import { SOCIAVAULT_CONFIG } from "../../config";

class ThreadsSubConnector implements SocialSubConnector {
  readonly platform = "threads";
  readonly platformName = "Threads";

  async fetch(
    options: FetchOptions,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    const query = buildKeywordQuery(options.keywords, options.fallbackQuery);

    if (!query) {
      logSubConnector(this.platform, "No query provided, skipping", "warn");
      return { items: [], error: "No search query provided" };
    }

    logSubConnector(this.platform, `Searching for: "${query}"`);

    const endpoint = SOCIAVAULT_CONFIG.api.platforms.threads.endpoint;
    const response = await makeApiRequestWithRetry<ThreadsSearchResponse>({
      endpoint,
      params: {
        query,
        trim: "true",
      },
      apiKey,
      baseUrl,
    });

    if (response.error) {
      return { items: [], error: response.error };
    }

    if (!response.data?.posts || !Array.isArray(response.data.posts)) {
      logSubConnector(this.platform, "No posts in response", "warn");
      return { items: [], error: "Invalid response format" };
    }

    const items = this.transformPosts(response.data.posts);
    logSubConnector(this.platform, `Fetched ${items.length} posts`);

    return {
      items,
      totalResults: items.length,
      hasMore: false, // Threads API returns 20-30 results max
    };
  }

  private transformPosts(posts: ThreadsPost[]): FetchedContentItem[] {
    return posts
      .filter((post) => post.caption?.text)
      .map((post) => ({
        title: post.caption!.text,
        url: this.buildPostUrl(post),
        description: null,
        imageUrl: this.getBestImage(post),
        source: this.platform,
        category: "social" as const,
        author: `@${post.user.username}`,
        publishedAt: new Date(post.taken_at * 1000),
        metadata: {
          likeCount: post.like_count ?? 0,
          replyCount: post.text_post_app_info?.direct_reply_count ?? 0,
          repostCount: post.text_post_app_info?.repost_count ?? 0,
          quoteCount: post.text_post_app_info?.quote_count ?? 0,
          platform: this.platformName,
          postId: post.id,
          isVerified: post.user.is_verified ?? false,
        },
      }));
  }

  private buildPostUrl(post: ThreadsPost): string {
    return `https://www.threads.net/@${post.user.username}/post/${post.code}`;
  }

  private getBestImage(post: ThreadsPost): string | null {
    const candidates = post.image_versions2?.candidates;
    if (!candidates || candidates.length === 0) return null;
    // Return the first (usually highest quality) image
    return candidates[0]?.url ?? null;
  }
}

export const threadsSubConnector = new ThreadsSubConnector();
