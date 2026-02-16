import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../prisma";
import {
  CreateStreamSchema,
  UpdateStreamSchema,
  GenerateKeywordsSchema,
  parseCategories,
  parseKeywords,
  createPaginationQuerySchema,
  calculatePagination,
  type Stream,
  type SortOption,
  type Category,
} from "../types";
import { env } from "../env";
import {
  checkStreamLimit,
  checkAICredits,
  deductAICredits,
  getUserTier,
} from "../middleware/tier-limits";
import { generateStreamKeywords, isAIConfigured } from "../services/ai";
import { filterCategoriesForTier, getCategoriesForTier } from "../config/tiers";
import { CATEGORIES } from "../constants";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { createDebugger, logError } from "../lib/debug";
import { verifyOwnership } from "../lib/ownership";

const debug = createDebugger("STREAMS");

const streamsRouter = new Hono<{ Variables: AuthVariables }>();

// Transform DB stream to API stream
function transformStream(dbStream: {
  id: string;
  name: string;
  description: string | null;
  categories: string;
  keywords: string | null;
  sortPreference: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}): Stream {
  return {
    id: dbStream.id,
    name: dbStream.name,
    description: dbStream.description,
    categories: parseCategories(dbStream.categories),
    keywords: parseKeywords(dbStream.keywords),
    sortPreference: dbStream.sortPreference as SortOption,
    userId: dbStream.userId,
    createdAt: dbStream.createdAt,
    updatedAt: dbStream.updatedAt,
  };
}

// Pagination query schema for streams
const StreamsPaginationQuerySchema = createPaginationQuerySchema(
  env.PAGINATION_STREAMS_DEFAULT,
  env.PAGINATION_STREAMS_MAX,
);

// GET /api/streams - list user's streams with pagination
streamsRouter.get(
  "/",
  requireAuth,
  zValidator("query", StreamsPaginationQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const { page, limit } = c.req.valid("query");
    debug(`[${user.id}] GET / - page=${page}, limit=${limit}`);

    // Get total count
    const total = await prisma.stream.count({
      where: { userId: user.id },
    });

    // Get paginated streams
    const streams = await prisma.stream.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    });

    debug(`[${user.id}] Found ${streams.length} streams, total=${total}`);

    return c.json({
      data: streams.map(transformStream),
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// GET /api/streams/available-categories - get available categories based on user's tier
// IMPORTANT: This must be defined before /:id to avoid route parameter collision
streamsRouter.get("/available-categories", requireAuth, async (c) => {
  const user = c.get("user")!;
  debug(`[${user.id}] GET /available-categories`);

  const userTier = await getUserTier(user.id);
  const allowedCategories = getCategoriesForTier(userTier);

  // All possible categories (excluding 'none')
  const allCategories: Category[] = [
    CATEGORIES.NEWS as Category,
    CATEGORIES.VIDEOS as Category,
    CATEGORIES.SOCIAL as Category,
    CATEGORIES.CUSTOM as Category,
  ];

  debug(
    `[${user.id}] Tier=${userTier}, allowedCategories=${allowedCategories.join(",")}`,
  );

  return c.json({
    data: {
      allowedCategories,
      allCategories,
      tier: userTier,
    },
  });
});

// POST /api/streams - create stream
streamsRouter.post(
  "/",
  requireAuth,
  zValidator("json", CreateStreamSchema),
  async (c) => {
    const user = c.get("user")!;
    const input = c.req.valid("json");
    debug(
      `[${user.id}] POST / - name="${input.name}", categories=${input.categories.join(",")}`,
    );

    // Check stream limit
    const { allowed, error } = await checkStreamLimit(user.id);
    if (!allowed && error) {
      debug(`[${user.id}] Stream limit reached`);
      return c.json({ error }, 403);
    }

    // Filter categories to only those allowed for user's tier
    const userTier = await getUserTier(user.id);
    const filteredCategories = filterCategoriesForTier(
      input.categories,
      userTier,
    );
    debug(
      `[${user.id}] Tier=${userTier}, filteredCategories=${filteredCategories.join(",")}`,
    );

    // Require at least one valid category - no silent fallbacks
    if (filteredCategories.length === 0) {
      debug(`[${user.id}] No valid categories after tier filtering`);
      return c.json(
        {
          error: {
            message:
              "None of the selected categories are available on your current plan. Please select categories available for your tier or upgrade.",
            code: "TIER_RESTRICTION",
            limit: "allowedCategories",
            upgradeUrl: "/pricing",
          },
        },
        403,
      );
    }

    const stream = await prisma.stream.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        categories: JSON.stringify(filteredCategories),
        keywords: input.keywords ? JSON.stringify(input.keywords) : null,
        sortPreference: input.sortPreference ?? "relevancy",
        userId: user.id,
      },
    });

    debug(`[${user.id}] Created stream: id=${stream.id}, name=${stream.name}`);

    return c.json({ data: transformStream(stream) }, 201);
  },
);

