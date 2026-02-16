/**
 * Twitter/X Subconnector
 *
 * Fetches tweets from curated accounts.
 * Note: SociaVault's Twitter API doesn't support keyword search,
 * so we fetch from pre-defined popular accounts and filter by keywords.
 */

import type { FetchOptions, FetchResult, FetchedContentItem } from "../types";
import type {
  SocialSubConnector,
  TwitterUserTweetsResponse,
  TwitterTweet,
} from "./types";
import { makeApiRequestWithRetry, logSubConnector } from "./base";
import { SOCIAVAULT_CONFIG } from "../../config";

class TwitterSubConnector implements SocialSubConnector {
  readonly platform = "twitter";
  readonly platformName = "X (Twitter)";

  async fetch(
    options: FetchOptions,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    const accounts = SOCIAVAULT_CONFIG.api.platforms.twitter.defaultAccounts;
    const endpoint = SOCIAVAULT_CONFIG.api.platforms.twitter.endpoint;

    // Limit accounts to fetch to save credits (1 credit per account)
    const accountsToFetch = accounts.slice(0, 3);

    logSubConnector(
      this.platform,
      `Fetching from ${accountsToFetch.length} accounts: ${accountsToFetch.join(", ")}`,
    );

    // Fetch from all accounts in parallel
    const results = await Promise.all(
      accountsToFetch.map((handle) =>
        this.fetchFromAccount(handle, endpoint, apiKey, baseUrl),
      ),
    );

    // Aggregate all tweets
    let allItems: FetchedContentItem[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.error) {
        errors.push(result.error);
      }
      allItems.push(...result.items);
    }

    // Note: No keyword filtering - Twitter fetches from curated accounts,
    // so we return all tweets from those accounts rather than filtering

    // Sort by date
    allItems.sort((a, b) => {
      const dateA = a.publishedAt?.getTime() ?? 0;
      const dateB = b.publishedAt?.getTime() ?? 0;
      return dateB - dateA;
    });

    logSubConnector(this.platform, `Total: ${allItems.length} tweets`);

    return {
      items: allItems,
      totalResults: allItems.length,
      hasMore: false,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  }

  private async fetchFromAccount(
    handle: string,
    endpoint: string,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult> {
    const response = await makeApiRequestWithRetry<TwitterUserTweetsResponse>({
      endpoint,
      params: {
        handle,
        trim: "true",
      },
      apiKey,
      baseUrl,
    });

    if (response.error) {
      logSubConnector(
        this.platform,
        `Error for @${handle}: ${response.error}`,
        "warn",
      );
      return { items: [], error: `@${handle}: ${response.error}` };
    }

    // API returns nested structure: { success, data: { success, tweets: { "0": {...}, "1": {...} } } }
    const tweetsObj = response.data?.data?.tweets;
    if (!tweetsObj || typeof tweetsObj !== "object") {
      logSubConnector(
        this.platform,
        `@${handle}: No tweets in response`,
        "warn",
      );
      return { items: [], error: `@${handle}: No tweets found` };
    }

    // Convert object with numeric keys to array
    const tweets = Object.values(tweetsObj) as TwitterTweet[];
    const items = this.transformTweets(tweets);
    logSubConnector(this.platform, `@${handle}: ${items.length} tweets`);

    return { items, totalResults: items.length, hasMore: false };
  }

  private transformTweets(tweets: TwitterTweet[]): FetchedContentItem[] {
    return tweets
      .filter((tweet) => tweet.legacy?.full_text)
      .map((tweet) => {
        const legacy = tweet.legacy!;
        const user = tweet.core?.user_results?.result?.legacy;

        return {
          title: legacy.full_text,
          url:
            tweet.url ?? this.buildTweetUrl(tweet.rest_id, user?.screen_name),
          description: null,
          imageUrl: this.getMediaUrl(legacy),
          source: this.platform,
          category: "social" as const,
          author: user ? `@${user.screen_name}` : "Unknown",
          publishedAt: this.parseTwitterDate(legacy.created_at),
          metadata: {
            likeCount: legacy.favorite_count ?? 0,
            replyCount: legacy.reply_count ?? 0,
            retweetCount: legacy.retweet_count ?? 0,
            viewCount: tweet.views?.count
              ? parseInt(tweet.views.count, 10)
              : null,
            platform: this.platformName,
            tweetId: tweet.rest_id,
            authorName: user?.name,
            isVerified: user?.verified ?? false,
          },
        };
      });
  }

  private buildTweetUrl(tweetId: string, screenName?: string): string {
    const user = screenName ?? "i";
    return `https://x.com/${user}/status/${tweetId}`;
  }

  private getMediaUrl(legacy: TwitterTweet["legacy"]): string | null {
    const media = legacy?.entities?.media;
    if (!media || media.length === 0) return null;
    return media[0]?.media_url_https ?? null;
  }

  private parseTwitterDate(dateStr: string): Date | null {
    if (!dateStr) return null;
    // Twitter date format: "Mon Jan 01 00:00:00 +0000 2024"
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  }
}

export const twitterSubConnector = new TwitterSubConnector();
