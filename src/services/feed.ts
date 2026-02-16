import { prisma } from "../prisma";
import {
  parseMetadata,
  type Category,
  type ContentItem,
  type LinkedStreamFeedItem,
} from "../types";
import { resolveMediaUrl } from "../lib/storage";
import { createDebugger, logError } from "../lib/debug";

const debug = createDebugger("FEED-SERVICE");

// ============ Query Parameter Builder ============

/**
 * Helper class for building parameterized SQL queries safely.
 * Automatically tracks parameter indexes to avoid misalignment.
 */
class QueryParameterBuilder {
  private params: unknown[] = [];
  private paramIndex = 1;

  /**
   * Add a parameter and return its placeholder (e.g., "$1", "$2")
   */
  add(value: unknown): string {
    this.params.push(value);
    return `$${this.paramIndex++}`;
  }

  /**
   * Add multiple parameters and return their placeholders joined
   */
  addMultiple(values: unknown[], separator = ", "): string {
    return values.map((v) => this.add(v)).join(separator);
  }

  /**
   * Get all collected parameters
   */
  getParams(): unknown[] {
    return this.params;
  }

  /**
   * Get current parameter count
   */
  getCount(): number {
    return this.params.length;
  }
}

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
  isCustomItem: boolean;
  isEdited?: boolean;
}): ContentItem {
  debug(
    `transformContentItem: id=${dbItem.id}, category=${dbItem.category}, isCustomItem=${dbItem.isCustomItem}`,
  );
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
    isCustomItem: dbItem.isCustomItem,
    isEdited: dbItem.isEdited ?? false,
  };
}

// Transform to linked stream feed item (adds source info)
export function transformToLinkedStreamFeedItem(
  item: {
    id: string;
    title: string;
    url: string | null;
    description: string | null;
    imageUrl: string | null;
    source: string;
    category: string;
    author: string | null;
    publishedAt: Date | null;
    metadata: string | null;
    createdAt: Date;
    batchId?: string | null;
    fetchedAt: Date;
    streamId?: string;
    isCustomItem: boolean;
    isEdited?: boolean;
  },
  streamName: string | null,
  isLinkedStreamCustomItem: boolean,
): LinkedStreamFeedItem {
  debug(
    `transformToLinkedStreamFeedItem: id=${item.id}, category=${item.category}, streamName=${streamName}, isLinkedStreamCustomItem=${isLinkedStreamCustomItem}`,
  );
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    description: item.description,
    imageUrl: item.imageUrl,
    rawImageUrl: item.imageUrl, // Keep original for editing (media:// refs)
    source: item.source,
    category: item.category as Category,
    author: item.author,
    publishedAt: item.publishedAt,
    metadata: parseMetadata(item.metadata),
    createdAt: item.createdAt,
    batchId: item.batchId ?? null,
    fetchedAt: item.fetchedAt,
    streamId: isLinkedStreamCustomItem ? null : (item.streamId ?? null),
    streamName: isLinkedStreamCustomItem ? null : streamName,
    isLinkedStreamCustomItem,
    isCustomItem: item.isCustomItem,
    isEdited: item.isEdited ?? false,
  };
}

interface FeedQueryParams {
  category?: string;
  lastMilkOnly?: boolean;
  search?: string;
  limit: number;
  offset: number;
}

interface StreamFeedParams extends FeedQueryParams {
  streamId: string;
  lastMilkedAt: Date | null;
  lastBatchId: string | null;
  batchId?: string;
}

interface StreamFeedResult {
  items: ContentItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  latestBatchId: string | null;
}

/**
 * Get feed for a single stream
 */