// GET /api/streams/:id - get single stream
streamsRouter.get("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const streamId = c.req.param("id");
  debug(`[${user.id}] GET /${streamId}`);

  const stream = await prisma.stream.findFirst({
    where: {
      id: streamId,
      userId: user.id,
    },
  });

  if (!stream) {
    debug(`[${user.id}] Stream not found: id=${streamId}`);
    return c.json(
      { error: { message: "Stream not found", code: "NOT_FOUND" } },
      404,
    );
  }

  debug(`[${user.id}] Found stream: id=${stream.id}, name=${stream.name}`);

  return c.json({ data: transformStream(stream) });
});

// PUT/PATCH /api/streams/:id - update stream
const updateStreamHandler = async (c: any) => {
  const user = c.get("user")!;
  const streamId = c.req.param("id");
  const input = c.req.valid("json");
  debug(
    `[${user.id}] PUT/PATCH /${streamId} - fields=${Object.keys(input).join(",")}`,
  );

  // Check ownership
  debug(`[${user.id}] Verifying ownership of stream: id=${streamId}`);
  await verifyOwnership("stream", streamId, user.id);

  // If categories are being updated, filter to tier-allowed ones
  let categoriesToUpdate: Category[] | undefined;
  if (input.categories !== undefined) {
    const userTier = await getUserTier(user.id);
    const filteredCategories = filterCategoriesForTier(
      input.categories,
      userTier,
    );
    debug(
      `[${user.id}] Category update: requested=${input.categories.join(",")}, filtered=${filteredCategories.join(",")}`,
    );
    // Require at least one valid category - no silent fallbacks
    if (filteredCategories.length === 0) {
      debug(`[${user.id}] No valid categories after tier filtering`);
      return c.json(
        {
          error: {
            message:
              "None of the selected categories are available on your current plan. Please select categories available for your tier or upgrade.",
            code: "TIER_RESTRICTION",
            limit: "allowedCategories",
            upgradeUrl: "/pricing",
          },
        },
        403,
      );
    }
    categoriesToUpdate = filteredCategories;
  }

  const stream = await prisma.stream.update({
    where: { id: streamId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && {
        description: input.description,
      }),
      ...(categoriesToUpdate !== undefined && {
        categories: JSON.stringify(categoriesToUpdate),
      }),
      ...(input.keywords !== undefined && {
        keywords: JSON.stringify(input.keywords),
      }),
      ...(input.sortPreference !== undefined && {
        sortPreference: input.sortPreference,
      }),
    },
  });

  debug(`[${user.id}] Updated stream: id=${stream.id}, name=${stream.name}`);

  return c.json({ data: transformStream(stream) });
};

streamsRouter.put(
  "/:id",
  requireAuth,
  zValidator("json", UpdateStreamSchema),
  updateStreamHandler,
);
streamsRouter.patch(
  "/:id",
  requireAuth,
  zValidator("json", UpdateStreamSchema),
  updateStreamHandler,
);

