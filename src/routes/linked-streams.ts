import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import { env } from "../env";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import {
  checkLinkedStreamsAccess,
  requireAICredits,
  deductCreditsFromContext,
  getUserTier,
} from "../middleware/tier-limits";
import { isStyleFeatureEnabled } from "../config/tiers";
import { STYLE_LEARNING } from "../config";
import {
  calculatePagination,
  parseCategories,
  CreateLinkedStreamCustomItemSchema,
  UpdateLinkedStreamCustomItemSchema,
  CreateLinkedNewsletterSchema,
  UpdateLinkedNewsletterSchema,
  LinkedStreamFeedQuerySchema,
  CreateTemplateSchema,
  LinkedStreamsPaginationQuerySchema,
  NewslettersPaginationQuerySchema,
  TemplatesPaginationQuerySchema,
  BulkDeleteItemsSchema,
  type Category,
  type ContentItem,
  type LinkedStreamFeedItem,
} from "../types";
import { refreshLinkedStream } from "../services/refresh";
import { getLinkedStreamFeed } from "../services/feed";
import { resolveMediaUrl } from "../lib/storage";
import {
  activateTemplate,
  deactivateTemplate,
  deleteTemplate,
} from "../services/templates";
import {
  generateMklyTemplate,
  isAIConfigured,
} from "../services/ai";
import { buildDefaultMklySource } from "../services/mkly-utils";
import { transformContentItem } from "../lib/transformers";
import { verifyOwnership } from "../lib/ownership";
import { createDebugger, logError } from "../lib/debug";

const debug = createDebugger("LINKED-STREAMS");

export const linkedStreamsRouter = new Hono<{ Variables: AuthVariables }>();

// Schemas
const CreateLinkedStreamSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  streamIds: z
    .array(z.string())
    .min(2, "At least 2 streams are required to create a linked stream"),
});

const UpdateLinkedStreamSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  streamIds: z.array(z.string()).min(2).optional(),
});

const RefreshBodySchema = z.object({
  sortBy: z
    .enum(["date", "relevancy", "popularity"])
    .optional()
    .default("date"),
  category: z.enum(["news", "videos", "social", "custom"]).optional(), // Optional: refresh specific category only
});

// ============ LINKED STREAM CRUD ============

