/**
 * Connector Registry
 *
 * Central registry for all content source connectors.
 * Provides methods to fetch content from multiple sources.
 */

import type { Category } from "../types";
import type { SortOption } from "../config";
import type {
  ContentConnector,
  FetchedContentItem,
  FetchOptions,
  FetchResult,
} from "./types";
import { SOURCES_BY_CATEGORY } from "../config/sources";
import { getResultsPerRefresh, type TierName } from "../config/tiers";
import { logInfo, logWarn } from "../lib/debug";

import { env } from "../env";
import { newsApiConnector } from "./news-api";
import { youtubeConnector } from "./youtube";
import { socialMockConnector } from "./social-mock";
import { sociavaultConnector } from "./sociavault";

// ============ Category Fetch Dates ============

export interface CategoryFetchDates {
  news?: Date;
  videos?: Date;
  social?: Date;
}

// ============ Aggregated Fetch Options ============

export interface AggregatedFetchOptions {
  /** Keywords for search - each connector will format according to API spec */
  keywords: string[];
  /** Fallback query if no keywords (typically stream name) */
  fallbackQuery?: string;
  categories: Category[];
  count?: number;
  sortBy?: SortOption;
  sinceByCategory?: CategoryFetchDates;
  /** User's subscription tier - used to calculate fetch count per source */
  tier?: TierName;
}

// ============ Aggregated Fetch Result ============

export interface AggregatedFetchResult {
  items: FetchedContentItem[];
  byCategory: Record<Category, FetchResult>;
  errors: string[];
}

// ============ Connector Registry Class ============

class ConnectorRegistry {
  private connectors: Map<Category, ContentConnector> = new Map();

  constructor() {
    // Register all connectors
    this.register(newsApiConnector);
    this.register(youtubeConnector);

    // Use SociaVault for social content when API key is available, otherwise fall back to mock
    if (env.SOCIAVAULT_API_KEY) {
      this.register(sociavaultConnector);
    } else {
      this.register(socialMockConnector);
    }
  }

  /**
   * Register a new connector
   */
  register(connector: ContentConnector): void {
    this.connectors.set(connector.category, connector);
    logInfo(
      "ConnectorRegistry",
      `Registered: ${connector.name} (${connector.category})`,
    );
  }

  /**
   * Get a connector by category
   */
  get(category: Category): ContentConnector | undefined {
    return this.connectors.get(category);
  }

  /**
   * Get all registered connectors
   */
  getAll(): ContentConnector[] {
    return Array.from(this.connectors.values());
  }

  /**
   * Get all configured (ready to use) connectors
   */
  getConfigured(): ContentConnector[] {
    return this.getAll().filter((c) => c.isConfigured());
  }

  /**
   * Fetch content from a single category
   */
  async fetchCategory(
    category: Category,
    options: FetchOptions,
  ): Promise<FetchResult> {
    const connector = this.connectors.get(category);

    if (!connector) {
      logWarn("ConnectorRegistry", `No connector for category: ${category}`);
      return { items: [], error: `No connector for category: ${category}` };
    }

    if (!connector.isConfigured()) {
      logWarn(
        "ConnectorRegistry",
        `Connector not configured: ${connector.name}`,
      );
      return { items: [], error: `${connector.name} not configured` };
    }

    return connector.fetch(options);
  }

  /**
   * Fetch content from multiple categories in parallel
   */
  async fetchAll(
    options: AggregatedFetchOptions,
  ): Promise<AggregatedFetchResult> {
    const {
      keywords,
      fallbackQuery,
      categories,
      count,
      sortBy,
      sinceByCategory,
      tier,
    } = options;

    logInfo(
      "ConnectorRegistry",
      `Fetching from categories: ${categories.join(", ")}`,
    );
    logInfo(
      "ConnectorRegistry",
      `Keywords: ${keywords.length > 0 ? keywords.join(", ") : "(none, using fallback)"}`,
    );
    if (tier) {
      logInfo("ConnectorRegistry", `Tier: ${tier}`);
    }

    // Create fetch promises for each category
    const fetchPromises = categories.map(
      async (category): Promise<[Category, FetchResult]> => {
        const since = sinceByCategory?.[category as keyof CategoryFetchDates];
        const connector = this.connectors.get(category);

        if (!connector || !connector.isConfigured()) {
          return [
            category,
            {
              items: [],
              error: connector
                ? `${connector.name} not configured`
                : `No connector for ${category}`,
            },
          ];
        }

        // Calculate fetch count based on tier's resultsPerRefresh
        let fetchCount = count;
        if (tier && !count) {
          fetchCount = getResultsPerRefresh(tier);
          logInfo(
            "ConnectorRegistry",
            `${category}: fetching ${fetchCount} items (${tier} tier)`,
          );
        }

        const result = await connector.fetch({
          keywords,
          fallbackQuery,
          count: fetchCount,
          sortBy,
          since,
        });

        return [category, result];
      },
    );

    // Execute all fetches in parallel
    const results = await Promise.all(fetchPromises);

    // Aggregate results
    const items: FetchedContentItem[] = [];
    const byCategory: Record<Category, FetchResult> = {} as Record<
      Category,
      FetchResult
    >;
    const errors: string[] = [];

    for (const [category, result] of results) {
      byCategory[category] = result;
      items.push(...result.items);

      if (result.error) {
        errors.push(`${category}: ${result.error}`);
      }
    }

    logInfo("ConnectorRegistry", `Total fetched: ${items.length} items`);
    if (errors.length > 0) {
      logWarn("ConnectorRegistry", `Errors: ${errors.join(", ")}`);
    }

    return { items, byCategory, errors };
  }
}

// ============ Singleton Export ============

export const connectorRegistry = new ConnectorRegistry();

// ============ Convenience Functions ============

export interface FetchAllContentResult {
  items: FetchedContentItem[];
  allCategoriesFailed: boolean;
  errors: string[];
}

/**
 * Fetch content from all specified categories
 * @param keywords - Array of keywords for search
 * @param fallbackQuery - Fallback query if no keywords (typically stream name)
 * @param categories - Categories to fetch from
 * @param sinceByCategory - Optional date filters per category
 * @param sortBy - Sort option
 * @param tier - User's subscription tier for calculating fetch count
 */
export async function fetchAllContent(
  keywords: string[],
  fallbackQuery: string,
  categories: Category[],
  sinceByCategory?: CategoryFetchDates,
  sortBy?: SortOption,
  tier?: TierName,
): Promise<FetchAllContentResult> {
  const result = await connectorRegistry.fetchAll({
    keywords,
    fallbackQuery,
    categories,
    sortBy,
    sinceByCategory,
    tier,
  });

  // Check if all categories failed (have errors and no items)
  const allCategoriesFailed =
    categories.length > 0 &&
    result.errors.length === categories.length &&
    result.items.length === 0;

  return {
    items: result.items,
    allCategoriesFailed,
    errors: result.errors,
  };
}
