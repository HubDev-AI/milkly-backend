import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { createDebugger, logError } from "../lib/debug";

const debug = createDebugger("CONTENT-EXTRACTOR");

const FETCH_TIMEOUT_MS = 8000;
const MAX_TEXT_LENGTH = 5000;
const MAX_CONCURRENCY = 5;
const MAX_HTML_SIZE = 2 * 1024 * 1024; // 2MB

export interface ExtractedContent {
  title: string | null;
  textContent: string | null;
  excerpt: string | null;
  byline: string | null;
  siteName: string | null;
  publishedTime: string | null;
}

export interface EnrichedItem {
  id: string;
  title: string;
  url: string;
  source: string;
  category: string;
  description: string | null;
  author: string | null;
  publishedAt: Date | null;
  extractedContent: ExtractedContent | null;
}

async function fetchAndExtract(url: string): Promise<ExtractedContent | null> {
  if (!url || url === "") return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Milkly/1.0; +https://milkly.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      debug(`HTTP ${response.status} for ${url}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("xhtml")) {
      debug(`Non-HTML content type for ${url}: ${contentType}`);
      return null;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_HTML_SIZE) {
      debug(`Page too large for ${url}: ${contentLength} bytes`);
      return null;
    }

    const html = await response.text();
    if (html.length > MAX_HTML_SIZE) {
      debug(`HTML too large for ${url}: ${html.length} chars`);
      return null;
    }

    const { document } = parseHTML(html);
    const reader = new Readability(document as unknown as Document, {
      charThreshold: 100,
    });
    const article = reader.parse();

    if (!article || !article.textContent) {
      debug(`Readability returned no content for ${url}`);
      return null;
    }

    const textContent = article.textContent
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, MAX_TEXT_LENGTH);

    return {
      title: article.title || null,
      textContent,
      excerpt: article.excerpt || null,
      byline: article.byline || null,
      siteName: article.siteName || null,
      publishedTime: article.publishedTime || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("abort")) {
      debug(`Timeout fetching ${url}`);
    } else {
      debug(`Error extracting content from ${url}: ${message}`);
    }
    return null;
  }
}

async function processWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex]!);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

interface ContentItemLike {
  id: string;
  title: string;
  url: string;
  source: string;
  category: string;
  description: string | null;
  author: string | null;
  publishedAt: Date | null;
}

export async function enrichItemsWithContent(
  items: ContentItemLike[],
): Promise<EnrichedItem[]> {
  debug(`Enriching ${items.length} items with URL content`);
  const startTime = Date.now();

  const extractedContents = await processWithConcurrency(
    items,
    (item) => fetchAndExtract(item.url),
    MAX_CONCURRENCY,
  );

  const enriched = items.map((item, i) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
    category: item.category,
    description: item.description,
    author: item.author,
    publishedAt: item.publishedAt,
    extractedContent: extractedContents[i] ?? null,
  }));

  const successCount = extractedContents.filter(Boolean).length;
  debug(
    `Enrichment complete: ${successCount}/${items.length} URLs extracted in ${Date.now() - startTime}ms`,
  );

  return enriched;
}
