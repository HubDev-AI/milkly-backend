import { prisma } from "../prisma";
import { fetchAllContent, type CategoryFetchDates } from "../connectors";
import {
  parseCategories,
  parseKeywords,
  parseMetadata,
  SortOptionSchema,
  type Category,
  type ContentItem,
  type RefreshResult,
  type SortOption,
} from "../types";
import { filterCategoriesForTier, getTierLimits } from "../config/tiers";
import {
  getUserTier,
  checkUsageLimit,
  incrementUsage,
} from "../middleware/tier-limits";
import { createId } from "@paralleldrive/cuid2";
import { createDebugger, logError } from "../lib/debug";

const debug = createDebugger("REFRESH");

// Transform DB content item to API content item
export function transformContentItem(dbItem: {
  id: string;
  title: string;
  url: string;
  description: string | null;
  imageUrl: string | null;
  source: string;
  category: string;
  author: string | null;
  publishedAt: Date | null;
  metadata: string | null;
  streamId: string;
  createdAt: Date;
  batchId: string | null;
  fetchedAt: Date;
  isCustomItem?: boolean;
}): ContentItem {
  return {
    id: dbItem.id,
    title: dbItem.title,
    url: dbItem.url,
    description: dbItem.description,
    imageUrl: dbItem.imageUrl,
    rawImageUrl: dbItem.imageUrl, // Keep original for editing (media:// refs)
    source: dbItem.source,
    category: dbItem.category as Category,
    author: dbItem.author,
    publishedAt: dbItem.publishedAt,
    metadata: parseMetadata(dbItem.metadata),
    streamId: dbItem.streamId,
    createdAt: dbItem.createdAt,
    batchId: dbItem.batchId,
    fetchedAt: dbItem.fetchedAt,
    isCustomItem: dbItem.isCustomItem ?? false,
  };
}

interface RefreshStreamParams {
  streamId: string;
  userId: string;
  sortBy?: string;
  category?: Category; // Optional: refresh only this category
  skipUsageCheck?: boolean;
  skipUsageIncrement?: boolean;
}

interface RefreshStreamResult {
  success: boolean;
  streamId: string;
  streamName: string;
  refreshed: number;
  batchId: string | null;
  error?: string;
  items?: ContentItem[];
}

/**
 * Refresh content for a single stream
 * This is the core refresh logic used by both stream refresh and linked stream refresh
 */
