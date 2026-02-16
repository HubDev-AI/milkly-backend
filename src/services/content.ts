import { env } from "../env";
import type { Category } from "../types";
import {
  NEWS_API,
  YOUTUBE_API,
  SOCIAL_CONTENT,
  SOCIAL_SOURCES,
  SOCIAL_HANDLES,
  CATEGORIES,
} from "../constants";
import { logWarn, logError } from "../lib/debug";

// Content item type for API responses
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

// News API types
interface NewsAPIArticle {
  title: string;
  url: string;
  description: string | null;
  urlToImage: string | null;
  source: { name: string };
  author: string | null;
  publishedAt: string;
}

interface NewsAPIResponse {
  status: string;
  totalResults: number;
  articles: NewsAPIArticle[];
}

// YouTube API types
interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    title: string;
    description: string;
    thumbnails: {
      high: { url: string };
      medium: { url: string };
    };
    channelTitle: string;
    publishedAt: string;
  };
}

interface YouTubeSearchResponse {
  items: YouTubeSearchItem[];
}

/**
 * Fetch news articles from News API
 * @param since - Only fetch articles published after this date
 */
export async function fetchNewsContent(
  query: string,
  count: number = NEWS_API.DEFAULT_PAGE_SIZE,
  since?: Date,
): Promise<FetchedContentItem[]> {
  if (!env.NEWS_API_KEY) {
    logWarn("NewsAPI", "NEWS_API_KEY not configured, skipping news fetch");
    return [];
  }

  try {
    const url = new URL(`${env.NEWS_API_BASE_URL}/everything`);
    url.searchParams.set("q", query);
    url.searchParams.set("apiKey", env.NEWS_API_KEY);
    url.searchParams.set("pageSize", String(count));
    url.searchParams.set("sortBy", NEWS_API.SORT_BY);
    url.searchParams.set("language", NEWS_API.LANGUAGE);

    // Only fetch articles from the since date if provided
    if (since) {
      url.searchParams.set("from", since.toISOString());
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      logError("NewsAPI", "API error:", response.status, await response.text());
      return [];
    }

    const data = (await response.json()) as NewsAPIResponse;

    if (data.status !== "ok" || !data.articles) {
      logError("NewsAPI", "Returned invalid data:", data);
      return [];
    }

    return data.articles
      .filter(
        (article) =>
          article.title && article.url && article.title !== "[Removed]",
      )
      .map((article) => ({
        title: article.title,
        url: article.url,
        description: article.description,
        imageUrl: article.urlToImage,
        source: article.source.name.toLowerCase().replace(/\s+/g, "-"),
        category: CATEGORIES.NEWS as Category,
        author: article.author,
        publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
        metadata: {
          sourceName: article.source.name,
        },
      }));
  } catch (error) {
    logError("NewsAPI", "Error fetching news:", error);
    return [];
  }
}

/**
 * Fetch videos from YouTube API
 * @param since - Only fetch videos published after this date
 */
