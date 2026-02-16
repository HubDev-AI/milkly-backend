/**
 * SociaVault API Response Types
 *
 * Type definitions for SociaVault API responses.
 * Based on API documentation at docs.sociavault.com
 */

// ============ Threads Types ============

export interface ThreadsUser {
  pk: string;
  username: string;
  profile_pic_url?: string;
  is_verified?: boolean;
}

export interface ThreadsCaption {
  text: string;
  pk?: string;
  has_translation?: boolean;
}

export interface ThreadsEngagement {
  reshare_count?: number;
  direct_reply_count?: number;
  repost_count?: number;
  quote_count?: number;
}

export interface ThreadsPost {
  id: string;
  pk: string;
  code: string;
  user: ThreadsUser;
  caption?: ThreadsCaption;
  text_post_app_info?: ThreadsEngagement;
  like_count?: number;
  taken_at: number; // Unix timestamp
  media_type?: number;
  original_height?: number;
  original_width?: number;
  image_versions2?: {
    candidates?: Array<{ url: string; width: number; height: number }>;
  };
}

export interface ThreadsSearchResponse {
  success: boolean;
  posts?: ThreadsPost[];
  error?: string;
}

// ============ Twitter/X Types ============

export interface TwitterUserLegacy {
  screen_name: string;
  name: string;
  profile_image_url_https?: string;
  verified?: boolean;
  followers_count?: number;
}

export interface TwitterUserResult {
  result?: {
    legacy?: TwitterUserLegacy;
  };
}

export interface TwitterMediaEntity {
  media_url_https?: string;
  type?: string;
}

export interface TwitterEntities {
  media?: TwitterMediaEntity[];
  urls?: Array<{ expanded_url?: string }>;
  hashtags?: Array<{ text: string }>;
}

export interface TwitterTweetLegacy {
  full_text: string;
  created_at: string;
  favorite_count?: number;
  reply_count?: number;
  retweet_count?: number;
  entities?: TwitterEntities;
}

export interface TwitterTweet {
  __typename?: string;
  rest_id: string;
  core?: {
    user_results?: TwitterUserResult;
  };
  legacy?: TwitterTweetLegacy;
  views?: {
    count?: string;
    state?: string;
  };
  source?: string;
  url?: string;
}

export interface TwitterUserTweetsResponse {
  success?: boolean;
  data?: {
    success?: boolean;
    tweets?: Record<string, TwitterTweet>; // Object with numeric string keys
  };
  credits_used?: number;
  error?: string;
}

// ============ Reddit Types ============

export interface RedditPost {
  id: string;
  title: string;
  selftext?: string;
  author: string;
  subreddit: string;
  subreddit_name_prefixed?: string;
  permalink: string;
  url?: string;
  thumbnail?: string;
  preview?: {
    images?: Array<{
      source?: { url: string; width: number; height: number };
    }>;
  };
  score: number;
  num_comments: number;
  created_utc: number; // Unix timestamp
  is_video?: boolean;
  is_self?: boolean;
  link_flair_text?: string;
}

export interface RedditSubredditPostsResponse {
  success?: boolean;
  data?: {
    success?: boolean;
    posts?: Record<string, RedditPost>; // Object with numeric string keys
  };
  creditsUsed?: number;
  error?: string;
}

// ============ TikTok Types ============

export interface TikTokAuthor {
  uid: string;
  unique_id: string;
  nickname: string;
  avatar_thumb?: {
    url_list?: string[];
  };
  follower_count?: number;
  following_count?: number;
  verified?: boolean;
}

export interface TikTokStatistics {
  play_count?: number;
  digg_count?: number;
  comment_count?: number;
  share_count?: number;
  download_count?: number;
}

export interface TikTokVideo {
  aweme_id: string;
  desc: string;
  create_time?: number;
  author?: TikTokAuthor;
  statistics?: TikTokStatistics;
  video?: {
    play_addr?: {
      url_list?: string[];
    };
    cover?: {
      url_list?: string[];
    };
    dynamic_cover?: {
      url_list?: string[];
    };
  };
  music?: {
    title?: string;
    author?: string;
  };
  is_ad?: boolean;
  url?: string;
  region?: string;
}

export interface TikTokHashtagResponse {
  aweme_list?: TikTokVideo[];
  cursor?: number;
  has_more?: boolean;
  error?: string;
}

export interface TikTokTrendingResponse {
  aweme_list?: TikTokVideo[];
  error?: string;
}

// ============ Error Types ============

export interface SociaVaultErrorResponse {
  error: string;
  endpoint?: string;
  credits_required?: number;
  required?: number;
  available?: number;
  docs?: string;
}

// ============ Subconnector Interface ============

import type { FetchOptions, FetchResult } from "../types";

export interface SocialSubConnector {
  readonly platform: string;
  readonly platformName: string;
  fetch(
    options: FetchOptions,
    apiKey: string,
    baseUrl: string,
  ): Promise<FetchResult>;
}