// GET /api/linked-streams - list all linked streams
linkedStreamsRouter.get(
  "/",
  requireAuth,
  zValidator("query", LinkedStreamsPaginationQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const { page, limit } = c.req.valid("query");
    debug(`[${user.id}] GET / - page=${page}, limit=${limit}`);

    const total = await prisma.linkedStream.count({
      where: { userId: user.id },
    });
    debug(`Total linked streams for user: ${total}`);

    const linkedStreams = await prisma.linkedStream.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        members: {
          where: {},
          orderBy: { order: "asc" },
        },
        _count: {
          select: { newsletters: true },
        },
      },
    });

    // Get stream details for each linked stream
    const streamIds = linkedStreams.flatMap((ls) =>
      ls.members.map((m) => m.streamId),
    );
    const streams = await prisma.stream.findMany({
      where: { id: { in: streamIds } },
      select: { id: true, name: true },
    });
    const streamMap = new Map(streams.map((s) => [s.id, s]));

    // Get streams that have any templates (active or not)
    const streamsWithTemplates =
      streamIds.length > 0
        ? await prisma.template.findMany({
            where: {
              streamId: { in: streamIds },
            },
            select: { streamId: true },
            distinct: ["streamId"],
          })
        : [];
    const streamIdsWithTemplates = new Set(
      streamsWithTemplates.map((t) => t.streamId),
    );

    // Get streams that have custom items
    const streamsWithCustomItems =
      streamIds.length > 0
        ? await prisma.contentItem.findMany({
            where: {
              streamId: { in: streamIds },
              isCustomItem: true,
            },
            select: { streamId: true },
            distinct: ["streamId"],
          })
        : [];
    const streamIdsWithCustomItems = new Set(
      streamsWithCustomItems.map((t) => t.streamId),
    );

    const result = linkedStreams.map((ls) => {
      const lsStreamIds = ls.members.map((m) => m.streamId);
      return {
        id: ls.id,
        name: ls.name,
        description: ls.description,
        createdAt: ls.createdAt,
        updatedAt: ls.updatedAt,
        lastMilkedAt: ls.lastMilkedAt,
        hasStreamTemplates: lsStreamIds.some((id) =>
          streamIdsWithTemplates.has(id),
        ),
        hasStreamCustomItems: lsStreamIds.some((id) =>
          streamIdsWithCustomItems.has(id),
        ),
        streams: ls.members.map((m) => ({
          id: m.streamId,
          name: streamMap.get(m.streamId)?.name ?? "Unknown",
          order: m.order,
        })),
        _count: ls._count,
      };
    });

    debug(`Returning ${result.length} linked streams`);
    return c.json({
      data: result,
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// POST /api/linked-streams - create linked stream
linkedStreamsRouter.post(
  "/",
  requireAuth,
  zValidator("json", CreateLinkedStreamSchema),
  async (c) => {
    const user = c.get("user")!;
    const { name, description, streamIds } = c.req.valid("json");
    debug(
      `[${user.id}] POST / - name="${name}", streamIds=[${streamIds.join(", ")}]`,
    );

    // Check if user has access to linked streams feature
    const { allowed, error } = await checkLinkedStreamsAccess(user.id);
    debug(`Access check: allowed=${allowed}`);
    if (!allowed && error) {
      debug(`Access denied for user ${user.id}`);
      return c.json({ error }, 403);
    }

    // Verify all streams belong to the user (select only needed fields to reduce data transfer)
    const streams = await prisma.stream.findMany({
      where: {
        id: { in: streamIds },
        userId: user.id,
      },
      select: { id: true, name: true },
    });
    debug(`Found ${streams.length}/${streamIds.length} streams for user`);

    if (streams.length !== streamIds.length) {
      debug(`Stream ownership verification failed`);
      return c.json(
        {
          error: {
            message: "One or more streams not found",
            code: "STREAMS_NOT_FOUND",
          },
        },
        400,
      );
    }

    // Create linked stream with members
    debug(`Creating linked stream with ${streamIds.length} members`);
    const linkedStream = await prisma.linkedStream.create({
      data: {
        name,
        description,
        userId: user.id,
        members: {
          create: streamIds.map((streamId, index) => ({
            streamId,
            order: index,
          })),
        },
      },
      include: {
        members: {
          orderBy: { order: "asc" },
        },
      },
    });
    debug(`Created linked stream: id=${linkedStream.id}`);

    const result = {
      id: linkedStream.id,
      name: linkedStream.name,
      description: linkedStream.description,
      createdAt: linkedStream.createdAt,
      updatedAt: linkedStream.updatedAt,
      lastMilkedAt: linkedStream.lastMilkedAt,
      streams: linkedStream.members.map((m) => {
        const stream = streams.find((s) => s.id === m.streamId);
        return {
          id: m.streamId,
          name: stream?.name ?? "Unknown",
          order: m.order,
        };
      }),
    };

    return c.json({ data: result }, 201);
  },
);

// GET /api/linked-streams/:id - get single linked stream
linkedStreamsRouter.get("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const linkedStreamId = c.req.param("id");
  debug(`[${user.id}] GET /:id - linkedStreamId=${linkedStreamId}`);

  const linkedStream = await prisma.linkedStream.findFirst({
    where: {
      id: linkedStreamId,
      userId: user.id,
    },
    include: {
      members: {
        orderBy: { order: "asc" },
      },
    },
  });

  if (!linkedStream) {
    debug(`Linked stream not found: ${linkedStreamId}`);
    return c.json(
      { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
      404,
    );
  }
  debug(`Found linked stream: ${linkedStream.name}`);

  // Get stream details
  const streamIds = linkedStream.members.map((m) => m.streamId);
  const streams = await prisma.stream.findMany({
    where: { id: { in: streamIds } },
    select: { id: true, name: true, categories: true },
  });
  const streamMap = new Map(streams.map((s) => [s.id, s]));

  // Check if any linked stream has any template (active or not)
  const hasStreamTemplates =
    streamIds.length > 0
      ? await prisma.template
          .findFirst({
            where: {
              streamId: { in: streamIds },
            },
            select: { id: true },
          })
          .then((t) => !!t)
      : false;

  // Check if any linked stream has custom items
  const hasStreamCustomItems =
    streamIds.length > 0
      ? await prisma.contentItem
          .findFirst({
            where: {
              streamId: { in: streamIds },
              isCustomItem: true,
            },
            select: { id: true },
          })
          .then((t) => !!t)
      : false;

  const result = {
    id: linkedStream.id,
    name: linkedStream.name,
    description: linkedStream.description,
    createdAt: linkedStream.createdAt,
    updatedAt: linkedStream.updatedAt,
    lastMilkedAt: linkedStream.lastMilkedAt,
    hasStreamTemplates,
    hasStreamCustomItems,
    streams: linkedStream.members.map((m) => {
      const stream = streamMap.get(m.streamId);
      return {
        id: m.streamId,
        name: stream?.name ?? "Unknown",
        categories: stream?.categories ?? "[]",
        order: m.order,
      };
    }),
  };

  debug(
    `Returning linked stream with ${result.streams.length} streams, hasTemplates=${hasStreamTemplates}, hasCustomItems=${hasStreamCustomItems}`,
  );
  return c.json({ data: result });
});

// PUT /api/linked-streams/:id - update linked stream
linkedStreamsRouter.put(
  "/:id",
  requireAuth,
  zValidator("json", UpdateLinkedStreamSchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const { name, description, streamIds } = c.req.valid("json");
    debug(`[${user.id}] PUT /:id - linkedStreamId=${linkedStreamId}`);

    // Check ownership
    debug(`Verifying ownership for linked stream ${linkedStreamId}`);
    await verifyOwnership("linkedStream", linkedStreamId, user.id);
    debug(`Ownership verified`);

    // If updating streams, verify they all belong to user
    if (streamIds) {
      debug(`Updating member streams: [${streamIds.join(", ")}]`);
      const streams = await prisma.stream.findMany({
        where: {
          id: { in: streamIds },
          userId: user.id,
        },
        select: { id: true },
      });
      debug(`Found ${streams.length}/${streamIds.length} streams for user`);

      if (streams.length !== streamIds.length) {
        debug(`Stream ownership verification failed`);
        return c.json(
          {
            error: {
              message: "One or more streams not found",
              code: "STREAMS_NOT_FOUND",
            },
          },
          400,
        );
      }
    }

    // Update linked stream and members in a transaction
    const linkedStream = await prisma.$transaction(async (tx) => {
      if (streamIds) {
        debug(`Replacing member links`);
        await tx.linkedStreamMember.deleteMany({
          where: { linkedStreamId },
        });

        await tx.linkedStreamMember.createMany({
          data: streamIds.map((streamId, index) => ({
            linkedStreamId,
            streamId,
            order: index,
          })),
        });
      }

      return tx.linkedStream.update({
        where: { id: linkedStreamId },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
        },
        include: {
          members: {
            orderBy: { order: "asc" },
          },
        },
      });
    });

    // Get stream details
    const streamIdsList = linkedStream.members.map((m) => m.streamId);
    const streams = await prisma.stream.findMany({
      where: { id: { in: streamIdsList } },
      select: { id: true, name: true },
    });
    const streamMap = new Map(streams.map((s) => [s.id, s]));

    const result = {
      id: linkedStream.id,
      name: linkedStream.name,
      description: linkedStream.description,
      createdAt: linkedStream.createdAt,
      updatedAt: linkedStream.updatedAt,
      lastMilkedAt: linkedStream.lastMilkedAt,
      streams: linkedStream.members.map((m) => ({
        id: m.streamId,
        name: streamMap.get(m.streamId)?.name ?? "Unknown",
        order: m.order,
      })),
    };

    debug(
      `Updated linked stream: id=${linkedStream.id}, name="${linkedStream.name}"`,
    );
    return c.json({ data: result });
  },
);

// DELETE /api/linked-streams/:id - delete linked stream
linkedStreamsRouter.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const linkedStreamId = c.req.param("id");
  debug(`[${user.id}] DELETE /:id - linkedStreamId=${linkedStreamId}`);

  // Check ownership
  debug(`Verifying ownership for linked stream ${linkedStreamId}`);
  await verifyOwnership("linkedStream", linkedStreamId, user.id);

  await prisma.linkedStream.delete({
    where: { id: linkedStreamId },
  });

  debug(`Deleted linked stream: id=${linkedStreamId}`);
  return c.body(null, 204);
});

