/**
 * SociaVault Base Utilities
 *
 * Shared utilities for SociaVault API calls including
 * HTTP client, error handling, and response validation.
 */

import { logInfo, logError, logWarn } from "../../lib/debug";
import type { SociaVaultErrorResponse } from "./types";

const LOG_PREFIX = "SociaVault";

// ============ API Client ============

export interface ApiRequestOptions {
  endpoint: string;
  params: Record<string, string>;
  apiKey: string;
  baseUrl: string;
}

export interface ApiResponse<T> {
  data: T | null;
  error: string | null;
  status: number;
}

export async function makeApiRequest<T>(
  options: ApiRequestOptions,
): Promise<ApiResponse<T>> {
  const { endpoint, params, apiKey, baseUrl } = options;

  const url = new URL(`${baseUrl}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const debugUrl = new URL(url.toString());
  debugUrl.searchParams.delete("trim"); // Keep for debugging
  logInfo(LOG_PREFIX, `GET ${debugUrl.toString()}`);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({}))) as SociaVaultErrorResponse;
      const errorMessage = getErrorMessage(response.status, errorData);
      logError(LOG_PREFIX, `API error: ${response.status} - ${errorMessage}`);
      return { data: null, error: errorMessage, status: response.status };
    }

    const data = (await response.json()) as T;
    return { data, error: null, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    logError(LOG_PREFIX, `Request failed: ${message}`);
    return { data: null, error: message, status: 0 };
  }
}

function getErrorMessage(
  status: number,
  errorData: SociaVaultErrorResponse,
): string {
  switch (status) {
    case 400:
      return errorData.error || "Invalid request parameters";
    case 401:
      return "Invalid or missing API key";
    case 402:
      return `Insufficient credits (need ${errorData.required ?? "?"}, have ${errorData.available ?? "?"})`;
    case 404:
      return errorData.error || "Resource not found";
    case 429:
      return "Rate limited - try again later";
    case 500:
    case 502:
    case 503:
      return "SociaVault service temporarily unavailable";
    default:
      return errorData.error || `API error: ${status}`;
  }
}

// ============ Retry Logic ============

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  retryableStatuses?: number[];
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  retryableStatuses: [500, 502, 503, 504],
};

export async function makeApiRequestWithRetry<T>(
  options: ApiRequestOptions,
  retryOptions: RetryOptions = {},
): Promise<ApiResponse<T>> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };

  let lastResponse: ApiResponse<T> | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = opts.baseDelayMs * Math.pow(2, attempt - 1);
      logWarn(
        LOG_PREFIX,
        `Retry ${attempt}/${opts.maxRetries} after ${delay}ms`,
      );
      await sleep(delay);
    }

    const response = await makeApiRequest<T>(options);
    lastResponse = response;

    if (response.error === null) {
      return response;
    }

    if (!opts.retryableStatuses.includes(response.status)) {
      return response;
    }
  }

  return lastResponse!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============ Logging Utilities ============

export function logSubConnector(
  platform: string,
  message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  const prefix = `${LOG_PREFIX}:${platform}`;
  switch (level) {
    case "warn":
      logWarn(prefix, message);
      break;
    case "error":
      logError(prefix, message);
      break;
    default:
      logInfo(prefix, message);
  }
}

// ============ Query Building ============

export function buildKeywordQuery(
  keywords: string[],
  fallbackQuery?: string,
): string {
  if (keywords.length === 0) {
    return fallbackQuery ?? "";
  }
  return keywords.join(" ");
}

export function filterByKeywords<T>(
  items: T[],
  keywords: string[],
  getText: (item: T) => string,
): T[] {
  if (keywords.length === 0) return items;

  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  return items.filter((item) => {
    const text = getText(item).toLowerCase();
    return lowerKeywords.some((keyword) => text.includes(keyword));
  });
}
