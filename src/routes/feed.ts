import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import {
  CategorySchema,
  CreateContentItemSchema,
  UpdateLinkedStreamCustomItemSchema,
  BulkDeleteItemsSchema,
} from "../types";
import { PAGINATION, SORT_OPTIONS } from "../config";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { createId } from "@paralleldrive/cuid2";
import { refreshStream } from "../services/refresh";
import { resolveMediaUrl } from "../lib/storage";
import { transformContentItem } from "../lib/transformers";

const feedRouter = new Hono<{ Variables: AuthVariables }>();

// Sort option schema
const SortOptionSchema = z.enum(["date", "relevancy", "popularity"]);

// Feed pagination query schema with offset-based pagination
const FeedPaginationQuerySchema = z.object({
  limit: z.coerce
    .number()
    .min(1)
    .max(PAGINATION.FEED.MAX_LIMIT)
    .optional()
    .default(PAGINATION.FEED.DEFAULT_LIMIT),
  offset: z.coerce.number().min(0).optional().default(0),
  category: CategorySchema.optional(),
  lastMilkOnly: z.coerce.boolean().optional().default(false),
  since: z.coerce.date().optional(),
  batchId: z.string().optional(),
  sortBy: SortOptionSchema.optional().default(SORT_OPTIONS.DATE),
  search: z.string().optional(),
});