export async function refreshStream(
  params: RefreshStreamParams,
): Promise<RefreshStreamResult> {
  const {
    streamId,
    userId,
    sortBy = "date",
    category: specificCategory,
    skipUsageCheck = false,
    skipUsageIncrement = false,
  } = params;

  debug(
    `refreshStream: streamId=${streamId}, userId=${userId}, sortBy=${sortBy}, category=${specificCategory ?? "all"}`,
  );

  // Check stream ownership (select only needed fields to reduce data transfer)
  const stream = await prisma.stream.findFirst({
    where: {
      id: streamId,
      userId,
    },
    select: {
      id: true,
      name: true,
      categories: true,
      keywords: true,
      lastBatchIdsByCategory: true,
    },
  });

  if (!stream) {
    debug(`refreshStream: stream not found for streamId=${streamId}`);
    return {
      success: false,
      streamId,
      streamName: "Unknown",
      refreshed: 0,
      batchId: null,
      error: "Stream not found",
    };
  }

  debug(`refreshStream: found stream name="${stream.name}"`);

  // Check usage limit if not skipped
  if (!skipUsageCheck) {
    debug(`refreshStream: checking usage limit for userId=${userId}`);
    const usageCheck = await checkUsageLimit(userId, "refresh");
    if (!usageCheck.allowed) {
      debug(`refreshStream: usage limit exceeded for userId=${userId}`);
      return {
        success: false,
        streamId,
        streamName: stream.name,
        refreshed: 0,
        batchId: null,
        error: `Refresh limit reached. You have used ${usageCheck.current} of ${usageCheck.limit} refreshes this period.`,
      };
    }
  }

  // Get stream categories and filter to only tier-allowed ones
  const userTier = await getUserTier(userId);
  const streamCategories = parseCategories(stream.categories);
  let categories = filterCategoriesForTier(streamCategories, userTier);
  debug(
    `refreshStream: userTier=${userTier}, streamCategories=[${streamCategories.join(",")}], filteredCategories=[${categories.join(",")}]`,
  );

  // If a specific category was requested, only fetch that one
  if (specificCategory) {
    if (categories.includes(specificCategory)) {
      debug(
        `refreshStream: filtering to specific category=${specificCategory}`,
      );
      categories = [specificCategory];
    } else {
      debug(
        `refreshStream: category="${specificCategory}" not available for stream`,
      );
      return {
        success: false,
        streamId,
        streamName: stream.name,
        refreshed: 0,
        batchId: null,
        error: `Category "${specificCategory}" not available for this stream`,
      };
    }
  }

  // If no categories are allowed after filtering, return an error
  if (categories.length === 0) {
    debug(`refreshStream: no categories available for tier=${userTier}`);
    return {
      success: false,
      streamId,
      streamName: stream.name,
      refreshed: 0,
      batchId: null,
      error: "Stream uses categories not available on your current plan",
    };
  }

  // Generate a unique batch ID for this refresh
  const batchId = createId();
  const fetchedAt = new Date();
  debug(`refreshStream: created batchId=${batchId}`);

  try {
    // Get the last fetch dates per category
    const fetchHistory = await prisma.streamFetchHistory.findMany({
      where: { streamId },
    });

    // Build the since dates object
    const sinceByCategory: CategoryFetchDates = {};
    for (const history of fetchHistory) {
      if (
        history.category === "news" ||
        history.category === "videos" ||
        history.category === "social"
      ) {
        sinceByCategory[history.category as keyof CategoryFetchDates] =
          history.lastFetchAt;
      }
    }
    debug(
      `refreshStream: fetchHistory count=${fetchHistory.length}, sinceByCategory=${JSON.stringify(sinceByCategory)}`,
    );

    // Parse keywords for the stream
    const keywords = parseKeywords(stream.keywords);
    debug(`refreshStream: keywords=[${keywords.join(",")}]`);

    // Fetch real content from APIs
    const validatedSortBy = SortOptionSchema.safeParse(sortBy).success
      ? (sortBy as SortOption)
      : undefined;
    debug(
      `refreshStream: calling fetchAllContent for categories=[${categories.join(",")}], sortBy=${validatedSortBy ?? "default"}`,
    );
    const fetchResult = await fetchAllContent(
      keywords,
      stream.name,
      categories,
      sinceByCategory,
      validatedSortBy,
      userTier,
    );
    const fetchedItems = fetchResult.items;
    debug(
      `refreshStream: fetchAllContent returned ${fetchedItems.length} items, allCategoriesFailed=${fetchResult.allCategoriesFailed}`,
    );

    // If all categories failed, don't count this as a refresh
    if (fetchResult.allCategoriesFailed) {
      debug(
        `refreshStream: all categories failed, not counting as refresh. Errors: ${fetchResult.errors.join("; ")}`,
      );
      return {
        success: false,
        streamId,
        streamName: stream.name,
        refreshed: 0,
        batchId: null,
        error: `All content sources failed: ${fetchResult.errors.join("; ")}`,
      };
    }

    // Get existing URLs to avoid duplicates
    const existingItems = await prisma.contentItem.findMany({
      where: { streamId },
      select: { url: true },
    });
    const existingUrls = new Set(existingItems.map((item) => item.url));

    // Filter out items that already exist
    const newItems = fetchedItems.filter((item) => !existingUrls.has(item.url));
    const duplicateCount = fetchedItems.length - newItems.length;
    debug(
      `refreshStream: existingUrls=${existingUrls.size}, duplicates=${duplicateCount}, newItems=${newItems.length}`,
    );

    // Insert only new items with batchId using batch insert
    const itemsToCreate = newItems.map((item) => ({
      title: item.title,
      url: item.url,
      description: item.description,
      imageUrl: item.imageUrl,
      source: item.source,
      category: item.category,
      author: item.author,
      publishedAt: item.publishedAt,
      metadata: item.metadata ? JSON.stringify(item.metadata) : null,
      streamId,
      batchId,
      fetchedAt,
    }));

    debug(
      `refreshStream: saving ${itemsToCreate.length} items to database with batchId=${batchId}`,
    );
    await prisma.contentItem.createMany({ data: itemsToCreate });

    // Fetch created items for response (createMany doesn't return records)
    const createdItems =
      itemsToCreate.length > 0
        ? await prisma.contentItem.findMany({
            where: { batchId, streamId },
          })
        : [];

    debug(`refreshStream: created ${createdItems.length} items in database`);

    // Update fetch history for each category using a transaction for batch upserts
    debug(
      `refreshStream: updating fetch history for categories=[${categories.join(",")}]`,
    );
    await prisma.$transaction(
      categories.map((category) =>
        prisma.streamFetchHistory.upsert({
          where: {
            streamId_category: {
              streamId,
              category,
            },
          },
          update: {
            lastFetchAt: fetchedAt,
          },
          create: {
            streamId,
            category,
            lastFetchAt: fetchedAt,
          },
        }),
      ),
    );

    // Update stream with last milk info
    // Get existing batch IDs by category
    const existingBatchIds = stream.lastBatchIdsByCategory
      ? JSON.parse(stream.lastBatchIdsByCategory)
      : {};

    // Update batch IDs for the categories that were just fetched
    if (createdItems.length > 0) {
      for (const category of categories) {
        existingBatchIds[category] = batchId;
      }
      debug(
        `refreshStream: updating batch IDs for categories=[${categories.join(",")}]`,
      );
    }

    debug(`refreshStream: updating stream lastMilkedAt and batch info`);
    await prisma.stream.update({
      where: { id: streamId },
      data: {
        lastMilkedAt: fetchedAt,
        lastBatchId: createdItems.length > 0 ? batchId : null, // Keep for backward compatibility
        lastBatchIdsByCategory: JSON.stringify(existingBatchIds),
      },
    });

    // Increment refresh usage if not skipped
    if (!skipUsageIncrement) {
      debug(`refreshStream: incrementing usage for userId=${userId}`);
      await incrementUsage(userId, "refresh");
    }

    debug(
      `refreshStream: completed successfully, refreshed=${createdItems.length}, batchId=${createdItems.length > 0 ? batchId : "null"}`,
    );
    return {
      success: true,
      streamId,
      streamName: stream.name,
      refreshed: createdItems.length,
      batchId: createdItems.length > 0 ? batchId : null,
      items: createdItems.map(transformContentItem),
    };
  } catch (error) {
    logError("REFRESH", `Error refreshing stream ${stream.name}:`, error);
    return {
      success: false,
      streamId,
      streamName: stream.name,
      refreshed: 0,
      batchId: null,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

interface RefreshLinkedStreamParams {
  linkedStreamId: string;
  userId: string;
  sortBy?: string;
  category?: Category; // Optional: refresh only this category across all linked streams
}

interface RefreshLinkedStreamResult {
  refreshed: number;
  streamsRefreshed: number;
  streamsFailed: number;
  errors?: string[];
  results: RefreshResult[];
}

/**
 * Refresh all streams in a linked stream
 * Each stream refresh counts as a separate milk operation for usage tracking
 */
export async function refreshLinkedStream(
  params: RefreshLinkedStreamParams,
): Promise<RefreshLinkedStreamResult> {
  const {
    linkedStreamId,
    userId,
    sortBy = "date",
    category: specificCategory,
  } = params;

  debug(
    `refreshLinkedStream: linkedStreamId=${linkedStreamId}, userId=${userId}, sortBy=${sortBy}, category=${specificCategory ?? "all"}`,
  );

  // Get linked stream with stream links
  const linkedStream = await prisma.linkedStream.findFirst({
    where: {
      id: linkedStreamId,
      userId,
    },
    include: {
      members: {
        orderBy: { order: "asc" },
      },
    },
  });

  if (!linkedStream) {
    debug(
      `refreshLinkedStream: linked stream not found for id=${linkedStreamId}`,
    );
    throw new Error("Linked stream not found");
  }

  debug(
    `refreshLinkedStream: found linked stream with ${linkedStream.members.length} member streams`,
  );

  // Get stream details for category filtering (if a specific category is requested)
  let streamsToRefresh = linkedStream.members;
  if (specificCategory) {
    // Fetch stream details to check their categories
    const streamIds = linkedStream.members.map((m) => m.streamId);
    const streams = await prisma.stream.findMany({
      where: { id: { in: streamIds } },
      select: { id: true, categories: true },
    });

    // Create a map of streamId -> categories
    const streamCategoriesMap = new Map(
      streams.map((s) => [s.id, parseCategories(s.categories)]),
    );

    // Filter to only streams that have the requested category
    streamsToRefresh = linkedStream.members.filter((link) => {
      const categories = streamCategoriesMap.get(link.streamId) ?? [];
      return categories.includes(specificCategory);
    });
    debug(
      `refreshLinkedStream: filtered to ${streamsToRefresh.length} streams with category=${specificCategory}`,
    );
  }

  const results: RefreshResult[] = [];
  let totalRefreshed = 0;
  const errors: string[] = [];
  const batchIds: string[] = [];

  // Get stream count for usage check (only count streams we'll actually refresh)
  const streamCount = streamsToRefresh.length;

  // If no streams support the requested category, return early with success (nothing to refresh)
  if (streamCount === 0) {
    debug(`refreshLinkedStream: no streams to refresh (streamCount=0)`);
    return {
      refreshed: 0,
      streamsRefreshed: 0,
      streamsFailed: 0,
      results: [],
    };
  }

  debug(`refreshLinkedStream: preparing to refresh ${streamCount} streams`);

  // Check if user has enough refresh quota for all streams
  debug(
    `refreshLinkedStream: checking usage limits for ${streamCount} streams`,
  );
  for (let i = 0; i < streamCount; i++) {
    const usageCheck = await checkUsageLimit(userId, "refresh");
    if (!usageCheck.allowed) {
      debug(
        `refreshLinkedStream: usage limit exceeded at stream ${i + 1}/${streamCount}`,
      );
      throw new Error(
        `Not enough refresh quota: You have used ${usageCheck.current} of ${usageCheck.limit} refreshes this period.`,
      );
    }
  }

  // Refresh each stream that has the requested category
  debug(
    `refreshLinkedStream: starting refresh loop for ${streamsToRefresh.length} streams`,
  );
  for (const link of streamsToRefresh) {
    debug(
      `refreshLinkedStream: refreshing member stream streamId=${link.streamId}`,
    );
    const result = await refreshStream({
      streamId: link.streamId,
      userId,
      sortBy,
      category: specificCategory, // Pass through category filter
      skipUsageCheck: true, // We already checked above
      skipUsageIncrement: false, // Still increment for each stream
    });

    results.push({
      streamId: result.streamId,
      streamName: result.streamName,
      refreshed: result.refreshed,
      batchId: result.batchId || "",
      error: result.error,
    });

    totalRefreshed += result.refreshed;
    if (result.error) {
      debug(
        `refreshLinkedStream: stream ${result.streamName} failed: ${result.error}`,
      );
      errors.push(`${result.streamName}: ${result.error}`);
    } else {
      debug(
        `refreshLinkedStream: stream ${result.streamName} refreshed=${result.refreshed}, batchId=${result.batchId ?? "null"}`,
      );
    }

    // Collect batch IDs (only non-empty ones)
    if (result.batchId) {
      batchIds.push(result.batchId);
    }
  }

  debug(
    `refreshLinkedStream: refresh loop complete, totalRefreshed=${totalRefreshed}, batchIds=${batchIds.length}`,
  );

  // Update linked stream's last milk info
  // Get existing batch IDs by category
  const existingBatchIdsByCategory = linkedStream.lastBatchIdsByCategory
    ? JSON.parse(linkedStream.lastBatchIdsByCategory)
    : {};

  // Update batch IDs for the category that was just fetched
  if (specificCategory && batchIds.length > 0) {
    // For category-specific refresh, store all batch IDs for that category
    debug(
      `refreshLinkedStream: storing ${batchIds.length} batch IDs for category=${specificCategory}`,
    );
    existingBatchIdsByCategory[specificCategory] = batchIds;
  } else if (!specificCategory && batchIds.length > 0) {
    debug(
      `refreshLinkedStream: building category -> batch IDs mapping for all categories`,
    );
    // For "all" refresh, collect batch IDs from each stream by category
    // Get the streams that were just refreshed to see what categories each one updated
    const streamIds = streamsToRefresh.map((s) => s.streamId);
    const refreshedStreams = await prisma.stream.findMany({
      where: { id: { in: streamIds } },
      select: { id: true, categories: true, lastBatchIdsByCategory: true },
    });

    // Build category -> batch IDs mapping
    const categoriesBatchMap: Record<string, string[]> = {};

    for (const stream of refreshedStreams) {
      // Parse the stream's categories (JSON array stored as string)
      const streamCategories: string[] = stream.categories
        ? JSON.parse(stream.categories)
        : [];
      const streamBatchIds = stream.lastBatchIdsByCategory
        ? JSON.parse(stream.lastBatchIdsByCategory)
        : {};

      // For each category this stream has, collect its batch ID
      for (const category of streamCategories) {
        if (!categoriesBatchMap[category]) {
          categoriesBatchMap[category] = [];
        }
        // Add this stream's batch ID for this category (if it exists)
        if (streamBatchIds[category]) {
          categoriesBatchMap[category].push(streamBatchIds[category]);
        }
      }
    }

    // Merge with existing (overwrite with new data)
    Object.assign(existingBatchIdsByCategory, categoriesBatchMap);
    debug(
      `refreshLinkedStream: built batch mapping for ${Object.keys(categoriesBatchMap).length} categories`,
    );
  }

  debug(
    `refreshLinkedStream: updating linked stream lastMilkedAt and batch info`,
  );
  await prisma.linkedStream.update({
    where: { id: linkedStreamId, deletedAt: null },
    data: {
      lastMilkedAt: new Date(),
      lastBatchIds: JSON.stringify(batchIds), // Keep for backward compatibility
      lastBatchIdsByCategory: JSON.stringify(existingBatchIdsByCategory),
    },
  });

  const streamsRefreshed = results.filter((r) => !r.error).length;
  const streamsFailed = results.filter((r) => r.error).length;
  debug(
    `refreshLinkedStream: completed, refreshed=${totalRefreshed}, streamsRefreshed=${streamsRefreshed}, streamsFailed=${streamsFailed}`,
  );

  return {
    refreshed: totalRefreshed,
    streamsRefreshed,
    streamsFailed,
    errors: errors.length > 0 ? errors : undefined,
    results,
  };
}