// ============ REFRESH (MILK) ============

// POST /api/linked-streams/:id/refresh - milk all linked streams
linkedStreamsRouter.post(
  "/:id/refresh",
  requireAuth,
  zValidator("json", RefreshBodySchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const { sortBy, category } = c.req.valid("json");
    debug(
      `[${user.id}] POST /:id/refresh - linkedStreamId=${linkedStreamId}, sortBy=${sortBy}, category=${category ?? "all"}`,
    );

    try {
      debug(`Starting refresh for linked stream ${linkedStreamId}`);
      const result = await refreshLinkedStream({
        linkedStreamId,
        userId: user.id,
        sortBy,
        category,
      });

      debug(
        `Refresh complete: streamsRefreshed=${result.streamsRefreshed}, refreshed=${result.refreshed}`,
      );
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Linked stream not found") {
          debug(`Refresh failed: linked stream not found`);
          return c.json(
            {
              error: { message: "Linked stream not found", code: "NOT_FOUND" },
            },
            404,
          );
        }
        if (error.message.includes("Not enough milk quota")) {
          debug(`Refresh failed: quota exceeded`);
          return c.json(
            {
              error: {
                message: error.message,
                code: "TIER_RESTRICTION",
                limit: "milkCount",
              },
            },
            403,
          );
        }
        logError(
          "LINKED-STREAMS",
          `Refresh error for ${linkedStreamId}:`,
          error.message,
        );
      }
      throw error;
    }
  },
);

// ============ FEED ============

