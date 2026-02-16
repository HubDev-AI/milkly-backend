import { z } from "zod";

/**
 * Environment variable schema using Zod
 * This ensures all required environment variables are present and valid
 */
const envSchema = z.object({
  // Server Configuration
  PORT: z.string().optional().default("3000"),
  NODE_ENV: z.string().optional(),
  BACKEND_URL: z
    .url("BACKEND_URL must be a valid URL")
    .default("http://localhost:3000"),

  // Database (PostgreSQL) - required, no default to prevent accidental dev DB usage
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Redis
  REDIS_URL: z.string().url().optional(),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),

  // Development
  DEV_MODE: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  LOG_LEVEL: z
    .enum(["error", "warn", "info", "debug", "trace"])
    .optional()
    .default("info"),

  // AI Configuration - Base (fallback)
  AI_PROVIDER: z.enum(["gemini", "openai", "anthropic", "google"]).optional(),
  AI_MODEL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_TEMPERATURE: z
    .string()
    .optional()
    .transform((val) => {
      if (!val || val === "") return 1.2;
      const num = parseFloat(val);
      return isNaN(num) ? 1.2 : Math.min(2, Math.max(0, num));
    }),
  AI_ENDPOINT: z.string().optional(),

  // AI Configuration - High-end model (complex tasks: template generation, content generation)
  AI_HIGH_PROVIDER: z.enum(["anthropic", "openai", "google"]).optional(),
  AI_HIGH_MODEL: z.string().optional(),
  AI_HIGH_API_KEY: z.string().optional(),

  // AI Configuration - Low-end model (simple tasks: notes, keywords, block regeneration)
  AI_LOW_PROVIDER: z.enum(["anthropic", "openai", "google"]).optional(),
  AI_LOW_MODEL: z.string().optional(),
  AI_LOW_API_KEY: z.string().optional(),

  // AI API Keys (provider-specific, legacy support)
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  // Content APIs
  NEWS_API_KEY: z.string().optional(),
  NEWS_API_BASE_URL: z.string().default("https://newsapi.org/v2"),
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_API_BASE_URL: z
    .string()
    .default("https://www.googleapis.com/youtube/v3"),
  SOCIAVAULT_API_KEY: z.string().optional(),
  SOCIAVAULT_API_BASE_URL: z
    .string()
    .default("https://api.sociavault.com/v1/scrape"),

  // Pagination
  PAGINATION_STREAMS_DEFAULT: z.coerce.number().default(20),
  PAGINATION_STREAMS_MAX: z.coerce.number().default(50),
  PAGINATION_FEED_DEFAULT: z.coerce.number().default(20),
  PAGINATION_FEED_MAX: z.coerce.number().default(100),
  PAGINATION_NEWSLETTERS_DEFAULT: z.coerce.number().default(10),
  PAGINATION_NEWSLETTERS_MAX: z.coerce.number().default(50),
  PAGINATION_TEMPLATES_DEFAULT: z.coerce.number().default(10),
  PAGINATION_TEMPLATES_MAX: z.coerce.number().default(20),

  // Payment - Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_PROFESSIONAL_YEARLY_PRICE_ID: z.string().optional(),
  STRIPE_MASTERY_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_MASTERY_YEARLY_PRICE_ID: z.string().optional(),

  // Storage - S3
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),

  // Email
  EMAIL_PROVIDER: z.string().optional().default("resend"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z
    .string()
    .optional()
    .default("Milkly <noreply@milkly.app>"),
  LOOPS_API_KEY: z.string().optional(),
  LOOPS_FROM_EMAIL: z
    .string()
    .optional()
    .default("Milkly <noreply@milkly.app>"),
  SES_REGION: z.string().optional().default("us-east-1"),
  SES_FROM_EMAIL: z
    .string()
    .optional()
    .default("Milkly <newsletter@milkly.email>"),
  SES_CONFIGURATION_SET: z.string().optional(),
  SES_ACCESS_KEY_ID: z.string().optional(),
  SES_SECRET_ACCESS_KEY: z.string().optional(),

  // Style Learning
  STYLE_LEARNING_ENABLED: z
    .string()
    .optional()
    .transform((val) => val !== "false"),

  // Application URLs
  MILKLY_NEWS_URL: z.string().default("https://milkly.news"),
});

