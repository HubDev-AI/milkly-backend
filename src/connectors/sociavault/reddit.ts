/**
 * Reddit Subconnector
 *
 * Fetches posts from curated subreddits.
 * Note: SociaVault's Reddit API doesn't support cross-subreddit keyword search,
 * so we fetch from pre-defined subreddits and filter by keywords.
 */

import type { FetchOptions, FetchResult, FetchedContentItem } from "../types";
import type {
  SocialSubConnector,
  RedditSubredditPostsResponse,
  RedditPost,
} from "./types";
import {
  makeApiRequestWithRetry,
  filterByKeywords,
  logSubConnector,
} from "./base";
import { SOCIAVAULT_CONFIG } from "../../config";

class RedditSubConnector implements SocialSubConnector {
  readonly platform = "reddit";
  readonly platformName = "Reddit";

  async fetch(
    options: FetchOptions,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    const defaultSubreddits =
      SOCIAVAULT_CONFIG.api.platforms.reddit.defaultSubreddits;
    const endpoint = SOCIAVAULT_CONFIG.api.platforms.reddit.endpoint;

    // Use keywords as subreddit names if provided, otherwise fall back to defaults
    // This makes Reddit content keyword-aware (e.g., "cats" → r/cats)
    let subredditsToFetch: string[];
    if (options.keywords.length > 0) {
      // Use keywords as subreddit names (sanitize: lowercase, no spaces)
      subredditsToFetch = options.keywords
        .slice(0, 3)
        .map((k) => k.toLowerCase().replace(/\s+/g, ""));
    } else {
      subredditsToFetch = defaultSubreddits.slice(0, 3);
    }

    logSubConnector(
      this.platform,
      `Fetching from ${subredditsToFetch.length} subreddits: r/${subredditsToFetch.join(", r/")}`,
    );

    // Fetch from all subreddits in parallel
    const results = await Promise.all(
      subredditsToFetch.map((subreddit) =>
        this.fetchFromSubreddit(subreddit, endpoint, apiKey, baseUrl),
      ),
    );

    // Aggregate all posts
    let allItems: FetchedContentItem[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.error) {
        errors.push(result.error);
      }
      allItems.push(...result.items);
    }

    // Filter by keywords if provided
    if (options.keywords.length > 0) {
      const beforeFilter = allItems.length;
      allItems = filterByKeywords(
        allItems,
        options.keywords,
        (item) => `${item.title} ${item.description ?? ""}`,
      );
      logSubConnector(
        this.platform,
        `Filtered ${beforeFilter} → ${allItems.length} posts by keywords`,
      );
    }

    // Sort by date
    allItems.sort((a, b) => {
      const dateA = a.publishedAt?.getTime() ?? 0;
      const dateB = b.publishedAt?.getTime() ?? 0;
      return dateB - dateA;
    });

    logSubConnector(this.platform, `Total: ${allItems.length} posts`);

    return {
      items: allItems,
      totalResults: allItems.length,
      hasMore: false,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  }

  private async fetchFromSubreddit(
    subreddit: string,
    endpoint: string,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    const response =
      await makeApiRequestWithRetry<RedditSubredditPostsResponse>({
        endpoint,
        params: {
          subreddit,
        },
        apiKey,
        baseUrl,
      });

    if (response.error) {
      logSubConnector(
        this.platform,
        `Error for r/${subreddit}: ${response.error}`,
        "warn",
      );
      return { items: [], error: `r/${subreddit}: ${response.error}` };
    }

    // API returns nested structure: { success, data: { success, posts: { "0": {...}, "1": {...} } } }
    const postsObj = response.data?.data?.posts;
    if (!postsObj || typeof postsObj !== "object") {
      logSubConnector(
        this.platform,
        `r/${subreddit}: No posts in response`,
        "warn",
      );
      return { items: [], error: `r/${subreddit}: No posts found` };
    }

    // Convert object with numeric keys to array
    const posts = Object.values(postsObj) as RedditPost[];
    const items = this.transformPosts(posts);
    logSubConnector(this.platform, `r/${subreddit}: ${items.length} posts`);

    return { items, totalResults: items.length, hasMore: false };
  }

  private transformPosts(posts: RedditPost[]): FetchedContentItem[] {
    return posts
      .filter((post) => post.title)
      .map((post) => ({
        title: post.title,
        url: `https://reddit.com${post.permalink}`,
        description: this.truncateText(post.selftext, 300),
        imageUrl: this.getBestImage(post),
        source: this.platform,
        category: "social" as const,
        author: `u/${post.author}`,
        publishedAt: new Date(post.created_utc * 1000),
        metadata: {
          score: post.score,
          numComments: post.num_comments,
          subreddit: post.subreddit,
          subredditPrefixed:
            post.subreddit_name_prefixed ?? `r/${post.subreddit}`,
          platform: this.platformName,
          postId: post.id,
          flair: post.link_flair_text,
          isVideo: post.is_video ?? false,
          isSelf: post.is_self ?? false,
        },
      }));
  }

  private getBestImage(post: RedditPost): string | null {
    // Try preview images first
    const preview = post.preview?.images?.[0]?.source?.url;
    if (preview) {
      // Reddit encodes HTML entities in URLs
      return preview.replace(/&amp;/g, "&");
    }

    // Fall back to thumbnail if it's a valid URL
    if (post.thumbnail && post.thumbnail.startsWith("http")) {
      return post.thumbnail;
    }

    return null;
  }

  private truncateText(
    text: string | undefined,
    maxLength: number,
  ): string | null {
    if (!text) return null;
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
  }
}

export const redditSubConnector = new RedditSubConnector();
