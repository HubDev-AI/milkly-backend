/**
 * Content Source Configuration
 *
 * Centralized configuration for all content source connectors.
 * Each source has its own config with API settings, defaults, and feature flags.
 */

import type { Category } from "../types";

// ============ Sort Options ============

export type SortOption = "date" | "relevancy" | "popularity";

export const SORT_OPTIONS = {
  DATE: "date" as const,
  RELEVANCY: "relevancy" as const,
  POPULARITY: "popularity" as const,
} as const;

// ============ Source IDs ============

export const SOURCE_IDS = {
  NEWS_API: "news-api",
  YOUTUBE: "youtube",
  SOCIAL_MOCK: "social-mock",
  SOCIAVAULT: "sociavault",
} as const;

export type SourceId = (typeof SOURCE_IDS)[keyof typeof SOURCE_IDS];

// ============ Base Source Config ============

export interface BaseSourceConfig {
  id: SourceId;
  name: string;
  category: Category;
  enabled: boolean;
  defaults: {
    pageSize: number;
    sortBy: SortOption;
  };
  maxPageSize: number;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
}

// ============ News API Configuration ============

export interface NewsApiConfig extends BaseSourceConfig {
  id: typeof SOURCE_IDS.NEWS_API;
  api: {
    baseUrl: string;
    endpoints: {
      everything: string;
      topHeadlines: string;
    };
    params: {
      language: string;
      sortByMapping: Record<SortOption, string>;
    };
  };
}

export const NEWS_API_CONFIG: NewsApiConfig = {
  id: SOURCE_IDS.NEWS_API,
  name: "News API",
  category: "news",
  enabled: true,
  defaults: {
    pageSize: 25,
    sortBy: SORT_OPTIONS.DATE,
  },
  maxPageSize: 50,
  rateLimit: {
    requestsPerMinute: 10,
    requestsPerDay: 100, // Free tier limit
  },
  api: {
    baseUrl: "https://newsapi.org/v2",
    endpoints: {
      everything: "/everything",
      topHeadlines: "/top-headlines",
    },
    params: {
      language: "en",
      sortByMapping: {
        date: "publishedAt",
        relevancy: "relevancy",
        popularity: "popularity",
      },
    },
  },
};

// ============ YouTube Configuration ============

export interface YouTubeConfig extends BaseSourceConfig {
  id: typeof SOURCE_IDS.YOUTUBE;
  api: {
    baseUrl: string;
    endpoints: {
      search: string;
      videos: string;
    };
    params: {
      type: string;
      relevanceLanguage: string;
      orderMapping: Record<SortOption, string>;
    };
  };
}

export const YOUTUBE_CONFIG: YouTubeConfig = {
  id: SOURCE_IDS.YOUTUBE,
  name: "YouTube",
  category: "videos",
  enabled: true,
  defaults: {
    pageSize: 20,
    sortBy: SORT_OPTIONS.DATE,
  },
  maxPageSize: 50,
  rateLimit: {
    requestsPerMinute: 50,
    requestsPerDay: 10000, // YouTube quota units
  },
  api: {
    baseUrl: "https://www.googleapis.com/youtube/v3",
    endpoints: {
      search: "/search",
      videos: "/videos",
    },
    params: {
      type: "video",
      relevanceLanguage: "en",
      orderMapping: {
        date: "date",
        relevancy: "relevance",
        popularity: "viewCount",
      },
    },
  },
};

// ============ Social Mock Configuration ============

export interface SocialMockConfig extends BaseSourceConfig {
  id: typeof SOURCE_IDS.SOCIAL_MOCK;
  mock: {
    maxHoursAgo: number;
    imageFrequency: number;
    platforms: Array<{ id: string; name: string }>;
    handles: string[];
  };
}

export const SOCIAL_MOCK_CONFIG: SocialMockConfig = {
  id: SOURCE_IDS.SOCIAL_MOCK,
  name: "Social (Mock)",
  category: "social",
  enabled: true,
  defaults: {
    pageSize: 20,
    sortBy: SORT_OPTIONS.DATE,
  },
  maxPageSize: 50,
  mock: {
    maxHoursAgo: 48,
    imageFrequency: 4, // Show image every N posts
    platforms: [
      { id: "twitter", name: "X (Twitter)" },
      { id: "reddit", name: "Reddit" },
      { id: "linkedin", name: "LinkedIn" },
    ],
    handles: [
      "@tech_insider",
      "@industry_news",
      "@dev_community",
      "@future_trends",
      "@innovator_hub",
      "@digital_pulse",
      "u/techexpert",
      "u/newsbreaker",
      "r/technology",
      "r/futurology",
    ],
  },
};

