/**
 * SociaVault Connector
 *
 * Aggregates social media content from multiple platforms via SociaVault API.
 * Orchestrates subconnectors for Threads, Twitter, and Reddit.
 */

import { env } from "../../env";
import { SOCIAVAULT_CONFIG, type SociaVaultConfig } from "../../config";
import {
  BaseConnector,
  type FetchOptions,
  type FetchResult,
  type FetchedContentItem,
} from "../types";
import type { SocialSubConnector } from "./types";
import { logSubConnector } from "./base";
import { threadsSubConnector } from "./threads";
import { twitterSubConnector } from "./twitter";
import { redditSubConnector } from "./reddit";
import { tiktokSubConnector } from "./tiktok";

// ============ Main Connector ============

export class SociaVaultConnector extends BaseConnector {
  readonly id = SOCIAVAULT_CONFIG.id;
  readonly name = SOCIAVAULT_CONFIG.name;
  readonly category = SOCIAVAULT_CONFIG.category;

  private config: SociaVaultConfig = SOCIAVAULT_CONFIG;
  private subConnectors: SocialSubConnector[] = [];

  constructor() {
    super();
    this.registerDefaultSubConnectors();
  }

  private registerDefaultSubConnectors(): void {
    const { platforms } = this.config.api;

    if (platforms.threads.enabled) {
      this.registerSubConnector(threadsSubConnector);
    }
    if (platforms.twitter.enabled) {
      this.registerSubConnector(twitterSubConnector);
    }
    if (platforms.reddit.enabled) {
      this.registerSubConnector(redditSubConnector);
    }
    if (platforms.tiktok.enabled) {
      this.registerSubConnector(tiktokSubConnector);
    }
  }

  registerSubConnector(subConnector: SocialSubConnector): void {
    this.subConnectors.push(subConnector);
    logSubConnector(
      "registry",
      `Registered: ${subConnector.platformName}`,
      "info",
    );
  }

  getConfig(): SociaVaultConfig {
    return this.config;
  }

  isConfigured(): boolean {
    return Boolean(env.SOCIAVAULT_API_KEY);
  }

  async fetch(options: FetchOptions): Promise<FetchResult> {
    if (!this.isConfigured()) {
      this.logInfo("API key not configured, skipping fetch");
      return this.emptyResult("SOCIAVAULT_API_KEY not configured");
    }

    if (this.subConnectors.length === 0) {
      this.logInfo("No subconnectors registered");
      return this.emptyResult("No social platforms configured");
    }

    const apiKey = env.SOCIAVAULT_API_KEY!;
    const baseUrl = env.SOCIAVAULT_API_BASE_URL;

    this.logInfo(
      `Fetching from ${this.subConnectors.length} platforms: ${this.subConnectors.map((c) => c.platform).join(", ")}`,
    );

    try {
      // Fetch from all subconnectors in parallel
      const results = await Promise.all(
        this.subConnectors.map((connector) =>
          connector.fetch(options, apiKey, baseUrl),
        ),
      );

      // Aggregate results
      const allItems: FetchedContentItem[] = [];
      const errors: string[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const connector = this.subConnectors[i]!;

        if (result.error) {
          errors.push(`${connector.platform}: ${result.error}`);
        }
        allItems.push(...result.items);
      }

      // Sort by date (most recent first)
      allItems.sort((a, b) => {
        const dateA = a.publishedAt?.getTime() ?? 0;
        const dateB = b.publishedAt?.getTime() ?? 0;
        return dateB - dateA;
      });

      // Respect count limit
      const count = options.count ?? this.config.defaults.pageSize;
      const limitedItems = allItems.slice(0, count);

      this.logInfo(
        `Fetched ${allItems.length} total items, returning ${limitedItems.length}`,
      );

      if (errors.length > 0) {
        this.logInfo(`Partial errors: ${errors.join("; ")}`);
      }

      return {
        items: limitedItems,
        totalResults: allItems.length,
        hasMore: allItems.length > count,
        error: errors.length > 0 ? errors.join("; ") : undefined,
      };
    } catch (error) {
      this.logError("fetch", error);
      return this.emptyResult(
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }
}

// ============ Singleton Export ============

export const sociavaultConnector = new SociaVaultConnector();

// Re-export types
export * from "./types";
export * from "./base";
