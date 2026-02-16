// Subscription tier configuration

import type { Category } from "../types";

export type TierName = "essential" | "professional" | "mastery";

export const TIER_NAMES: Record<TierName, string> = {
  essential: "Essential",
  professional: "Professional",
  mastery: "Mastery",
} as const;

export interface TierLimits {
  maxStreams: number; // -1 = unlimited
  linkedStreams: boolean;
  aiCredits: number; // AI credit pool (-1 = unlimited)
  aiCreditsPeriodHours: number; // Period duration (720 = monthly)
  refreshes: number; // Feed refresh operations (-1 = unlimited)
  refreshesPeriodHours: number; // Period duration (720 = monthly)
  resultsPerRefresh: number; // Results returned per refresh
  maxEmailSubscribers: number; // Max subscribers who can receive emails per newsletter (-1 = unlimited)
  allowedCategories: Category[];
  allowCustomItems: boolean;
  maxStorageMB: number; // Max media storage in MB (-1 = unlimited)
}

// 720 hours = 30 days (monthly)
const MONTHLY_PERIOD_HOURS = 720;

export const TIER_LIMITS: Record<TierName, TierLimits> = {
  essential: {
    maxStreams: 1,
    linkedStreams: false,
    aiCredits: 120,
    aiCreditsPeriodHours: MONTHLY_PERIOD_HOURS,
    refreshes: 30,
    refreshesPeriodHours: MONTHLY_PERIOD_HOURS,
    resultsPerRefresh: 10,
    maxEmailSubscribers: 100,
    allowedCategories: ["news", "videos", "custom"],
    allowCustomItems: true,
    maxStorageMB: 10,
  },
  professional: {
    maxStreams: 10,
    linkedStreams: true,
    aiCredits: 1200,
    aiCreditsPeriodHours: MONTHLY_PERIOD_HOURS,
    refreshes: 300,
    refreshesPeriodHours: MONTHLY_PERIOD_HOURS,
    resultsPerRefresh: 30,
    maxEmailSubscribers: 1000,
    allowedCategories: ["news", "videos", "social", "custom"],
    allowCustomItems: true,
    maxStorageMB: 100,
  },
  mastery: {
    maxStreams: 50,
    linkedStreams: true,
    aiCredits: 2500,
    aiCreditsPeriodHours: MONTHLY_PERIOD_HOURS,
    refreshes: 500,
    refreshesPeriodHours: MONTHLY_PERIOD_HOURS,
    resultsPerRefresh: 50,
    maxEmailSubscribers: 100000,
    allowedCategories: ["news", "videos", "social", "custom"],
    allowCustomItems: true,
    maxStorageMB: 1000,
  },
};

export const TIER_FEATURES: Record<TierName, string[]> = {
  essential: [
    "1 stream",
    "120 AI credits / month",
    "100 subscribers",
    "News & Videos",
  ],
  professional: [
    "10 streams",
    "1,200 AI credits / month",
    "1,000 subscribers",
    "Linked streams",
    "All categories",
  ],
  mastery: [
    "50 streams",
    "2,500 AI credits / month",
    "100,000 subscribers",
    "Priority support",
  ],
};

// Helper to check if a limit is unlimited
export function isUnlimited(limit: number): boolean {
  return limit === -1;
}

// Helper to get tier limits for a user
export function getTierLimits(tier: TierName): TierLimits {
  return TIER_LIMITS[tier] || TIER_LIMITS.essential;
}

// Helper to get period boundaries for usage tracking (legacy, use calendar month instead)
export function getPeriodBoundaries(periodHours: number): {
  start: Date;
  end: Date;
} {
  const now = new Date();
  const periodMs = periodHours * 60 * 60 * 1000;

  // Calculate start of period based on epoch time
  const epochMs = now.getTime();
  const periodStartMs = Math.floor(epochMs / periodMs) * periodMs;

  const start = new Date(periodStartMs);
  const end = new Date(periodStartMs + periodMs);

  return { start, end };
}

// Get current calendar month boundaries (1st of month to 1st of next month)
export function getCurrentMonthBoundaries(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return { start, end };
}

// Alias for backward compatibility
export function getCurrentWeekBoundaries(): { start: Date; end: Date } {
  return getCurrentMonthBoundaries();
}