export async function fetchVideoContent(
  query: string,
  count: number = YOUTUBE_API.DEFAULT_MAX_RESULTS,
  since?: Date,
): Promise<FetchedContentItem[]> {
  if (!env.YOUTUBE_API_KEY) {
    logWarn("YouTube", "YOUTUBE_API_KEY not configured, skipping video fetch");
    return [];
  }

  try {
    const url = new URL(`${env.YOUTUBE_API_BASE_URL}/search`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", query);
    url.searchParams.set("key", env.YOUTUBE_API_KEY);
    url.searchParams.set("maxResults", String(count));
    url.searchParams.set("type", YOUTUBE_API.TYPE);
    url.searchParams.set("order", YOUTUBE_API.ORDER);
    url.searchParams.set("relevanceLanguage", YOUTUBE_API.RELEVANCE_LANGUAGE);

    // Only fetch videos from the since date if provided
    if (since) {
      url.searchParams.set("publishedAfter", since.toISOString());
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      logError("YouTube", "API error:", response.status, await response.text());
      return [];
    }

    const data = (await response.json()) as YouTubeSearchResponse;

    if (!data.items) {
      logError("YouTube", "Returned invalid data:", data);
      return [];
    }

    return data.items
      .filter((item) => item.id.videoId && item.snippet.title)
      .map((item) => ({
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        description: item.snippet.description || null,
        imageUrl:
          item.snippet.thumbnails.high?.url ||
          item.snippet.thumbnails.medium?.url ||
          null,
        source: "youtube",
        category: CATEGORIES.VIDEOS as Category,
        author: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt
          ? new Date(item.snippet.publishedAt)
          : null,
        metadata: {
          videoId: item.id.videoId,
          channelTitle: item.snippet.channelTitle,
        },
      }));
  } catch (error) {
    logError("YouTube", "Error fetching videos:", error);
    return [];
  }
}

// Social post templates
const SOCIAL_TEMPLATES = [
  (streamName: string) =>
    `🔥 Just discovered something amazing about ${streamName}! Here's what you need to know...`,
  (streamName: string) =>
    `Hot take: ${streamName} is going to change everything in 2025. Here's why... 🧵`,
  (streamName: string) =>
    `The ${streamName} community is buzzing today! Check out these updates...`,
  (streamName: string) => `Unpopular opinion about ${streamName}: Thread 👇`,
  (streamName: string) =>
    `${streamName} tip of the day that saved me hours of work ⚡`,
  (streamName: string) => `Breaking: Major ${streamName} news just dropped! 📢`,
  (streamName: string) =>
    `Why everyone in ${streamName} is talking about this right now...`,
  (streamName: string) =>
    `${streamName} deep dive: What I learned after 100 hours of research 🔍`,
  (streamName: string) =>
    `This ${streamName} hack is absolutely game-changing 🚀`,
  (streamName: string) =>
    `Controversial ${streamName} opinion: Am I wrong? Let's discuss...`,
  (streamName: string) => `${streamName} trends to watch in 2025 📈`,
  (streamName: string) =>
    `Just published my thoughts on ${streamName} - link in bio`,
];

/**
 * Generate mock social content (no free API available)
 * In production, this would use Twitter/X API, Reddit API, etc.
 */
export function generateSocialContent(
  streamName: string,
  count: number = SOCIAL_CONTENT.DEFAULT_COUNT,
): FetchedContentItem[] {
  const IMAGE_FREQUENCY = 4; // Show image every N posts

  return Array.from({ length: count }, (_, i) => {
    const sourceInfo = SOCIAL_SOURCES[i % SOCIAL_SOURCES.length]!;
    const template = SOCIAL_TEMPLATES[i % SOCIAL_TEMPLATES.length]!;
    const handle = SOCIAL_HANDLES[i % SOCIAL_HANDLES.length]!;
    const hoursAgo =
      Math.floor(Math.random() * SOCIAL_CONTENT.MAX_HOURS_AGO) + 1;

    return {
      title: template(streamName),
      url: `https://${sourceInfo.id === "reddit" ? "reddit" : sourceInfo.id}.com/post/${streamName.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}-${i}`,
      description: null,
      imageUrl:
        i % IMAGE_FREQUENCY === 0
          ? `https://picsum.photos/seed/${streamName}-social-${i}/600/400`
          : null,
      source: sourceInfo.id,
      category: CATEGORIES.SOCIAL as Category,
      author: handle,
      publishedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      metadata: {
        likes: Math.floor(Math.random() * 15000) + 50,
        reposts: Math.floor(Math.random() * 2000) + 10,
        comments: Math.floor(Math.random() * 800) + 5,
        platform: sourceInfo.name,
      },
    };
  });
}

// Type for tracking last fetch dates per category
export interface CategoryFetchDates {
  news?: Date;
  videos?: Date;
  social?: Date;
}

/**
 * Fetch all content for a stream based on its categories
 * @param sinceByCategory - Optional dates per category to only fetch new content
 */
export async function fetchAllContent(
  streamName: string,
  categories: Category[],
  sinceByCategory?: CategoryFetchDates,
): Promise<FetchedContentItem[]> {
  const results: FetchedContentItem[] = [];
  const fetchPromises: Promise<FetchedContentItem[]>[] = [];

  if (categories.includes(CATEGORIES.NEWS)) {
    fetchPromises.push(
      fetchNewsContent(
        streamName,
        NEWS_API.DEFAULT_PAGE_SIZE,
        sinceByCategory?.news,
      ),
    );
  }

  if (categories.includes(CATEGORIES.VIDEOS)) {
    fetchPromises.push(
      fetchVideoContent(
        streamName,
        YOUTUBE_API.DEFAULT_MAX_RESULTS,
        sinceByCategory?.videos,
      ),
    );
  }

  // Execute API fetches in parallel
  const apiResults = await Promise.all(fetchPromises);
  for (const items of apiResults) {
    results.push(...items);
  }

  // Add social content (generated since no free API)
  if (categories.includes(CATEGORIES.SOCIAL)) {
    results.push(
      ...generateSocialContent(streamName, SOCIAL_CONTENT.DEFAULT_COUNT),
    );
  }

  return results;
}