// GET /api/linked-streams/:id/feed - get combined feed from all linked streams + custom items
linkedStreamsRouter.get(
  "/:id/feed",
  requireAuth,
  zValidator("query", LinkedStreamFeedQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const { limit, offset, category, lastMilkOnly, search } =
      c.req.valid("query");
    debug(
      `[${user.id}] GET /:id/feed - linkedStreamId=${linkedStreamId}, category=${category ?? "all"}, lastMilkOnly=${lastMilkOnly}, limit=${limit}, offset=${offset}`,
    );

    // Check ownership and get linked streams
    const linkedStream = await prisma.linkedStream.findFirst({
      where: {
        id: linkedStreamId,
        userId: user.id,
      },
      include: {
        members: {
          orderBy: { order: "asc" },
        },
      },
    });

    if (!linkedStream) {
      debug(`Linked stream not found: ${linkedStreamId}`);
      return c.json(
        { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Found linked stream: ${linkedStream.name}`);

    const streamIds = linkedStream.members.map((m) => m.streamId);
    debug(`Fetching feed from ${streamIds.length} streams`);

    // Determine which batch IDs to use for lastMilkOnly filter
    let batchIdsForFilter = linkedStream.lastBatchIds;

    // If category-specific and we have per-category batch tracking
    if (category && lastMilkOnly && linkedStream.lastBatchIdsByCategory) {
      try {
        const batchIdsByCategory = JSON.parse(
          linkedStream.lastBatchIdsByCategory,
        ) as Record<string, string | string[]>;
        const categoryBatchIds = batchIdsByCategory[category];

        if (categoryBatchIds) {
          // Convert to array format for consistency
          const idsArray = Array.isArray(categoryBatchIds)
            ? categoryBatchIds
            : [categoryBatchIds];
          batchIdsForFilter = JSON.stringify(idsArray);
        } else {
          // Category hasn't been milked yet
          batchIdsForFilter = "[]";
        }
      } catch {
        // Fallback to legacy lastBatchIds if parsing fails
        batchIdsForFilter = linkedStream.lastBatchIds;
      }
    }

    const result = await getLinkedStreamFeed({
      linkedStreamId,
      streamIds,
      category,
      lastMilkOnly,
      lastMilkedAt: linkedStream.lastMilkedAt,
      lastBatchIds: batchIdsForFilter,
      search,
      limit,
      offset,
    });

    debug(`Feed result: ${result.items.length} items, total=${result.total}`);
    return c.json({ data: result });
  },
);

// GET /api/linked-streams/:id/batches - get available batch IDs for the linked stream
linkedStreamsRouter.get("/:id/batches", requireAuth, async (c) => {
  const user = c.get("user")!;
  const linkedStreamId = c.req.param("id");
  debug(`[${user.id}] GET /:id/batches - linkedStreamId=${linkedStreamId}`);

  const linkedStream = await prisma.linkedStream.findFirst({
    where: {
      id: linkedStreamId,
      userId: user.id,
    },
    include: {
      members: true,
    },
  });

  if (!linkedStream) {
    debug(`Linked stream not found: ${linkedStreamId}`);
    return c.json(
      { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
      404,
    );
  }

  const streamIds = linkedStream.members.map((m) => m.streamId);
  debug(`Fetching batches from ${streamIds.length} streams`);

  // Get unique batch IDs with their timestamps
  const batches = await prisma.contentItem.groupBy({
    by: ["batchId"],
    where: {
      streamId: { in: streamIds },
      batchId: { not: null },
    },
    _max: {
      fetchedAt: true,
    },
    orderBy: {
      _max: {
        fetchedAt: "desc",
      },
    },
    take: 10,
  });

  const result = batches
    .filter((b) => b.batchId !== null)
    .map((b) => ({
      batchId: b.batchId!,
      fetchedAt: b._max.fetchedAt,
    }));

  debug(`Found ${result.length} batches`);
  return c.json({ data: result });
});

// ============ CUSTOM ITEMS ============

// POST /api/linked-streams/:id/custom-items - create custom item for linked stream
linkedStreamsRouter.post(
  "/:id/custom-items",
  requireAuth,
  zValidator("json", CreateLinkedStreamCustomItemSchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const data = c.req.valid("json");
    debug(
      `[${user.id}] POST /:id/custom-items - linkedStreamId=${linkedStreamId}, title="${data.title}"`,
    );

    // Check ownership
    const linkedStream = await prisma.linkedStream.findFirst({
      where: {
        id: linkedStreamId,
        userId: user.id,
      },
    });

    if (!linkedStream) {
      debug(`Linked stream not found: ${linkedStreamId}`);
      return c.json(
        { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for linked stream: ${linkedStream.name}`);

    // Create custom item
    debug(`Creating custom item for linked stream ${linkedStreamId}`);
    const customItem = await prisma.linkedStreamCustomItem.create({
      data: {
        title: data.title,
        url: data.url,
        description: data.description,
        imageUrl: data.imageUrl,
        category: data.category ?? "custom",
        author: data.author,
        source: "custom",
        publishedAt: new Date(),
        linkedStreamId,
        fetchedAt: new Date(),
      },
    });
    debug(
      `Created custom item: id=${customItem.id}, linkedStreamId=${linkedStreamId}`,
    );

    // Transform to feed item format and resolve media URL
    const feedItem: LinkedStreamFeedItem = {
      id: customItem.id,
      title: customItem.title,
      url: customItem.url,
      description: customItem.description,
      imageUrl: await resolveMediaUrl(customItem.imageUrl),
      rawImageUrl: customItem.imageUrl, // Keep original for editing (media:// refs)
      source: customItem.source,
      category: customItem.category as Category,
      author: customItem.author,
      publishedAt: customItem.publishedAt,
      metadata: null,
      createdAt: customItem.createdAt,
      batchId: null,
      fetchedAt: customItem.fetchedAt,
      streamId: null,
      streamName: null,
      isLinkedStreamCustomItem: true,
      isCustomItem: true,
    };

    return c.json({ data: feedItem }, 201);
  },
);

// DELETE /api/linked-streams/custom-items/:id - delete custom item
linkedStreamsRouter.delete("/custom-items/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const customItemId = c.req.param("id");
  debug(`[${user.id}] DELETE /custom-items/:id - customItemId=${customItemId}`);

  // Find custom item and verify ownership through linked stream
  const customItem = await prisma.linkedStreamCustomItem.findUnique({
    where: { id: customItemId },
    include: {
      linkedStream: {
        select: { userId: true },
      },
    },
  });

  if (!customItem || customItem.linkedStream.userId !== user.id) {
    debug(`Custom item not found or not owned: ${customItemId}`);
    return c.json(
      { error: { message: "Custom item not found", code: "NOT_FOUND" } },
      404,
    );
  }
  debug(`Ownership verified for custom item: ${customItemId}`);

  await prisma.linkedStreamCustomItem.softDelete({ id: customItemId });

  debug(`Soft deleted custom item: id=${customItemId}`);
  return c.body(null, 204);
});

// DELETE /api/linked-streams/:id/custom-items/bulk - bulk delete custom items
linkedStreamsRouter.delete(
  "/:id/custom-items/bulk",
  requireAuth,
  zValidator("json", BulkDeleteItemsSchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const { itemIds } = c.req.valid("json");
    debug(
      `[${user.id}] DELETE /:id/custom-items/bulk - linkedStreamId=${linkedStreamId}, itemIds=${itemIds.length}`,
    );

    // Check ownership
    const linkedStream = await prisma.linkedStream.findFirst({
      where: {
        id: linkedStreamId,
        userId: user.id,
      },
    });

    if (!linkedStream) {
      debug(`Linked stream not found: ${linkedStreamId}`);
      return c.json(
        { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for linked stream: ${linkedStream.name}`);

    // Find all matching custom items that belong to this linked stream
    const customItems = await prisma.linkedStreamCustomItem.findMany({
      where: {
        id: { in: itemIds },
        linkedStreamId,
      },
      select: { id: true },
    });

    const customItemIds = customItems.map((item) => item.id);
    const skipped = itemIds.length - customItemIds.length;

    // Soft delete all matching custom items
    if (customItemIds.length > 0) {
      await prisma.linkedStreamCustomItem.softDeleteMany({
        id: { in: customItemIds },
      });
    }

    debug(
      `Bulk delete complete: deleted=${customItemIds.length}, skipped=${skipped}`,
    );
    return c.json({
      data: {
        deleted: customItemIds.length,
        skipped,
      },
    });
  },
);

// PUT /api/linked-stream-custom-items/:id - update custom item
linkedStreamsRouter.put(
  "/custom-items/:id",
  requireAuth,
  zValidator("json", UpdateLinkedStreamCustomItemSchema),
  async (c) => {
    const user = c.get("user")!;
    const customItemId = c.req.param("id");
    const data = c.req.valid("json");
    debug(`[${user.id}] PUT /custom-items/:id - customItemId=${customItemId}`);

    // Find custom item and verify ownership through linked stream
    const customItem = await prisma.linkedStreamCustomItem.findUnique({
      where: { id: customItemId },
      include: {
        linkedStream: {
          select: { userId: true },
        },
      },
    });

    if (!customItem || customItem.linkedStream.userId !== user.id) {
      debug(`Custom item not found or not owned: ${customItemId}`);
      return c.json(
        { error: { message: "Custom item not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for custom item: ${customItemId}`);

    // Build update data, handling nullable fields
    const updateData: Record<string, unknown> = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.url !== undefined) updateData.url = data.url;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.author !== undefined) updateData.author = data.author;

    debug(`Updating custom item: ${customItemId}`);
    const updatedItem = await prisma.linkedStreamCustomItem.update({
      where: { id: customItemId },
      data: updateData,
    });
    debug(`Updated custom item: id=${customItemId}`);

    // Transform to feed item format and resolve media URL
    const feedItem: LinkedStreamFeedItem = {
      id: updatedItem.id,
      title: updatedItem.title,
      url: updatedItem.url,
      description: updatedItem.description,
      imageUrl: await resolveMediaUrl(updatedItem.imageUrl),
      rawImageUrl: updatedItem.imageUrl, // Keep original for editing (media:// refs)
      source: updatedItem.source,
      category: updatedItem.category as Category,
      author: updatedItem.author,
      publishedAt: updatedItem.publishedAt,
      metadata: null,
      createdAt: updatedItem.createdAt,
      batchId: null,
      fetchedAt: updatedItem.fetchedAt,
      streamId: null,
      streamName: null,
      isLinkedStreamCustomItem: true,
      isCustomItem: true,
    };

    return c.json({ data: feedItem });
  },
);

// ============ TEMPLATES ============

// GET /api/linked-streams/:id/templates - list templates
linkedStreamsRouter.get(
  "/:id/templates",
  requireAuth,
  zValidator("query", TemplatesPaginationQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const { page, limit } = c.req.valid("query");
    debug(
      `[${user.id}] GET /:id/templates - linkedStreamId=${linkedStreamId}, page=${page}, limit=${limit}`,
    );

    // Check ownership
    const linkedStream = await prisma.linkedStream.findFirst({
      where: { id: linkedStreamId, userId: user.id },
    });

    if (!linkedStream) {
      debug(`Linked stream not found: ${linkedStreamId}`);
      return c.json(
        { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for linked stream: ${linkedStream.name}`);

    const total = await prisma.linkedStreamTemplate.count({
      where: { linkedStreamId },
    });
    debug(`Total templates for linked stream: ${total}`);

    const templates = await prisma.linkedStreamTemplate.findMany({
      where: { linkedStreamId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    });

    const transformedTemplates = templates.map((t) => ({
      id: t.id,
      name: t.name,
      mklySource: t.mklySource,
      logoUrl: t.logoUrl ?? null,
      linkedStreamId: t.linkedStreamId,
      isActive: t.isActive,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));

    debug(`Returning ${transformedTemplates.length} templates`);
    return c.json({
      data: transformedTemplates,
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// POST /api/linked-streams/:id/templates - generate template with AI
linkedStreamsRouter.post(
  "/:id/templates",
  requireAuth,
  requireAICredits("templateGeneration"),
  zValidator("json", CreateTemplateSchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const input = c.req.valid("json");
    debug(
      `[${user.id}] POST /:id/templates - linkedStreamId=${linkedStreamId}, generateWithAI=${input.generateWithAI !== false}, setActive=${input.setActive || false}`,
    );

    // Check ownership and fetch member streams with details
    const linkedStream = await prisma.linkedStream.findFirst({
      where: { id: linkedStreamId, userId: user.id },
      include: {
        members: true,
      },
    });

    if (!linkedStream) {
      debug(`Linked stream not found: ${linkedStreamId}`);
      return c.json(
        { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for linked stream: ${linkedStream.name}`);

    // Fetch member streams with names, descriptions, categories, keywords
    const streamIds = linkedStream.members.map((m) => m.streamId);
    const streams = await prisma.stream.findMany({
      where: { id: { in: streamIds } },
      select: {
        name: true,
        description: true,
        categories: true,
        keywords: true,
      },
    });

    // Merge categories from all member streams
    const allCategories = new Set<Category>();
    for (const stream of streams) {
      const cats = parseCategories(stream.categories);
      for (const cat of cats) {
        allCategories.add(cat);
      }
    }
    const categories = Array.from(allCategories);
    debug(
      `Merged categories from ${streams.length} member streams: [${categories.join(", ")}]`,
    );

    // Merge newsletterType into customization if provided at top level
    const customization = input.newsletterType
      ? { ...input.customization, newsletterType: input.newsletterType }
      : input.customization;

    let mklySource: string;

    // Generate template with AI if requested and configured
    if (input.generateWithAI !== false) {
      if (!isAIConfigured()) {
        return c.json(
          {
            error: {
              message:
                "AI template generation is not configured. Please set your Google API key in the ENV tab.",
              code: "AI_NOT_CONFIGURED",
            },
          },
          400,
        );
      }

      try {
        // Fetch recent content items from member streams
        const recentItems = await prisma.contentItem.findMany({
          where: { streamId: { in: streamIds } },
          orderBy: { publishedAt: "desc" },
          take: 8,
        });

        debug(
          `Generating template with AI for linked stream: ${linkedStreamId}, name=${linkedStream.name}, categories=${categories.length}, items=${recentItems.length}`,
        );
        mklySource = await generateMklyTemplate(
          linkedStream.name,
          categories,
          customization,
          recentItems.length > 0 ? (recentItems as unknown as ContentItem[]) : undefined,
        );
        debug(`Template AI generated: ${mklySource.length} chars`);
      } catch (error) {
        logError("LINKED-STREAMS", "Error generating template:", error);
        return c.json(
          {
            error: {
              message: "Failed to generate template with AI",
              code: "AI_GENERATION_FAILED",
            },
          },
          500,
        );
      }
    } else {
      // Create a default template without AI
      mklySource = buildDefaultMklySource(
        input.name || `${linkedStream.name} Template`,
        categories,
        { primaryColor: "#4A3728", accentColor: "#D4A574" },
      );
    }

    // Use provided name with fallback to linked stream name
    const templateName =
      input.name || linkedStream.name || "Newsletter Template";

    // Create template in database (with transaction for atomicity when setActive)
    debug(
      `Creating linked stream template in DB: linkedStreamId=${linkedStreamId}, name=${templateName}, isActive=${input.setActive ?? false}`,
    );
    const template = await prisma.$transaction(async (tx) => {
      if (input.setActive) {
        debug(
          `Deactivating other templates for linked stream: ${linkedStreamId}`,
        );
        await tx.linkedStreamTemplate.updateMany({
          where: { linkedStreamId, isActive: true },
          data: { isActive: false },
        });
      }

      return tx.linkedStreamTemplate.create({
        data: {
          name: templateName,
          mklySource,
          logoUrl: input.customization?.logoUrl ?? null,
          linkedStreamId,
          isActive: input.setActive ?? false,
        },
      });
    });

    debug(
      `Linked stream template created: id=${template.id}, linkedStreamId=${linkedStreamId}, isActive=${template.isActive}`,
    );

    // Deduct AI credits after successful generation
    if (input.generateWithAI !== false) {
      await deductCreditsFromContext(c);
    }

    return c.json(
      {
        data: {
          id: template.id,
          name: template.name,
          mklySource: template.mklySource,
          logoUrl: template.logoUrl ?? null,
          linkedStreamId: template.linkedStreamId,
          isActive: template.isActive,
          createdAt: template.createdAt,
          updatedAt: template.updatedAt,
        },
      },
      201,
    );
  },
);

// PATCH /api/linked-stream-templates/:id/activate - activate template
linkedStreamsRouter.patch("/templates/:id/activate", requireAuth, async (c) => {
  const user = c.get("user")!;
  const templateId = c.req.param("id");
  debug(
    `[${user.id}] PATCH /templates/:id/activate - templateId=${templateId}`,
  );

  // Check ownership through linked stream
  const template = await prisma.linkedStreamTemplate.findUnique({
    where: { id: templateId },
    include: {
      linkedStream: {
        select: { userId: true },
      },
    },
  });

  if (!template || template.linkedStream.userId !== user.id) {
    debug(`Template not found or not owned: ${templateId}`);
    return c.json(
      { error: { message: "Template not found", code: "NOT_FOUND" } },
      404,
    );
  }
  debug(`Ownership verified for template: ${templateId}`);

  debug(`Activating template: ${templateId}`);
  const { templateInfo } = await activateTemplate(
    templateId,
    user.id,
    "linkedStream",
  );
  debug(
    `Template activated: id=${templateId}, isActive=${templateInfo.isActive}`,
  );

  return c.json({ data: templateInfo });
});

// PATCH /api/linked-stream-templates/:id/deactivate - deactivate template
linkedStreamsRouter.patch(
  "/templates/:id/deactivate",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const templateId = c.req.param("id");
    debug(
      `[${user.id}] PATCH /templates/:id/deactivate - templateId=${templateId}`,
    );

    // Check ownership through linked stream
    const template = await prisma.linkedStreamTemplate.findUnique({
      where: { id: templateId },
      include: {
        linkedStream: {
          select: { userId: true },
        },
      },
    });

    if (!template || template.linkedStream.userId !== user.id) {
      debug(`Template not found or not owned: ${templateId}`);
      return c.json(
        { error: { message: "Template not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for template: ${templateId}`);

    debug(`Deactivating template: ${templateId}`);
    const { templateInfo } = await deactivateTemplate(
      templateId,
      user.id,
      "linkedStream",
    );
    debug(
      `Template deactivated: id=${templateId}, isActive=${templateInfo.isActive}`,
    );

    return c.json({ data: templateInfo });
  },
);

// DELETE /api/linked-stream-templates/:id - delete template
linkedStreamsRouter.delete("/templates/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const templateId = c.req.param("id");
  debug(`[${user.id}] DELETE /templates/:id - templateId=${templateId}`);

  // Check ownership through linked stream
  const template = await prisma.linkedStreamTemplate.findUnique({
    where: { id: templateId },
    include: {
      linkedStream: {
        select: { userId: true },
      },
    },
  });

  if (!template || template.linkedStream.userId !== user.id) {
    debug(`Template not found or not owned: ${templateId}`);
    return c.json(
      { error: { message: "Template not found", code: "NOT_FOUND" } },
      404,
    );
  }
  debug(`Ownership verified for template: ${templateId}`);

  debug(`Deleting template: ${templateId}`);
  await deleteTemplate(templateId, user.id, "linkedStream");
  debug(`Deleted template: id=${templateId}`);

  return c.body(null, 204);
});

// ============ NEWSLETTERS ============

// GET /api/linked-streams/:id/newsletters - list newsletters for linked stream
linkedStreamsRouter.get(
  "/:id/newsletters",
  requireAuth,
  zValidator("query", NewslettersPaginationQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const { page, limit, status } = c.req.valid("query");
    debug(
      `[${user.id}] GET /:id/newsletters - linkedStreamId=${linkedStreamId}, page=${page}, status=${status ?? "all"}`,
    );

    // Check ownership
    const linkedStream = await prisma.linkedStream.findFirst({
      where: { id: linkedStreamId, userId: user.id },
    });

    if (!linkedStream) {
      debug(`Linked stream not found: ${linkedStreamId}`);
      return c.json(
        { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for linked stream: ${linkedStream.name}`);

    const where: { linkedStreamId: string; status?: string } = {
      linkedStreamId,
    };
    if (status) {
      where.status = status;
    }

    const total = await prisma.linkedNewsletter.count({ where });
    debug(`Total newsletters: ${total}`);

    const newsletters = await prisma.linkedNewsletter.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        _count: {
          select: { items: true },
        },
      },
    });

    const result = newsletters.map((n) => ({
      id: n.id,
      title: n.title,
      content: n.content,
      status: n.status,
      linkedStreamId: n.linkedStreamId,
      linkedStreamName: n.linkedStreamName,
      templateId: n.templateId,
      publishedAt: n.publishedAt,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      _count: n._count,
    }));

    debug(`Returning ${result.length} newsletters`);
    return c.json({
      data: result,
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// POST /api/linked-streams/:id/newsletters - create newsletter
linkedStreamsRouter.post(
  "/:id/newsletters",
  requireAuth,
  zValidator("json", CreateLinkedNewsletterSchema),
  async (c) => {
    const user = c.get("user")!;
    const linkedStreamId = c.req.param("id");
    const input = c.req.valid("json");
    debug(
      `[${user.id}] POST /:id/newsletters - linkedStreamId=${linkedStreamId}, title="${input.title}", items=${input.items.length}`,
    );

    // Check ownership
    const linkedStream = await prisma.linkedStream.findFirst({
      where: { id: linkedStreamId, userId: user.id },
    });

    if (!linkedStream) {
      debug(`Linked stream not found: ${linkedStreamId}`);
      return c.json(
        { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for linked stream: ${linkedStream.name}`);

    // Determine template
    let templateId = input.templateId ?? null;

    if (!templateId) {
      const activeTemplate = await prisma.linkedStreamTemplate.findFirst({
        where: { linkedStreamId, isActive: true },
      });
      if (activeTemplate) {
        templateId = activeTemplate.id;
        debug(`Using active template: ${templateId}`);
      } else {
        debug(`No active template found`);
      }
    } else {
      // Validate template exists
      const template = await prisma.linkedStreamTemplate.findFirst({
        where: { id: templateId, linkedStreamId },
      });
      if (!template) {
        debug(`Template not found: ${templateId}`);
        return c.json(
          { error: { message: "Template not found", code: "NOT_FOUND" } },
          404,
        );
      }
      debug(`Using specified template: ${templateId}`);
    }

    // Create newsletter
    debug(`Creating newsletter with ${input.items.length} items`);
    const newsletter = await prisma.linkedNewsletter.create({
      data: {
        title: input.title,
        content: input.content ?? "",
        linkedStreamId,
        linkedStreamName: linkedStream.name,
        templateId,
        items: {
          create: input.items.map((item, index) => ({
            contentItemId: item.contentItemId ?? null,
            linkedStreamCustomItemId: item.linkedStreamCustomItemId ?? null,
            sourceStreamId: item.sourceStreamId ?? null,
            note: item.note ?? null,
            order: item.order ?? index,
          })),
        },
      },
      include: {
        items: {
          orderBy: { order: "asc" },
        },
      },
    });

    debug(
      `Created newsletter: id=${newsletter.id}, items=${newsletter.items.length}`,
    );
    return c.json({ data: newsletter }, 201);
  },
);

// GET /api/linked-newsletters/:id - get single newsletter
linkedStreamsRouter.get("/newsletters/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const newsletterId = c.req.param("id");
  debug(`[${user.id}] GET /newsletters/:id - newsletterId=${newsletterId}`);

  const newsletter = await prisma.linkedNewsletter.findFirst({
    where: { id: newsletterId },
    include: {
      linkedStream: {
        select: { userId: true },
      },
      items: {
        orderBy: { order: "asc" },
        include: {
          contentItem: true,
          linkedStreamCustomItem: true,
        },
      },
    },
  });

  if (!newsletter || newsletter.linkedStream.userId !== user.id) {
    debug(`Newsletter not found or not owned: ${newsletterId}`);
    return c.json(
      { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
      404,
    );
  }
  debug(
    `Found newsletter: ${newsletter.title}, items=${newsletter.items.length}`,
  );

  // Transform items to include content (resolve media:// URLs for custom items)
  const items = await Promise.all(
    newsletter.items.map(async (item) => {
      if (item.contentItem) {
        return {
          id: item.id,
          contentItemId: item.contentItemId,
          linkedStreamCustomItemId: null,
          sourceStreamId: item.sourceStreamId,
          note: item.note,
          order: item.order,
          content: transformContentItem(item.contentItem),
          isLinkedStreamCustomItem: false,
          isCustomItem: item.contentItem.isCustomItem,
        };
      } else if (item.linkedStreamCustomItem) {
        return {
          id: item.id,
          contentItemId: null,
          linkedStreamCustomItemId: item.linkedStreamCustomItemId,
          sourceStreamId: null,
          note: item.note,
          order: item.order,
          content: {
            id: item.linkedStreamCustomItem.id,
            title: item.linkedStreamCustomItem.title,
            url: item.linkedStreamCustomItem.url,
            description: item.linkedStreamCustomItem.description,
            imageUrl: await resolveMediaUrl(
              item.linkedStreamCustomItem.imageUrl,
            ),
            rawImageUrl: item.linkedStreamCustomItem.imageUrl,
            source: item.linkedStreamCustomItem.source,
            category: item.linkedStreamCustomItem.category,
            author: item.linkedStreamCustomItem.author,
            publishedAt: item.linkedStreamCustomItem.publishedAt,
          },
          isLinkedStreamCustomItem: true,
          isCustomItem: true,
        };
      }
      // Fallback for preserved data
      return {
        id: item.id,
        contentItemId: item.contentItemId,
        linkedStreamCustomItemId: item.linkedStreamCustomItemId,
        sourceStreamId: item.sourceStreamId,
        note: item.note,
        order: item.order,
        content: null,
        isLinkedStreamCustomItem: false,
        isCustomItem: false,
      };
    }),
  );

  const result = {
    id: newsletter.id,
    title: newsletter.title,
    content: newsletter.content,
    status: newsletter.status,
    linkedStreamId: newsletter.linkedStreamId,
    linkedStreamName: newsletter.linkedStreamName,
    templateId: newsletter.templateId,
    publishedAt: newsletter.publishedAt,
    createdAt: newsletter.createdAt,
    updatedAt: newsletter.updatedAt,
    items,
  };

  debug(`Returning newsletter: id=${newsletter.id}, items=${items.length}`);
  return c.json({ data: result });
});

// PUT /api/linked-newsletters/:id - update newsletter
linkedStreamsRouter.put(
  "/newsletters/:id",
  requireAuth,
  zValidator("json", UpdateLinkedNewsletterSchema),
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");
    const input = c.req.valid("json");
    debug(`[${user.id}] PUT /newsletters/:id - newsletterId=${newsletterId}`);

    // Check ownership
    const existing = await prisma.linkedNewsletter.findFirst({
      where: { id: newsletterId },
      include: {
        linkedStream: {
          select: { userId: true },
        },
      },
    });

    if (!existing || existing.linkedStream.userId !== user.id) {
      debug(`Newsletter not found or not owned: ${newsletterId}`);
      return c.json(
        { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
        404,
      );
    }
    debug(`Ownership verified for newsletter: ${newsletterId}`);

    // Validate template if being updated
    if (input.templateId) {
      const template = await prisma.linkedStreamTemplate.findFirst({
        where: {
          id: input.templateId,
          linkedStreamId: existing.linkedStreamId,
        },
      });

      if (!template) {
        debug(`Template not found: ${input.templateId}`);
        return c.json(
          { error: { message: "Template not found", code: "NOT_FOUND" } },
          404,
        );
      }
      debug(`Template validated: ${input.templateId}`);
    }

    // Update newsletter
    const updateData: {
      title?: string;
      content?: string;
      templateId?: string | null;
    } = {};

    if (input.title !== undefined) updateData.title = input.title;
    if (input.content !== undefined) updateData.content = input.content;
    if (input.templateId !== undefined)
      updateData.templateId = input.templateId;

    // Wrap items and newsletter update in a transaction for atomicity
    const newsletter = await prisma.$transaction(async (tx) => {
      // If items are provided, replace all items
      if (input.items !== undefined) {
        debug(`Replacing ${input.items.length} newsletter items`);
        await tx.linkedNewsletterItem.deleteMany({
          where: { linkedNewsletterId: newsletterId },
        });

        await tx.linkedNewsletterItem.createMany({
          data: input.items.map((item, index) => ({
            linkedNewsletterId: newsletterId,
            contentItemId: item.contentItemId ?? null,
            linkedStreamCustomItemId: item.linkedStreamCustomItemId ?? null,
            sourceStreamId: item.sourceStreamId ?? null,
            note: item.note ?? null,
            order: item.order ?? index,
          })),
        });
      }

      return tx.linkedNewsletter.update({
        where: { id: newsletterId },
        data: updateData,
        include: {
          items: {
            orderBy: { order: "asc" },
          },
        },
      });
    });

    debug(
      `Updated newsletter: id=${newsletter.id}, items=${newsletter.items.length}`,
    );
    return c.json({ data: newsletter });
  },
);

// DELETE /api/linked-newsletters/:id - delete newsletter
linkedStreamsRouter.delete("/newsletters/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const newsletterId = c.req.param("id");
  debug(`[${user.id}] DELETE /newsletters/:id - newsletterId=${newsletterId}`);

  // Check ownership
  const existing = await prisma.linkedNewsletter.findFirst({
    where: { id: newsletterId },
    include: {
      linkedStream: {
        select: { userId: true },
      },
    },
  });

  if (!existing || existing.linkedStream.userId !== user.id) {
    debug(`Newsletter not found or not owned: ${newsletterId}`);
    return c.json(
      { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
      404,
    );
  }
  debug(`Ownership verified for newsletter: ${newsletterId}`);

  await prisma.linkedNewsletter.delete({
    where: { id: newsletterId },
  });

  debug(`Deleted newsletter: id=${newsletterId}`);
  return c.body(null, 204);
});

// POST /api/linked-newsletters/:id/publish - publish newsletter
linkedStreamsRouter.post("/newsletters/:id/publish", requireAuth, async (c) => {
  const user = c.get("user")!;
  const newsletterId = c.req.param("id");
  debug(
    `[${user.id}] POST /newsletters/:id/publish - newsletterId=${newsletterId}`,
  );

  // Check ownership
  const existing = await prisma.linkedNewsletter.findFirst({
    where: { id: newsletterId },
    include: {
      linkedStream: {
        select: { userId: true },
      },
    },
  });

  if (!existing || existing.linkedStream.userId !== user.id) {
    debug(`Newsletter not found or not owned: ${newsletterId}`);
    return c.json(
      { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
      404,
    );
  }
  debug(`Ownership verified for newsletter: ${newsletterId}`);

  if (existing.status === "published") {
    debug(`Newsletter already published: ${newsletterId}`);
    return c.json(
      {
        error: {
          message: "Newsletter already published",
          code: "ALREADY_PUBLISHED",
        },
      },
      400,
    );
  }

  debug(`Publishing newsletter: ${newsletterId}`);

  // Replace signed S3 URLs with permanent public URLs before publishing
  const { publishLinkedNewsletterContent } =
    await import("../services/newsletter-publish");
  const publicContent = existing.content
    ? await publishLinkedNewsletterContent(
        existing.content,
        newsletterId,
        existing.templateId,
      )
    : undefined;

  const newsletter = await prisma.linkedNewsletter.update({
    where: { id: newsletterId },
    data: {
      status: "published",
      publishedAt: new Date(),
      ...(publicContent !== undefined && { content: publicContent }),
    },
  });

  // Fire-and-forget: style learning analysis
  if (STYLE_LEARNING.ENABLED && existing.templateId) {
    (async () => {
      try {
        const tier = await getUserTier(user.id);
        const styleLearning = await import("../services/style-learning");
        const content = publicContent || existing.content;

        if (isStyleFeatureEnabled("styleProfile", tier) && content) {
          styleLearning
            .analyzeAndUpdateStyleProfile(
              content,
              existing.templateId!,
              "linkedStream",
              user.id,
            )
            .catch((err: unknown) =>
              logError("STYLE-LEARNING", "Profile analysis failed:", err),
            );
        }

        if (
          isStyleFeatureEnabled("editDiffTracking", tier) &&
          existing.generatedContent &&
          content
        ) {
          styleLearning
            .analyzeEditDiff(
              existing.generatedContent,
              content,
              existing.templateId!,
              "linkedStream",
            )
            .catch((err: unknown) =>
              logError("STYLE-LEARNING", "Edit diff analysis failed:", err),
            );
        }

        if (isStyleFeatureEnabled("writingBaseline", tier)) {
          styleLearning
            .maybeUpdateWritingBaseline(user.id)
            .catch((err: unknown) =>
              logError("STYLE-LEARNING", "Baseline update failed:", err),
            );
        }
      } catch (err) {
        logError("STYLE-LEARNING", "Style learning hook failed:", err);
      }
    })();
  }

  const publicUrl = `${env.MILKLY_NEWS_URL}/users/${user.id}/${newsletter.id}`;
  debug(`Published newsletter: id=${newsletter.id}`);
  return c.json({ data: { ...newsletter, publicUrl } });
});