/**
 * Validate and parse environment variables
 */
function validateEnv() {
  try {
    const parsed = envSchema.parse(process.env);

    const hasBaseConfig = parsed.AI_PROVIDER && parsed.AI_MODEL;
    const hasHighConfig = parsed.AI_HIGH_PROVIDER && parsed.AI_HIGH_MODEL;
    const hasLowConfig = parsed.AI_LOW_PROVIDER && parsed.AI_LOW_MODEL;

    if (!hasBaseConfig && !hasHighConfig && !hasLowConfig) {
      console.warn(
        "⚠️  No AI configuration found. AI features will be disabled.",
      );
      console.warn(
        "   Set AI_PROVIDER/AI_MODEL or AI_HIGH_*/AI_LOW_* variables.",
      );
    }

    console.log("✅ Environment variables validated successfully");
    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Environment variable validation failed:");
      error.issues.forEach((err) => {
        console.error(`  - ${err.path.join(".")}: ${err.message}`);
      });
      console.error(
        "\nPlease check your .env file and ensure all required variables are set.",
      );
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Validated and typed environment variables
 */
export const env = validateEnv();

/**
 * Type of the validated environment variables
 */
export type Env = z.infer<typeof envSchema>;

/**
 * AI provider type
 */
export type AIProvider = "anthropic" | "openai" | "google";

/**
 * AI configuration for a specific tier
 */
export interface AIConfig {
  provider: AIProvider;
  model: string;
  apiKey: string;
}

/**
 * Get API key for a specific provider
 */
function getProviderApiKey(provider: AIProvider): string | undefined {
  switch (provider) {
    case "google":
      return env.GOOGLE_API_KEY || env.GEMINI_API_KEY;
    case "openai":
      return env.OPENAI_API_KEY;
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    default:
      return undefined;
  }
}

/**
 * Normalize provider name (gemini -> google for consistency)
 */
function normalizeProvider(
  provider: string | undefined,
): AIProvider | undefined {
  if (!provider) return undefined;
  if (provider === "gemini") return "google";
  return provider as AIProvider;
}

/**
 * Get AI configuration for high-end tasks (template generation, content generation)
 * Falls back to base AI config if AI_HIGH_* not set
 */
export function getHighAIConfig(): AIConfig | null {
  const provider = env.AI_HIGH_PROVIDER || normalizeProvider(env.AI_PROVIDER);
  const model = env.AI_HIGH_MODEL || env.AI_MODEL;
  const apiKey =
    env.AI_HIGH_API_KEY ||
    env.AI_API_KEY ||
    (provider ? getProviderApiKey(provider) : undefined);

  if (!provider || !model || !apiKey) {
    return null;
  }

  return { provider, model, apiKey };
}

/**
 * Get AI configuration for low-end tasks (notes, keywords, block regeneration)
 * Falls back to base AI config if AI_LOW_* not set
 */
export function getLowAIConfig(): AIConfig | null {
  const provider = env.AI_LOW_PROVIDER || normalizeProvider(env.AI_PROVIDER);
  const model = env.AI_LOW_MODEL || env.AI_MODEL;
  const apiKey =
    env.AI_LOW_API_KEY ||
    env.AI_API_KEY ||
    (provider ? getProviderApiKey(provider) : undefined);

  if (!provider || !model || !apiKey) {
    return null;
  }

  return { provider, model, apiKey };
}

/**
 * Get AI configuration for a specific tier
 */
export function getAIConfig(tier: "high" | "low"): AIConfig | null {
  return tier === "high" ? getHighAIConfig() : getLowAIConfig();
}