// ============ SociaVault Configuration ============

export interface SociaVaultPlatformConfig {
  endpoint: string;
  enabled: boolean;
}

export interface SociaVaultConfig extends BaseSourceConfig {
  id: typeof SOURCE_IDS.SOCIAVAULT;
  api: {
    baseUrl: string;
    platforms: {
      threads: SociaVaultPlatformConfig & { supportsKeywordSearch: true };
      twitter: SociaVaultPlatformConfig & { defaultAccounts: string[] };
      reddit: SociaVaultPlatformConfig & { defaultSubreddits: string[] };
      tiktok: SociaVaultPlatformConfig & {
        hashtagEndpoint: string;
        trendingEndpoint: string;
        defaultRegion: string;
      };
    };
  };
}

export const SOCIAVAULT_CONFIG: SociaVaultConfig = {
  id: SOURCE_IDS.SOCIAVAULT,
  name: "SociaVault",
  category: "social",
  enabled: true,
  defaults: {
    pageSize: 20,
    sortBy: SORT_OPTIONS.DATE,
  },
  maxPageSize: 50,
  api: {
    baseUrl: "https://api.sociavault.com/v1/scrape",
    platforms: {
      threads: {
        endpoint: "/threads/search",
        enabled: true,
        supportsKeywordSearch: true,
      },
      twitter: {
        endpoint: "/twitter/user-tweets",
        enabled: true,
        defaultAccounts: [
          "levelsio",
          "pmarca",
          "naval",
          "elaboratepasta",
          "jason",
          "paulg",
        ],
      },
      reddit: {
        endpoint: "/reddit/subreddit",
        enabled: true,
        defaultSubreddits: [
          "technology",
          "programming",
          "futurology",
          "startups",
          "entrepreneur",
        ],
      },
      tiktok: {
        endpoint: "/tiktok/search/hashtag",
        hashtagEndpoint: "/tiktok/search/hashtag",
        trendingEndpoint: "/tiktok/trending",
        enabled: true,
        defaultRegion: "US",
      },
    },
  },
};

// ============ All Sources Registry ============

export type SourceConfig =
  | NewsApiConfig
  | YouTubeConfig
  | SocialMockConfig
  | SociaVaultConfig;

export const SOURCES_BY_ID: Record<SourceId, SourceConfig> = {
  [SOURCE_IDS.NEWS_API]: NEWS_API_CONFIG,
  [SOURCE_IDS.YOUTUBE]: YOUTUBE_CONFIG,
  [SOURCE_IDS.SOCIAL_MOCK]: SOCIAL_MOCK_CONFIG,
  [SOURCE_IDS.SOCIAVAULT]: SOCIAVAULT_CONFIG,
};

export const SOURCES_BY_CATEGORY: Partial<Record<Category, SourceConfig>> = {
  news: NEWS_API_CONFIG,
  videos: YOUTUBE_CONFIG,
  social: SOCIAVAULT_CONFIG, // Use real SociaVault API instead of mock
  // 'custom' category doesn't have a source config - items are manually created
};

// ============ Helper Functions ============

export function getSourceConfig(id: SourceId): SourceConfig {
  const config = SOURCES_BY_ID[id];
  if (!config) {
    throw new Error(`Unknown source: ${id}`);
  }
  return config;
}

export function getSourceConfigByCategory(category: Category): SourceConfig {
  const config = SOURCES_BY_CATEGORY[category];
  if (!config) {
    throw new Error(`No source configured for category: ${category}`);
  }
  return config;
}

export function getEnabledSources(): SourceConfig[] {
  return Object.values(SOURCES_BY_ID).filter((config) => config.enabled);
}

export function getEnabledSourcesForCategories(
  categories: Category[],
): SourceConfig[] {
  return categories
    .map((category) => SOURCES_BY_CATEGORY[category])
    .filter(
      (config): config is SourceConfig =>
        config !== undefined && config.enabled,
    );
}
