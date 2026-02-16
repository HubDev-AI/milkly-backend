/**
 * Content Source Connector - Base Types and Interface
 *
 * Defines the contract that all content source connectors must implement.
 * This enables easy addition of new content sources by implementing this interface.
 */

import type { Category } from "../types";
import type { SourceConfig, SortOption } from "../config";
import {
  logInfo as debugLogInfo,
  logError as debugLogError,
} from "../lib/debug";

// ============ Fetched Content Item ============

export interface FetchedContentItem {
  title: string;
  url: string;
  description: string | null;
  imageUrl: string | null;
  source: string;
  category: Category;
  author: string | null;
  publishedAt: Date | null;
  metadata: Record<string, unknown> | null;
}

// ============ Fetch Options ============

export interface FetchOptions {
  /** Search keywords - will be combined according to API-specific syntax */
  keywords: string[];
  /** Fallback query if no keywords provided (typically stream name) */
  fallbackQuery?: string;
  count?: number;
  sortBy?: SortOption;
  since?: Date;
}

// ============ Fetch Result ============

export interface FetchResult {
  items: FetchedContentItem[];
  totalResults?: number;
  hasMore?: boolean;
  error?: string;
}

// ============ Connector Interface ============

/**
 * Interface that all content source connectors must implement.
 *
 * To add a new content source:
 * 1. Create a new connector class implementing this interface
 * 2. Add configuration in src/config/sources.ts
 * 3. Register the connector in the ConnectorRegistry
 */
export interface ContentConnector {
  /**
   * Unique identifier for this connector
   */
  readonly id: string;

  /**
   * Human-readable name
   */
  readonly name: string;

  /**
   * Category this connector provides content for
   */
  readonly category: Category;

  /**
   * Check if this connector is properly configured and can make requests
   */
  isConfigured(): boolean;

  /**
   * Fetch content from the source
   */
  fetch(options: FetchOptions): Promise<FetchResult>;

  /**
   * Get the connector's configuration
   */
  getConfig(): SourceConfig;
}

// ============ Base Connector Class ============

/**
 * Abstract base class with common functionality for connectors.
 * Extend this class to create new connectors.
 */
export abstract class BaseConnector implements ContentConnector {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly category: Category;

  abstract isConfigured(): boolean;
  abstract fetch(options: FetchOptions): Promise<FetchResult>;
  abstract getConfig(): SourceConfig;

  /**
   * Helper to create an empty result
   */
  protected emptyResult(error?: string): FetchResult {
    return {
      items: [],
      totalResults: 0,
      hasMore: false,
      error,
    };
  }

  /**
   * Helper to create a successful result
   */
  protected successResult(
    items: FetchedContentItem[],
    totalResults?: number,
  ): FetchResult {
    return {
      items,
      totalResults: totalResults ?? items.length,
      hasMore: (totalResults ?? items.length) > items.length,
    };
  }

  /**
   * Helper to log errors consistently
   */
  protected logError(operation: string, error: unknown): void {
    debugLogError(this.id, `${operation} error:`, error);
  }

  /**
   * Helper to log info consistently
   */
  protected logInfo(message: string): void {
    debugLogInfo(this.id, message);
  }
}