// GET /api/streams/:id/feed - get content items for a stream with pagination and filtering
feedRouter.get(
  "/:id/feed",
  requireAuth,
  zValidator("query", FeedPaginationQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const { limit, offset, category, lastMilkOnly, since, batchId, search } =
      c.req.valid("query");

    // Check stream ownership
    const stream = await prisma.stream.findFirst({
      where: {
        id: streamId,
        userId: user.id,
      },
    });

    if (!stream) {
      return c.json(
        { error: { message: "Stream not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Use stream's stored last milk info (set during refresh)
    const lastMilkTime = stream.lastMilkedAt;
    let latestBatchId = stream.lastBatchId;

    // If category-specific and we have per-category batch tracking, use category-specific batch ID
    if (category && stream.lastBatchIdsByCategory) {
      try {
        const batchIdsByCategory = JSON.parse(
          stream.lastBatchIdsByCategory,
        ) as Record<string, string>;
        const categoryBatchId = batchIdsByCategory[category];
        if (categoryBatchId) {
          latestBatchId = categoryBatchId;
        } else {
          // Category hasn't been milked yet - use null so lastMilkOnly will show nothing
          latestBatchId = null;
        }
      } catch {
        // Fallback to legacy lastBatchId if parsing fails
        latestBatchId = stream.lastBatchId;
      }
    }

    // Build where clause with filters (deletedAt: null is auto-added by Prisma extension)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { streamId };

    // Handle category filter - "custom" tab shows all custom items (isCustomItem: true)
    // Other categories filter by actual category value
    if (category === "custom") {
      where.isCustomItem = true;
    } else if (category) {
      where.category = category;
    }

    // Search filter - search in title, description, and author
    if (search && search.trim()) {
      const searchTerm = search.trim();
      where.OR = [
        { title: { contains: searchTerm } },
        { description: { contains: searchTerm } },
        { author: { contains: searchTerm } },
      ];
    }

    // Filter by specific batchId (skip for Custom tab - custom items are never milked)
    if (batchId && category !== "custom") {
      where.batchId = batchId;
    }
    // Filter by lastMilkOnly - only show items from the most recent batch
    // Skip for Custom tab - custom items are never milked and should always show
    else if (lastMilkOnly && category !== "custom") {
      if (lastMilkTime && latestBatchId) {
        // Only show items from the latest batch
        if (where.OR) {
          // If we have search filters, combine them with AND
          where.AND = [{ OR: where.OR }, { batchId: latestBatchId }];
          delete where.OR;
        } else {
          where.batchId = latestBatchId;
        }
      }
      // If never milked, show ALL items (don't filter) so users can see initial content
    }

    // Filter by since timestamp
    if (since) {
      where.fetchedAt = { gte: since };
    }

    // Get total count for pagination
    const total = await prisma.contentItem.count({ where });

    // Get items with offset-based pagination
    const items = await prisma.contentItem.findMany({
      where,
      orderBy: { publishedAt: "desc" },
      take: limit,
      skip: offset,
    });

    const hasMore = offset + items.length < total;

    // Resolve media:// URLs to fresh signed URLs
    const transformedItems = await Promise.all(
      items.map(async (item) => {
        const transformed = transformContentItem(item);
        transformed.imageUrl = await resolveMediaUrl(transformed.imageUrl);
        return transformed;
      }),
    );

    return c.json({
      data: {
        items: transformedItems,
        total,
        limit,
        offset,
        hasMore,
        latestBatchId,
      },
    });
  },
);

// Refresh request body schema
const RefreshBodySchema = z.object({
  sortBy: SortOptionSchema.optional().default(SORT_OPTIONS.DATE),
  category: z.enum(["news", "videos", "social", "custom"]).optional(), // Optional: refresh specific category only
});

// POST /api/streams/:id/refresh - refresh content for a stream using real APIs
feedRouter.post(
  "/:id/refresh",
  requireAuth,
  zValidator("json", RefreshBodySchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const { sortBy, category } = c.req.valid("json");

    // Use the refreshStream service which handles category-specific milking
    const result = await refreshStream({
      streamId,
      userId: user.id,
      sortBy,
      category,
      skipUsageCheck: false,
      skipUsageIncrement: false,
    });

    if (!result.success) {
      // Check if it's a tier restriction error
      if (
        result.error?.includes("not available on your current plan") ||
        result.error?.includes("not available for this stream")
      ) {
        return c.json(
          {
            error: {
              message: result.error,
              code: "TIER_RESTRICTION",
              limit: "allowedCategories",
              upgradeUrl: "/pricing",
            },
          },
          403,
        );
      }

      if (result.error === "Stream not found") {
        return c.json(
          { error: { message: "Stream not found", code: "NOT_FOUND" } },
          404,
        );
      }

      return c.json(
        {
          error: {
            message: result.error || "Refresh failed",
            code: "REFRESH_FAILED",
          },
        },
        500,
      );
    }

    return c.json({
      data: {
        items: result.items || [],
        batchId: result.batchId,
        refreshed: result.refreshed,
      },
    });
  },
);

// POST /api/streams/:id/content-items - create a custom content item manually
feedRouter.post(
  "/:id/content-items",
  requireAuth,
  zValidator("json", CreateContentItemSchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const { title, url, description, imageUrl, category, author } =
      c.req.valid("json");

    // Check stream ownership
    const stream = await prisma.stream.findFirst({
      where: {
        id: streamId,
        userId: user.id,
      },
    });

    if (!stream) {
      return c.json(
        { error: { message: "Stream not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Custom items should NOT have a batchId - they weren't fetched during milking
    // This means they show in "All Items" but not in "Last Milk" filter
    const contentItem = await prisma.contentItem.create({
      data: {
        title,
        url: url || `custom://${createId()}`, // Generate unique URL if not provided
        description: description || null,
        imageUrl: imageUrl || null,
        source: "custom",
        category,
        author: author || null,
        publishedAt: new Date(),
        metadata: null,
        streamId,
        batchId: null, // No batchId for custom items
        fetchedAt: new Date(),
        isCustomItem: true,
      },
    });

    // Transform and resolve media URL for immediate display
    const transformed = transformContentItem(contentItem);
    transformed.imageUrl = await resolveMediaUrl(transformed.imageUrl);

    return c.json({
      data: transformed,
    });
  },
);

// PUT /api/streams/:id/content-items/:itemId - update a content item (custom or API-fetched)
feedRouter.put(
  "/:id/content-items/:itemId",
  requireAuth,
  zValidator("json", UpdateLinkedStreamCustomItemSchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const itemId = c.req.param("itemId");
    const data = c.req.valid("json");

    // Check stream ownership
    const stream = await prisma.stream.findFirst({
      where: {
        id: streamId,
        userId: user.id,
      },
    });

    if (!stream) {
      return c.json(
        { error: { message: "Stream not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Find the content item and verify it belongs to this stream
    const existingItem = await prisma.contentItem.findFirst({
      where: {
        id: itemId,
        streamId,
      },
    });

    if (!existingItem) {
      return c.json(
        { error: { message: "Content item not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Build update data
    const updateData: Record<string, unknown> = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
    if (data.author !== undefined) updateData.author = data.author;

    // For API-fetched items (not custom), store original values on first edit
    if (!existingItem.isCustomItem && !existingItem.isEdited) {
      updateData.isEdited = true;
      updateData.originalTitle = existingItem.title;
      updateData.originalDescription = existingItem.description;
      updateData.originalImageUrl = existingItem.imageUrl;
      updateData.originalAuthor = existingItem.author;
    }

    // For custom items, allow URL and category changes
    if (existingItem.isCustomItem) {
      if (data.url !== undefined) updateData.url = data.url;
      if (data.category !== undefined) updateData.category = data.category;
    }

    const updatedItem = await prisma.contentItem.update({
      where: { id: itemId },
      data: updateData,
    });

    // Transform and resolve media URL
    const transformed = transformContentItem(updatedItem);
    transformed.imageUrl = await resolveMediaUrl(transformed.imageUrl);

    return c.json({ data: transformed });
  },
);

// POST /api/streams/:id/content-items/:itemId/revert - revert an edited API item to original
feedRouter.post("/:id/content-items/:itemId/revert", requireAuth, async (c) => {
  const user = c.get("user")!;
  const streamId = c.req.param("id");
  const itemId = c.req.param("itemId");

  // Check stream ownership
  const stream = await prisma.stream.findFirst({
    where: {
      id: streamId,
      userId: user.id,
    },
  });

  if (!stream) {
    return c.json(
      { error: { message: "Stream not found", code: "NOT_FOUND" } },
      404,
    );
  }

  // Find the content item
  const existingItem = await prisma.contentItem.findFirst({
    where: {
      id: itemId,
      streamId,
    },
  });

  if (!existingItem) {
    return c.json(
      { error: { message: "Content item not found", code: "NOT_FOUND" } },
      404,
    );
  }

  // Only allow reverting edited API-fetched items
  if (existingItem.isCustomItem) {
    return c.json(
      {
        error: {
          message: "Cannot revert custom items",
          code: "INVALID_OPERATION",
        },
      },
      400,
    );
  }

  if (!existingItem.isEdited) {
    return c.json(
      {
        error: {
          message: "Item has not been edited",
          code: "INVALID_OPERATION",
        },
      },
      400,
    );
  }

  // Revert to original values
  const updatedItem = await prisma.contentItem.update({
    where: { id: itemId },
    data: {
      title: existingItem.originalTitle ?? existingItem.title,
      description: existingItem.originalDescription,
      imageUrl: existingItem.originalImageUrl,
      author: existingItem.originalAuthor,
      isEdited: false,
      originalTitle: null,
      originalDescription: null,
      originalImageUrl: null,
      originalAuthor: null,
    },
  });

  // Transform and resolve media URL
  const transformed = transformContentItem(updatedItem);
  transformed.imageUrl = await resolveMediaUrl(transformed.imageUrl);

  return c.json({ data: transformed });
});

// DELETE /api/streams/:id/content-items/bulk - bulk delete custom content items
// NOTE: This route MUST be defined before /:id/content-items/:itemId to avoid "bulk" matching as itemId
feedRouter.delete(
  "/:id/content-items/bulk",
  requireAuth,
  zValidator("json", BulkDeleteItemsSchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const { itemIds } = c.req.valid("json");

    // Check stream ownership
    const stream = await prisma.stream.findFirst({
      where: {
        id: streamId,
        userId: user.id,
      },
    });

    if (!stream) {
      return c.json(
        { error: { message: "Stream not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Find all matching custom items that belong to this stream
    const customItems = await prisma.contentItem.findMany({
      where: {
        id: { in: itemIds },
        streamId,
        isCustomItem: true,
      },
      select: { id: true },
    });

    const customItemIds = customItems.map((item) => item.id);
    const skipped = itemIds.length - customItemIds.length;

    // Soft delete all matching custom items
    if (customItemIds.length > 0) {
      await prisma.contentItem.softDeleteMany({ id: { in: customItemIds } });
    }

    return c.json({
      data: {
        deleted: customItemIds.length,
        skipped,
      },
    });
  },
);

// DELETE /api/streams/:id/content-items/:itemId - delete a single custom content item
feedRouter.delete("/:id/content-items/:itemId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const streamId = c.req.param("id");
  const itemId = c.req.param("itemId");

  // Check stream ownership
  const stream = await prisma.stream.findFirst({
    where: {
      id: streamId,
      userId: user.id,
    },
  });

  if (!stream) {
    return c.json(
      { error: { message: "Stream not found", code: "NOT_FOUND" } },
      404,
    );
  }

  // Find the content item and verify it belongs to this stream
  const contentItem = await prisma.contentItem.findFirst({
    where: {
      id: itemId,
      streamId,
    },
  });

  if (!contentItem) {
    return c.json(
      { error: { message: "Content item not found", code: "NOT_FOUND" } },
      404,
    );
  }

  // Only allow deleting custom items
  if (!contentItem.isCustomItem) {
    return c.json(
      {
        error: {
          message: "Only custom items can be deleted",
          code: "INVALID_OPERATION",
        },
      },
      400,
    );
  }

  // Soft delete
  await prisma.contentItem.softDelete({ id: itemId });

  return c.body(null, 204);
});

export { feedRouter };