// DELETE /api/streams/:id - delete stream
streamsRouter.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const streamId = c.req.param("id");
  debug(`[${user.id}] DELETE /${streamId}`);

  // Check ownership
  debug(`[${user.id}] Checking ownership of stream: id=${streamId}`);
  const existing = await prisma.stream.findFirst({
    where: {
      id: streamId,
      userId: user.id,
    },
  });

  if (!existing) {
    debug(`[${user.id}] Stream not found or not owned: id=${streamId}`);
    return c.json(
      { error: { message: "Stream not found", code: "NOT_FOUND" } },
      404,
    );
  }

  debug(
    `[${user.id}] Found stream for deletion: id=${streamId}, name=${existing.name}`,
  );

  // Check if stream is part of any linked streams - block deletion if so
  const linkedStreamLinks = await prisma.linkedStreamMember.findMany({
    where: { streamId },
    include: {
      linkedStream: {
        select: { id: true, name: true },
      },
    },
  });

  if (linkedStreamLinks.length > 0) {
    const linkedStreamNames = linkedStreamLinks
      .map((l) => l.linkedStream.name)
      .join(", ");
    debug(
      `[${user.id}] Cannot delete: stream in ${linkedStreamLinks.length} linked streams`,
    );
    return c.json(
      {
        error: {
          message: `Cannot delete: this stream is part of ${linkedStreamLinks.length} linked stream(s): ${linkedStreamNames}. Remove it from these linked streams first, or delete the linked streams.`,
          code: "STREAM_IN_LINKED_STREAM",
          linkedStreams: linkedStreamLinks.map((l) => ({
            id: l.linkedStream.id,
            name: l.linkedStream.name,
          })),
        },
      },
      400,
    );
  }

  // Check for published newsletters - we want to preserve these
  const publishedNewsletters = await prisma.newsletter.count({
    where: {
      streamId,
      status: "published",
    },
  });

  debug(
    `[${user.id}] Stream has ${publishedNewsletters} published newsletters`,
  );

  if (publishedNewsletters > 0) {
    debug(
      `[${user.id}] Preserving published newsletters, cleaning up related data`,
    );
    await prisma.$transaction(async (tx) => {
      // Preserve the stream name in published newsletters before deleting
      await tx.newsletter.updateMany({
        where: {
          streamId,
          status: "published",
        },
        data: {
          streamName: existing.name,
        },
      });

      // Delete draft newsletters and their items
      await tx.newsletterItem.deleteMany({
        where: {
          newsletter: {
            streamId,
            status: "draft",
          },
        },
      });

      await tx.newsletter.deleteMany({
        where: {
          streamId,
          status: "draft",
        },
      });

      // Soft delete content items (extension methods don't work in transactions)
      await tx.contentItem.updateMany({
        where: { streamId },
        data: { deletedAt: new Date() },
      });

      // Soft delete templates (extension methods don't work in transactions)
      await tx.template.updateMany({
        where: { streamId },
        data: { deletedAt: new Date() },
      });

      // Delete fetch history
      await tx.streamFetchHistory.deleteMany({
        where: { streamId },
      });

      // Finally delete the stream - published newsletters will have streamId set to null via SetNull
      await tx.stream.delete({
        where: { id: streamId },
      });
    });
  } else {
    debug(`[${user.id}] No published newsletters, cascading delete`);
    // No published newsletters, safe to delete everything
    await prisma.stream.delete({
      where: { id: streamId },
    });
  }

  debug(`[${user.id}] Deleted stream: id=${streamId}`);

  return c.body(null, 204);
});

// POST /api/streams/generate-keywords - generate keywords with AI (tier restricted)
streamsRouter.post(
  "/generate-keywords",
  requireAuth,
  zValidator("json", GenerateKeywordsSchema),
  async (c) => {
    const user = c.get("user")!;
    const input = c.req.valid("json");
    debug(`[${user.id}] POST /generate-keywords - name="${input.name}"`);

    // Check if AI is configured
    if (!isAIConfigured()) {
      debug(`[${user.id}] AI not configured`);
      return c.json(
        {
          error: {
            message: "AI is not configured. Please contact support.",
            code: "AI_NOT_CONFIGURED",
          },
        },
        400,
      );
    }

    // Check AI credits for keyword generation (2 credits)
    const creditCheck = await checkAICredits(user.id, "keywordGeneration");
    if (!creditCheck.allowed) {
      debug(`[${user.id}] AI credit limit reached`);
      return c.json(
        {
          error: {
            code: "LIMIT_EXCEEDED",
            message: `Insufficient AI credits. This operation requires ${creditCheck.cost} credits.`,
            limit: "aiCredits",
            current: creditCheck.current,
            max: creditCheck.limit,
            cost: creditCheck.cost,
            resetAt: creditCheck.resetAt.toISOString(),
            upgradeUrl: "/pricing",
          },
        },
        403,
      );
    }

    try {
      debug(`[${user.id}] Calling AI to generate keywords`);
      const keywords = await generateStreamKeywords(
        input.name,
        input.description,
      );
      debug(
        `[${user.id}] AI generated ${keywords.length} keywords: ${keywords.join(", ")}`,
      );

      // Deduct AI credits for keyword generation
      await deductAICredits(user.id, "keywordGeneration");

      return c.json({ data: { keywords } });
    } catch (err) {
      logError("STREAMS", "Error generating keywords:", err);
      return c.json(
        {
          error: {
            message:
              "AI service is temporarily unavailable. Please try again later or add keywords manually.",
            code: "AI_GENERATION_FAILED",
          },
        },
        503,
      );
    }
  },
);

export { streamsRouter };
