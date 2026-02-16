/**
 * Application Configuration
 *
 * Centralized configuration management.
 * All magic numbers, strings, and settings are defined here.
 */

import { env } from "../env";

// Re-export source configurations
export * from "./sources";

// ============ Pagination Configuration ============

export const PAGINATION = {
  FEED: {
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
  },
  STREAMS: {
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 50,
  },
  NEWSLETTERS: {
    DEFAULT_LIMIT: 10,
    MAX_LIMIT: 50,
  },
  TEMPLATES: {
    DEFAULT_LIMIT: 10,
    MAX_LIMIT: 20,
  },
} as const;

// ============ AI Configuration ============

// Default endpoints per provider
const AI_ENDPOINTS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

export const AI = {
  PROVIDER: env.AI_PROVIDER,
  MODEL: env.AI_MODEL,
  TEMPERATURE: env.AI_TEMPERATURE,
  ENDPOINT:
    env.AI_ENDPOINT ||
    (env.AI_PROVIDER ? AI_ENDPOINTS[env.AI_PROVIDER] : undefined) ||
    AI_ENDPOINTS.gemini,
  MAX_DESCRIPTION_LENGTH: 200,

  // Max validation retries before returning cleaned output
  MAX_VALIDATION_RETRIES: 2,

  // Per-task temperature overrides for optimal results
  // Lower = more deterministic, Higher = more creative
  TEMPERATURES: {
    TEMPLATE_GENERATION: 0.8, // JSON structures need some creativity
    NEWSLETTER_CONTENT: 1.0, // HTML content needs creativity
    ITEM_NOTES: 0.9, // Varied but focused
    KEYWORDS: 0.5, // Precision task
    BLOCK_REGENERATION: 0.9, // Creative rewrites
  },

  // Legacy alias for backward compatibility
  GEMINI: {
    get MODEL() {
      return env.AI_MODEL;
    },
    get ENDPOINT() {
      return (
        env.AI_ENDPOINT ||
        (env.AI_PROVIDER ? AI_ENDPOINTS[env.AI_PROVIDER] : undefined) ||
        AI_ENDPOINTS.gemini
      );
    },
    get TEMPERATURE() {
      return env.AI_TEMPERATURE;
    },
    MAX_DESCRIPTION_LENGTH: 200,
  },
};

// ============ Newsletter Configuration ============

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

// ============ Category Configuration ============

export const CATEGORIES = {
  NEWS: "news",
  VIDEOS: "videos",
  SOCIAL: "social",
  CUSTOM: "custom",
  NONE: "none",
} as const;

export type CategoryKey = keyof typeof CATEGORIES;
export type CategoryValue = (typeof CATEGORIES)[CategoryKey];

export const CATEGORY_LABELS: Record<CategoryValue, string> = {
  [CATEGORIES.NEWS]: "News",
  [CATEGORIES.VIDEOS]: "Videos",
  [CATEGORIES.SOCIAL]: "Social",
  [CATEGORIES.CUSTOM]: "Custom",
  [CATEGORIES.NONE]: "Uncategorized",
};

// ============ UI Configuration ============

export const UI = {
  TRUNCATE_DESCRIPTION_LENGTH: 150,
  DATE_FORMAT: "MMM d, yyyy",
  TIME_FORMAT: "h:mm a",
} as const;

// ============ Cache Configuration ============

export const CACHE = {
  TTL: {
    FEED: 60 * 5, // 5 minutes
    TEMPLATES: 60 * 60, // 1 hour
    SESSION: 60 * 60 * 24, // 24 hours
  },
} as const;

// ============ Rate Limiting ============

export const RATE_LIMITS = {
  DEFAULT: {
    MAX_REQUESTS: 100,
    WINDOW_MS: 60 * 1000, // 1 minute
  },
  AUTH: {
    MAX_REQUESTS: 10,
    WINDOW_MS: 60 * 1000, // 1 minute
  },
  CONTENT_REFRESH: {
    MAX_REQUESTS: 5,
    WINDOW_MS: 60 * 1000, // 1 minute
  },
} as const;

// ============ Style Learning Configuration ============

export const STYLE_LEARNING = {
  ENABLED: env.STYLE_LEARNING_ENABLED,
  TEMPERATURE: 0.3,
  MAX_EDITIONS_FOR_FEW_SHOT: 3,
  MAX_GOLDEN_EXCERPTS: 5,
  MAX_EDIT_PATTERNS: 10,
  RECENCY_WEIGHT: 0.7,
} as const;

// ============ Development Mode ============

/**
 * DEV_MODE enables testing features without real payments:
 * - Switch subscription tiers directly from UI
 * - Skip Stripe checkout/portal
 * - Test tier-gated features
 *
 * Set DEV_MODE=true in .env to enable
 */
export const DEV_MODE = process.env.DEV_MODE === "true";

// Also export as getter for runtime check (in case of hot reload issues)
export function isDevMode(): boolean {
  return process.env.DEV_MODE === "true";
}