// Helper to get allowed categories for a tier
export function getCategoriesForTier(tier: TierName): Category[] {
  return (
    TIER_LIMITS[tier]?.allowedCategories ||
    TIER_LIMITS.essential.allowedCategories
  );
}

// Helper to check if a category is allowed for a tier
export function isCategoryAllowedForTier(
  category: Category,
  tier: TierName,
): boolean {
  const allowedCategories = getCategoriesForTier(tier);
  return allowedCategories.includes(category);
}

// Helper to filter categories to only those allowed for a tier
export function filterCategoriesForTier(
  categories: Category[],
  tier: TierName,
): Category[] {
  const allowedCategories = getCategoriesForTier(tier);
  return categories.filter((category) => allowedCategories.includes(category));
}

// Helper to get categories that are not allowed for a tier
export function getDisallowedCategories(
  categories: Category[],
  tier: TierName,
): Category[] {
  const allowedCategories = getCategoriesForTier(tier);
  return categories.filter((category) => !allowedCategories.includes(category));
}

// Helper to get results per refresh for a tier
export function getResultsPerRefresh(tier: TierName): number {
  const limits = getTierLimits(tier);
  return limits.resultsPerRefresh;
}

// ============ Style Learning Feature Gates ============

export type StyleLearningFeature =
  | "fewShotFromEditions"
  | "styleProfile"
  | "editDiffTracking"
  | "writingBaseline";

export const STYLE_LEARNING_FEATURES: Record<
  StyleLearningFeature,
  { tiers: TierName[] }
> = {
  fewShotFromEditions: { tiers: ["mastery"] },
  styleProfile: { tiers: ["mastery"] },
  editDiffTracking: { tiers: ["mastery"] },
  writingBaseline: { tiers: ["mastery"] },
};

export const WRITING_BASELINE_PUBLISH_INTERVAL = 5;

export function isStyleFeatureEnabled(
  feature: StyleLearningFeature,
  tier: TierName,
): boolean {
  return STYLE_LEARNING_FEATURES[feature].tiers.includes(tier);
}

// AI Operation Types
export const AI_OPERATIONS = {
  AI_GENERATE_FULL: "aiGenerateFull",
  PREVIEW_GENERATION: "previewGeneration",
  TEMPLATE_GENERATION: "templateGeneration",
  CONTENT_REGENERATION: "contentRegeneration",
  TEMPLATE_PREVIEW: "templatePreview",
  NOTES_GENERATION: "notesGeneration",
  BLOCK_REGENERATION: "blockRegeneration",
  KEYWORD_GENERATION: "keywordGeneration",
  STYLE_ANALYSIS: "styleAnalysis",
} as const;

export type AIOperationType =
  (typeof AI_OPERATIONS)[keyof typeof AI_OPERATIONS];

// AI Credit Costs mapping
export const AI_CREDIT_COSTS: Record<AIOperationType, number> = {
  aiGenerateFull: 15, // POST /api/ai/generate
  previewGeneration: 10, // POST /newsletters/preview
  templateGeneration: 8, // POST /templates, POST /streams/:id/templates
  contentRegeneration: 8, // POST /newsletters/:id/regenerate
  templatePreview: 6, // POST /templates/preview
  notesGeneration: 5, // POST /newsletters/:id/generate-notes (URL scraping + rich editorial)
  blockRegeneration: 3, // POST /newsletters/:id/regenerate-block
  keywordGeneration: 2, // POST /streams/generate-keywords
  styleAnalysis: 0, // Post-publish style learning (platform feature, not charged)
};

// AI Model Tier mapping (high = complex, low = simple)
export type AIModelTier = "high" | "low";

export const AI_OPERATION_MODEL_TIER: Record<AIOperationType, AIModelTier> = {
  aiGenerateFull: "high",
  previewGeneration: "high",
  templateGeneration: "high",
  contentRegeneration: "high",
  templatePreview: "high",
  notesGeneration: "high",
  blockRegeneration: "low",
  keywordGeneration: "low",
  styleAnalysis: "low",
};

// Helper function to get AI credit cost
export function getAICreditCost(operation: AIOperationType): number {
  return AI_CREDIT_COSTS[operation];
}

// Helper function to get AI model tier
export function getAIModelTier(operation: AIOperationType): AIModelTier {
  return AI_OPERATION_MODEL_TIER[operation];
}
