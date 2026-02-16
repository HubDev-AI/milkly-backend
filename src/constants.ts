// API Configuration Constants

// ============ Content API Settings ============

export const NEWS_API = {
  BASE_URL: "https://newsapi.org/v2",
  DEFAULT_PAGE_SIZE: 25,
  LANGUAGE: "en",
  // Sort options: relevancy, publishedAt, popularity
  SORT_BY: "publishedAt" as const,
} as const;

export const YOUTUBE_API = {
  BASE_URL: "https://www.googleapis.com/youtube/v3",
  DEFAULT_MAX_RESULTS: 20,
  TYPE: "video" as const,
  // Order options: date, rating, relevance, title, videoCount, viewCount
  ORDER: "date" as const,
  RELEVANCE_LANGUAGE: "en",
} as const;

export const SOCIAL_CONTENT = {
  DEFAULT_COUNT: 20,
  MAX_HOURS_AGO: 48,
} as const;

// ============ Content Categories ============

export const CATEGORIES = {
  NEWS: "news",
  VIDEOS: "videos",
  SOCIAL: "social",
  CUSTOM: "custom",
} as const;

export type Category = (typeof CATEGORIES)[keyof typeof CATEGORIES];

export const CATEGORY_LABELS: Record<Category, string> = {
  [CATEGORIES.NEWS]: "News",
  [CATEGORIES.VIDEOS]: "Videos",
  [CATEGORIES.SOCIAL]: "Social",
  [CATEGORIES.CUSTOM]: "Custom",
};

// ============ Newsletter Settings ============

export const NEWSLETTER = {
  DEFAULT_TITLE: "Newsletter",
  STATUS: {
    DRAFT: "draft",
    PUBLISHED: "published",
  },
  TEMPLATE: {
    DEFAULT_MAX_ITEMS: 3,
    MIN_ITEMS: 1,
    MAX_ITEMS: 5,
  },
} as const;

// ============ Pagination ============

export const PAGINATION = {
  // Default page sizes for different entities
  STREAMS: {
    DEFAULT: 20,
    MAX: 50,
  },
  FEED_ITEMS: {
    DEFAULT: 20,
    MAX: 100,
  },
  NEWSLETTERS: {
    DEFAULT: 10,
    MAX: 50,
  },
  TEMPLATES: {
    DEFAULT: 10,
    MAX: 20,
  },
  // Legacy defaults
  DEFAULT_LIMIT: 50,
  DEFAULT_OFFSET: 0,
  MAX_LIMIT: 100,
} as const;

// ============ Social Media Sources ============

export const SOCIAL_SOURCES = [
  { id: "twitter", name: "X (Twitter)" },
  { id: "reddit", name: "Reddit" },
  { id: "linkedin", name: "LinkedIn" },
] as const;

export const SOCIAL_HANDLES = [
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
] as const;

// ============ UI Constants ============

export const UI = {
  TRUNCATE_DESCRIPTION_LENGTH: 150,
  DATE_FORMAT: "MMM d, yyyy",
  TIME_FORMAT: "h:mm a",
} as const;
