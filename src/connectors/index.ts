/**
 * Content Source Connectors
 *
 * This module provides a clean adapter pattern for content sources.
 *
 * To add a new content source:
 * 1. Create a configuration in src/config/sources.ts
 * 2. Create a connector file implementing ContentConnector
 * 3. Register the connector in registry.ts
 *
 * Example:
 * ```typescript
 * import { connectorRegistry } from "./connectors";
 *
 * // Fetch from specific category
 * const result = await connectorRegistry.fetchCategory("news", {
 *   keywords: ["AI", "machine learning"],
 *   fallbackQuery: "AI News",
 *   count: 10,
 *   sortBy: "date",
 * });
 *
 * // Fetch from multiple categories
 * const allContent = await connectorRegistry.fetchAll({
 *   keywords: ["AI", "machine learning"],
 *   fallbackQuery: "AI News",
 *   categories: ["news", "videos"],
 *   sortBy: "relevancy",
 * });
 * ```
 */

// Types
export type {
  ContentConnector,
  FetchedContentItem,
  FetchOptions,
  FetchResult,
} from "./types";

export { BaseConnector } from "./types";

// Registry
export {
  connectorRegistry,
  fetchAllContent,
  type CategoryFetchDates,
  type AggregatedFetchOptions,
  type AggregatedFetchResult,
  type FetchAllContentResult,
} from "./registry";

// Individual connectors (for direct access if needed)
export { newsApiConnector } from "./news-api";
export { youtubeConnector } from "./youtube";
export { socialMockConnector } from "./social-mock";
export { sociavaultConnector } from "./sociavault";