export async function getStreamFeed(
  params: StreamFeedParams,
): Promise<StreamFeedResult> {
  const {
    streamId,
    category,
    lastMilkOnly,
    lastMilkedAt,
    lastBatchId,
    batchId,
    search,
    limit,
    offset,
  } = params;

  debug(
    `getStreamFeed: streamId=${streamId}, category=${category ?? "all"}, lastMilkOnly=${lastMilkOnly}, limit=${limit}, offset=${offset}`,
  );
  debug(
    `getStreamFeed filters: batchId=${batchId ?? "none"}, lastBatchId=${lastBatchId ?? "none"}, search=${search ?? "none"}`,
  );

  // Build where clause
  const where: Record<string, unknown> = { streamId };

  if (category) {
    where.category = category;
    debug(`getStreamFeed: filtering by category=${category}`);
  }

  // Search filter
  if (search?.trim()) {
    const searchTerm = search.trim();
    debug(`getStreamFeed: applying search filter="${searchTerm}"`);
    where.OR = [
      { title: { contains: searchTerm } },
      { description: { contains: searchTerm } },
      { author: { contains: searchTerm } },
    ];
  }

  // Filter by specific batchId
  if (batchId) {
    where.batchId = batchId;
    debug(`getStreamFeed: filtering by specific batchId=${batchId}`);
  }
  // Filter by lastMilkOnly - only show items from the most recent batch
  // Custom items (batchId: null) are NOT included - use "All Items" filter to see them
  else if (lastMilkOnly) {
    if (lastMilkedAt && lastBatchId) {
      debug(
        `getStreamFeed: lastMilkOnly filter active, using lastBatchId=${lastBatchId}`,
      );
      // Only show items from the latest batch
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { batchId: lastBatchId }];
        delete where.OR;
      } else {
        where.batchId = lastBatchId;
      }
    } else {
      debug(
        `getStreamFeed: lastMilkOnly requested but never milked, showing all items`,
      );
    }
    // If never milked, show ALL items (don't filter) so users can see initial content
  }

  debug(`getStreamFeed: executing query with where=${JSON.stringify(where)}`);

  const [items, total] = await Promise.all([
    prisma.contentItem.findMany({
      where,
      orderBy: { publishedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.contentItem.count({ where }),
  ]);

  debug(
    `getStreamFeed: fetched ${items.length} items, total=${total}, hasMore=${offset + items.length < total}`,
  );

  const transformedItems = items.map(transformContentItem);
  debug(`getStreamFeed: transformed ${transformedItems.length} items`);

  return {
    items: transformedItems,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
    latestBatchId: lastBatchId,
  };
}

interface LinkedStreamFeedParams extends FeedQueryParams {
  linkedStreamId: string;
  streamIds: string[];
  lastMilkedAt: Date | null;
  lastBatchIds: string | null;
}

interface LinkedStreamFeedResult {
  items: LinkedStreamFeedItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  latestBatchId: string | null;
}

/**
 * Get feed for a linked stream (union of stream items + custom items)
 * Uses UNION query for proper pagination across both tables
 */
export async function getLinkedStreamFeed(
  params: LinkedStreamFeedParams,
): Promise<LinkedStreamFeedResult> {
  const {
    linkedStreamId,
    streamIds,
    category,
    lastMilkOnly,
    lastMilkedAt,
    lastBatchIds,
    search,
    limit,
    offset,
  } = params;

  debug(
    `getLinkedStreamFeed: linkedStreamId=${linkedStreamId}, streamIds=[${streamIds.join(", ")}]`,
  );
  debug(
    `getLinkedStreamFeed: category=${category ?? "all"}, lastMilkOnly=${lastMilkOnly}, limit=${limit}, offset=${offset}`,
  );
  debug(
    `getLinkedStreamFeed: lastBatchIds=${lastBatchIds ?? "none"}, search=${search ?? "none"}`,
  );

  // Should we include custom items in the query?
  // - YES if category is "custom" (Custom tab)
  // - YES if lastMilkOnly is false (All Items filter)
  // - NO if lastMilkOnly is true and category is not "custom"
  const includeCustomItems = category === "custom" || !lastMilkOnly;

  // Handle case when there are no streams linked
  const hasStreams = streamIds.length > 0;

  debug(
    `getLinkedStreamFeed: hasStreams=${hasStreams}, includeCustomItems=${includeCustomItems}`,
  );

  // If no streams and no custom items to include, return empty result
  if (!hasStreams && !includeCustomItems) {
    debug(
      `getLinkedStreamFeed: no streams and no custom items, returning empty result`,
    );
    return {
      items: [],
      total: 0,
      limit,
      offset,
      hasMore: false,
      latestBatchId: null,
    };
  }

  // Use query builder for safe parameter tracking
  const builder = new QueryParameterBuilder();
  const countBuilder = new QueryParameterBuilder(); // Separate builder for count query

  // Build content items WHERE clause (only if we have streams)
  let contentWhere = "";
  if (hasStreams) {
    debug(
      `getLinkedStreamFeed: building content items WHERE for ${streamIds.length} streams`,
    );
    contentWhere = `"streamId" IN (${builder.addMultiple(streamIds)}) AND "deletedAt" IS NULL`;

    // Handle category filter - "custom" tab shows all custom items (isCustomItem = true)
    // Other categories filter by actual category value
    if (category === "custom") {
      contentWhere += ` AND "isCustomItem" = true`;
      debug(
        `getLinkedStreamFeed: content filter by isCustomItem=true (custom tab)`,
      );
      // Custom items are NOT milked - skip batchId filter for Custom tab
    } else if (category) {
      contentWhere += ` AND category = ${builder.add(category)}`;
      debug(`getLinkedStreamFeed: content filter by category=${category}`);
    }

    // Apply lastMilkOnly filter only for non-custom tabs (custom items are never milked)
    if (category !== "custom" && lastMilkOnly && lastBatchIds) {
      const batchIdsArray = JSON.parse(lastBatchIds) as string[];
      debug(
        `getLinkedStreamFeed: lastMilkOnly with ${batchIdsArray.length} batch IDs`,
      );
      if (batchIdsArray.length > 0) {
        contentWhere += ` AND "batchId" IN (${builder.addMultiple(batchIdsArray)})`;
      }
      // If no batch IDs or never milked, show all items (don't filter)
    }

    if (search?.trim()) {
      const searchTerm = `%${search.trim()}%`;
      const searchParam = builder.add(searchTerm);
      contentWhere += ` AND (title ILIKE ${searchParam} OR description ILIKE ${searchParam} OR author ILIKE ${searchParam})`;
      debug(`getLinkedStreamFeed: content search filter="${search.trim()}"`);
    }
  }

  // Build custom items WHERE clause - only add parameters if we're including custom items
  let customWhere = "";
  if (includeCustomItems) {
    debug(
      `getLinkedStreamFeed: building custom items WHERE for linkedStreamId=${linkedStreamId}`,
    );
    customWhere = `"linkedStreamId" = ${builder.add(linkedStreamId)} AND "deletedAt" IS NULL`;

    // For "custom" tab, show all LinkedStreamCustomItem items (they are all custom by nature)
    // For other categories, filter by actual category value
    if (category && category !== "custom") {
      customWhere += ` AND category = ${builder.add(category)}`;
      debug(`getLinkedStreamFeed: custom filter by category=${category}`);
    } else if (category === "custom") {
      debug(
        `getLinkedStreamFeed: custom tab - showing all LinkedStreamCustomItem items`,
      );
    }

    if (search?.trim()) {
      const searchTerm = `%${search.trim()}%`;
      const searchParam = builder.add(searchTerm);
      customWhere += ` AND (title ILIKE ${searchParam} OR description ILIKE ${searchParam} OR author ILIKE ${searchParam})`;
      debug(`getLinkedStreamFeed: custom search filter="${search.trim()}"`);
    }
  }

  // Build count query with separate builder (needs same params except pagination)
  let countContentWhere = "";
  if (hasStreams) {
    countContentWhere = `"streamId" IN (${countBuilder.addMultiple(streamIds)}) AND "deletedAt" IS NULL`;
    // Handle category filter same as main query
    if (category === "custom") {
      countContentWhere += ` AND "isCustomItem" = true`;
      // Custom items are NOT milked - skip batchId filter for Custom tab
    } else if (category) {
      countContentWhere += ` AND category = ${countBuilder.add(category)}`;
    }
    // Apply lastMilkOnly filter only for non-custom tabs (custom items are never milked)
    if (category !== "custom" && lastMilkOnly && lastBatchIds) {
      const batchIdsArray = JSON.parse(lastBatchIds) as string[];
      if (batchIdsArray.length > 0) {
        countContentWhere += ` AND "batchId" IN (${countBuilder.addMultiple(batchIdsArray)})`;
      }
      // If no batch IDs or never milked, count all items (don't filter)
    }
    if (search?.trim()) {
      const searchTerm = `%${search.trim()}%`;
      const searchParam = countBuilder.add(searchTerm);
      countContentWhere += ` AND (title ILIKE ${searchParam} OR description ILIKE ${searchParam} OR author ILIKE ${searchParam})`;
    }
  }

  // Only build custom where for count if we're including custom items
  let countCustomWhere = "";
  if (includeCustomItems) {
    countCustomWhere = `"linkedStreamId" = ${countBuilder.add(linkedStreamId)} AND "deletedAt" IS NULL`;
    // For "custom" tab, count all LinkedStreamCustomItem items (they are all custom by nature)
    if (category && category !== "custom") {
      countCustomWhere += ` AND category = ${countBuilder.add(category)}`;
    }
    if (search?.trim()) {
      const searchTerm = `%${search.trim()}%`;
      const searchParam = countBuilder.add(searchTerm);
      countCustomWhere += ` AND (title ILIKE ${searchParam} OR description ILIKE ${searchParam} OR author ILIKE ${searchParam})`;
    }
  }

  // Add pagination params to main query
  const limitParam = builder.add(limit);
  const offsetParam = builder.add(offset);

  // Build the content items SELECT (only if we have streams)
  const contentItemsSelect = hasStreams
    ? `
      SELECT
        id, title, url, description, "imageUrl", source, category,
        author, "publishedAt", metadata, "streamId", NULL as "linkedStreamId",
        "createdAt", "batchId", "fetchedAt", FALSE as "isLinkedStreamCustom", "isCustomItem", "isEdited"
      FROM "ContentItem"
      WHERE ${contentWhere}
  `
    : "";

  // Build the custom items SELECT (only if we should include them)
  const customItemsSelect = includeCustomItems
    ? `
      SELECT
        id, title, url, description, "imageUrl", source, category,
        author, "publishedAt", metadata, NULL as "streamId", "linkedStreamId",
        "createdAt", NULL as "batchId", "fetchedAt", TRUE as "isLinkedStreamCustom", TRUE as "isCustomItem", "isEdited"
      FROM "LinkedStreamCustomItem"
      WHERE ${customWhere}
  `
    : "";

  // Build the UNION query - combine content items and custom items with UNION ALL
  let innerQuery: string;
  if (hasStreams && includeCustomItems) {
    debug(
      `getLinkedStreamFeed: UNION query combining content items and custom items`,
    );
    innerQuery = `${contentItemsSelect} UNION ALL ${customItemsSelect}`;
  } else if (hasStreams) {
    debug(`getLinkedStreamFeed: query for content items only`);
    innerQuery = contentItemsSelect;
  } else {
    // Only custom items (we already returned early if neither has items)
    debug(`getLinkedStreamFeed: query for custom items only`);
    innerQuery = customItemsSelect;
  }

  const query = `
    SELECT * FROM (${innerQuery}) AS combined
    ORDER BY "fetchedAt" DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  debug(
    `getLinkedStreamFeed: executing UNION query with ${builder.getCount()} params`,
  );

  // Build count query
  let countQuery: string;
  if (hasStreams && includeCustomItems) {
    countQuery = `
      SELECT
        (SELECT COUNT(*) FROM "ContentItem" WHERE ${countContentWhere}) +
        (SELECT COUNT(*) FROM "LinkedStreamCustomItem" WHERE ${countCustomWhere}) as total
    `;
  } else if (hasStreams) {
    countQuery = `SELECT COUNT(*) as total FROM "ContentItem" WHERE ${countContentWhere}`;
  } else {
    // Only custom items
    countQuery = `SELECT COUNT(*) as total FROM "LinkedStreamCustomItem" WHERE ${countCustomWhere}`;
  }

  // Execute queries in parallel
  debug(
    `getLinkedStreamFeed: executing parallel queries (items, count, streams)`,
  );
  const [items, countResult, streams] = await Promise.all([
    prisma.$queryRawUnsafe<
      Array<{
        id: string;
        title: string;
        url: string | null;
        description: string | null;
        imageUrl: string | null;
        source: string;
        category: string;
        author: string | null;
        publishedAt: string | null;
        metadata: string | null;
        streamId: string | null;
        linkedStreamId: string | null;
        createdAt: string;
        batchId: string | null;
        fetchedAt: string;
        isLinkedStreamCustom: boolean;
        isCustomItem: boolean;
        isEdited: boolean;
      }>
    >(query, ...builder.getParams()),
    prisma.$queryRawUnsafe<Array<{ total: number }>>(
      countQuery,
      ...countBuilder.getParams(),
    ),
    prisma.stream.findMany({
      where: { id: { in: streamIds } },
      select: { id: true, name: true },
    }),
  ]);

  debug(`getLinkedStreamFeed: raw query returned ${items.length} items`);
  debug(
    `getLinkedStreamFeed: fetched ${streams.length} stream names for mapping`,
  );

  // Create stream name map
  const streamMap = new Map(streams.map((s) => [s.id, s.name]));

  // Transform results and resolve media URLs
  debug(
    `getLinkedStreamFeed: transforming ${items.length} items and resolving media URLs`,
  );
  const transformed = await Promise.all(
    items.map(async (item) => {
      const isLinkedStreamCustom = !!item.isLinkedStreamCustom;
      const isCustomItem = !!item.isCustomItem;
      const isEdited = !!item.isEdited;
      const feedItem = transformToLinkedStreamFeedItem(
        {
          id: item.id,
          title: item.title,
          url: item.url,
          description: item.description,
          imageUrl: item.imageUrl,
          source: item.source,
          category: item.category,
          author: item.author,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
          metadata: item.metadata,
          createdAt: new Date(item.createdAt),
          batchId: item.batchId,
          fetchedAt: new Date(item.fetchedAt),
          streamId: item.streamId ?? undefined,
          isCustomItem,
          isEdited,
        },
        isLinkedStreamCustom
          ? null
          : (streamMap.get(item.streamId ?? "") ?? null),
        isLinkedStreamCustom,
      );
      // Resolve media:// URLs to fresh signed URLs
      feedItem.imageUrl = await resolveMediaUrl(feedItem.imageUrl);
      return feedItem;
    }),
  );

  const total = Number(countResult[0]?.total ?? 0);
  debug(
    `getLinkedStreamFeed: transformed ${transformed.length} items, total count=${total}`,
  );

  let latestBatchId: string | null = null;
  if (lastBatchIds) {
    try {
      const batchIdsArray = JSON.parse(lastBatchIds) as string[];
      latestBatchId = batchIdsArray[0] ?? null;
      debug(`getLinkedStreamFeed: latestBatchId=${latestBatchId}`);
    } catch (e) {
      logError(
        "FEED-SERVICE",
        `getLinkedStreamFeed: failed to parse lastBatchIds`,
        e,
      );
      latestBatchId = null;
    }
  }

  const hasMore = offset + items.length < total;
  debug(
    `getLinkedStreamFeed: returning ${transformed.length} items, hasMore=${hasMore}`,
  );

  return {
    items: transformed,
    total,
    limit,
    offset,
    hasMore,
    latestBatchId,
  };
}

/**
 * Check if custom items exist for a linked stream (from any source)
 * Uses EXISTS for better performance than COUNT
 */
export async function hasCustomItems(
  linkedStreamId: string,
  streamIds: string[],
): Promise<boolean> {
  debug(
    `hasCustomItems: linkedStreamId=${linkedStreamId}, streamIds=[${streamIds.join(", ")}]`,
  );

  // Check if there are any custom items from streams or linked stream
  // More efficient to use findFirst with minimal selection than COUNT
  // Note: deletedAt filter is auto-applied by Prisma extension for soft-delete models
  const [streamCustomItem, linkedStreamCustomItem] = await Promise.all([
    prisma.contentItem.findFirst({
      where: {
        streamId: { in: streamIds },
        isCustomItem: true,
      },
      select: { id: true },
    }),
    prisma.linkedStreamCustomItem.findFirst({
      where: {
        linkedStreamId,
      },
      select: { id: true },
    }),
  ]);

  const hasStreamCustom = !!streamCustomItem;
  const hasLinkedStreamCustom = !!linkedStreamCustomItem;
  const result = hasStreamCustom || hasLinkedStreamCustom;

  debug(
    `hasCustomItems: hasStreamCustom=${hasStreamCustom}, hasLinkedStreamCustom=${hasLinkedStreamCustom}, result=${result}`,
  );

  return result;
}
