import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../../prisma";
import {
  GeneratePreviewSchema,
  GenerateNotesFromItemsSchema,
} from "../../types";
import {
  generateNewsletterContent,
  generateItemNotes,
  generateFallbackContent,
  isAIConfigured,
  type GenerateContentOptions,
} from "../../services/ai";
import { buildDefaultMklySource } from "../../services/mkly-utils";
import {
  checkAICredits,
  deductAICredits,
  getUserTier,
} from "../../middleware/tier-limits";
import {
  filterCategoriesForTier,
  isCategoryAllowedForTier,
} from "../../config/tiers";
import { requireAuth, type AuthVariables } from "../../middleware/auth";
import { resolveMediaUrl } from "../../lib/storage";
import { logError } from "../../lib/debug";
import {
  transformContentItem,
  transformNewsletterWithItems,
  parseCategories,
  type ContentItem,
  type Category,
} from "./shared";
import { createDebugger } from "../../lib/debug";

const debugRegenerate = createDebugger("REGENERATE");
const debugPreview = createDebugger("PREVIEW");
const debugTemplate = createDebugger("TEMPLATE");
const debugGenerateNotes = createDebugger("GENERATE-NOTES");

// Schema for optional regenerate request body
const RegenerateBodySchema = z
  .object({
    contentItemIds: z.array(z.string()).optional(),
    itemNotes: z.record(z.string(), z.string()).optional(),
  })
  .optional();

const generateRouter = new Hono<{ Variables: AuthVariables }>();

// POST /newsletters/:id/regenerate - regenerate newsletter content with AI
generateRouter.post("/newsletters/:id/regenerate", requireAuth, async (c) => {
  const user = c.get("user")!;
  const newsletterId = c.req.param("id");

  debugRegenerate(`Starting regeneration for newsletter ID: ${newsletterId}`);

  // Parse optional body
  let body: z.infer<typeof RegenerateBodySchema> = undefined;
  try {
    const rawBody = await c.req.json();
    const parsed = RegenerateBodySchema.safeParse(rawBody);
    if (parsed.success) {
      body = parsed.data;
    }
  } catch {
    // No body or invalid JSON - that's fine, body stays undefined
  }

  debugRegenerate(
    `Body provided: ${!!body}, contentItemIds: ${body?.contentItemIds?.length ?? "none"}, itemNotes: ${body?.itemNotes ? Object.keys(body.itemNotes).length : "none"}`,
  );

  // Check AI credits for content regeneration (8 credits)
  const creditCheck = await checkAICredits(user.id, "contentRegeneration");
  if (!creditCheck.allowed) {
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

  // Fetch newsletter with items
  const newsletter = await prisma.newsletter.findFirst({
    where: {
      id: newsletterId,
      userId: user.id,
    },
    include: {
      items: {
        include: {
          contentItem: true,
        },
        orderBy: { order: "asc" },
      },
      stream: true,
      template: true,
    },
  });

  if (!newsletter) {
    debugRegenerate(`Newsletter not found: ${newsletterId}`);
    return c.json(
      { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
      404,
    );
  }

  debugRegenerate(
    `Newsletter ID: ${newsletter.id}, Items count from DB: ${newsletter.items.length}`,
  );
  debugRegenerate(
    `Item IDs from DB: ${newsletter.items.map((i) => i.contentItem?.id ?? "null").join(", ")}`,
  );

  // Determine if we should use body items or DB items
  const useBodyItems = body?.contentItemIds && body.contentItemIds.length > 0;
  debugRegenerate(
    `Using items from: ${useBodyItems ? "request body" : "database"}`,
  );

  if (!useBodyItems && newsletter.items.length === 0) {
    return c.json(
      {
        error: {
          message: "Cannot regenerate newsletter without content items",
          code: "NO_ITEMS",
        },
      },
      400,
    );
  }

  // Get mkly template source
  let mklySource: string | null = null;

  if (newsletter.template) {
    debugTemplate(
      `Using newsletter's attached template - ID: ${newsletter.template.id}, Name: ${newsletter.template.name}`,
    );
    mklySource = newsletter.template.mklySource;
  }

  // If no template, check for active template on stream
  if (!mklySource && newsletter.streamId) {
    const activeTemplate = await prisma.template.findFirst({
      where: {
        streamId: newsletter.streamId,
        isActive: true,
      },
    });

    if (activeTemplate) {
      debugTemplate(
        `Using active stream template - ID: ${activeTemplate.id}, Name: ${activeTemplate.name}`,
      );
      mklySource = activeTemplate.mklySource;
    } else {
      debugTemplate(
        `No active template found for stream: ${newsletter.streamId}`,
      );
    }
  }

  // Get user's tier for category filtering
  const userTier = await getUserTier(user.id);

  // If still no template, create a default mkly source with tier-filtered categories
  if (!mklySource) {
    debugTemplate(`No template found, creating default mkly template`);
    const streamCategories = newsletter.stream
      ? (parseCategories(newsletter.stream.categories) as Category[])
      : [];
    const filteredCategories = filterCategoriesForTier(
      streamCategories,
      userTier,
    );

    // No fallback to news - if no categories are allowed, return error
    if (filteredCategories.length === 0) {
      return c.json(
        {
          error: {
            message:
              "This stream uses categories not available on your current plan. Please upgrade or edit the stream to add allowed categories.",
            code: "TIER_RESTRICTION",
            limit: "allowedCategories",
            upgradeUrl: "/pricing",
          },
        },
        403,
      );
    }

    mklySource = buildDefaultMklySource("Default", filteredCategories);
  }

  debugTemplate(`Using mkly template: ${mklySource.length} chars`);

  // Transform content items and filter to only tier-allowed categories
  let contentItems: ContentItem[];

  if (useBodyItems) {
    // Fetch items from ContentItem table
    const contentItemIds = body!.contentItemIds!;
    debugRegenerate(`Fetching items from body: ${contentItemIds.join(", ")}`);

    const fetchedContentItems = await prisma.contentItem.findMany({
      where: { id: { in: contentItemIds } },
    });

    debugRegenerate(
      `Items from ContentItem table: ${fetchedContentItems.length}, IDs: ${fetchedContentItems.map((i) => i.id).join(", ")}`,
    );

    // Transform all items
    const allItems: ContentItem[] = fetchedContentItems.map((item) =>
      transformContentItem(item),
    );

    // Filter to only tier-allowed categories
    contentItems = allItems.filter((item) =>
      isCategoryAllowedForTier(item.category, userTier),
    );

    debugRegenerate(`Items after tier filtering: ${contentItems.length}`);

    if (contentItems.length === 0) {
      return c.json(
        { error: { message: "No content items found", code: "NO_ITEMS" } },
        400,
      );
    }

    // Update newsletter's items in DB with new items
    debugRegenerate(
      `Updating newsletter items in DB with ${contentItemIds.length} items`,
    );
    await prisma.$transaction(async (tx) => {
      // Delete existing newsletter items
      await tx.newsletterItem.deleteMany({
        where: { newsletterId },
      });

      // Create new newsletter items
      const contentItemIdsSet = new Set(fetchedContentItems.map((i) => i.id));
      const itemsToCreate = contentItemIds
        .filter((id) => contentItemIdsSet.has(id))
        .map((contentItemId, index) => ({
          newsletterId,
          contentItemId,
          order: index,
        }));

      if (itemsToCreate.length > 0) {
        await tx.newsletterItem.createMany({
          data: itemsToCreate,
        });
      }
    });
    debugRegenerate(`Newsletter items updated in DB`);
  } else {
    // Use items from DB (existing behavior)
    contentItems = newsletter.items
      .filter((item) => item.contentItem !== null)
      .map((item) => transformContentItem(item.contentItem!))
      .filter((item) => isCategoryAllowedForTier(item.category, userTier));
  }

  debugRegenerate(`Items being regenerated: ${contentItems.length}`);
  debugRegenerate(
    `Item titles: ${contentItems.map((i) => i.title).join(" | ")}`,
  );

  // Generate new content - use AI if available, otherwise fallback
  let newContent: string;
  const streamName =
    newsletter.stream?.name ?? newsletter.streamName ?? "Newsletter";
  const itemNotes = body?.itemNotes;

  // Build style learning options
  const styleOptions: GenerateContentOptions = {
    templateId: newsletter.templateId ?? undefined,
    templateType: "stream",
    userId: user.id,
  };

  if (isAIConfigured()) {
    try {
      newContent = await generateNewsletterContent(
        mklySource,
        contentItems,
        streamName,
        newsletter.title,
        itemNotes,
        styleOptions,
      );
      await deductAICredits(user.id, "contentRegeneration");
    } catch (error) {
      logError(
        "Newsletters",
        "Error generating AI content, using fallback:",
        error,
      );
      newContent = generateFallbackContent(
        mklySource,
        contentItems,
        streamName,
        newsletter.title,
        itemNotes,
      );
    }
  } else {
    // Use fallback content when AI is not configured
    newContent = generateFallbackContent(
      mklySource,
      contentItems,
      streamName,
      newsletter.title,
      itemNotes,
    );
  }

  // Update newsletter with new content (and save AI-generated content for edit-diff tracking)
  const updatedNewsletter = await prisma.newsletter.update({
    where: { id: newsletterId },
    data: { content: newContent, generatedContent: newContent },
    include: {
      items: {
        include: {
          contentItem: true,
        },
        orderBy: { order: "asc" },
      },
    },
  });

  return c.json({ data: transformNewsletterWithItems(updatedNewsletter) });
});

// POST /newsletters/:id/generate-notes - generate AI notes for newsletter items
generateRouter.post(
  "/newsletters/:id/generate-notes",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");

    // Check AI credits for notes generation (3 credits)
    const creditCheck = await checkAICredits(user.id, "notesGeneration");
    if (!creditCheck.allowed) {
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

    // Check if AI is configured
    if (!isAIConfigured()) {
      return c.json(
        {
          error: {
            message:
              "AI content generation is not configured. Please set your Google API key in the ENV tab.",
            code: "AI_NOT_CONFIGURED",
          },
        },
        400,
      );
    }

    // Fetch newsletter with items and verify ownership
    const newsletter = await prisma.newsletter.findFirst({
      where: {
        id: newsletterId,
        userId: user.id,
      },
      include: {
        items: {
          include: {
            contentItem: true,
          },
          orderBy: { order: "asc" },
        },
        stream: true,
      },
    });

    if (!newsletter) {
      return c.json(
        { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
        404,
      );
    }

    if (newsletter.items.length === 0) {
      return c.json(
        {
          error: {
            message: "Cannot generate notes without content items",
            code: "NO_ITEMS",
          },
        },
        400,
      );
    }

    // Transform content items for the AI
    const contentItems: ContentItem[] = newsletter.items
      .filter((item) => item.contentItem !== null)
      .map((item) => transformContentItem(item.contentItem!));

    try {
      // Generate notes using AI
      const streamNameForNotes =
        newsletter.stream?.name ?? newsletter.streamName ?? "Newsletter";
      const generatedNotes = await generateItemNotes(
        contentItems,
        streamNameForNotes,
      );

      // Deduct AI credits for notes generation
      await deductAICredits(user.id, "notesGeneration");

      return c.json({ data: { notes: generatedNotes } });
    } catch (error) {
      logError("Newsletters", "Error generating item notes:", error);
      return c.json(
        {
          error: {
            message: "Failed to generate notes with AI",
            code: "AI_GENERATION_FAILED",
          },
        },
        500,
      );
    }
  },
);

// POST /newsletters/preview - generate preview without saving (for new/draft newsletters)
generateRouter.post(
  "/newsletters/preview",
  requireAuth,
  zValidator("json", GeneratePreviewSchema),
  async (c) => {
    const user = c.get("user")!;
    const input = c.req.valid("json");

    debugPreview(`Starting preview generation`);
    debugPreview(`Input - contentItemIds: ${input.contentItemIds.join(", ")}`);
    debugPreview(
      `Input - templateId: ${input.templateId ?? "none"}, streamId: ${input.streamId ?? "none"}, linkedStreamId: ${input.linkedStreamId ?? "none"}`,
    );

    // Check AI credits for preview generation (10 credits)
    const creditCheck = await checkAICredits(user.id, "previewGeneration");
    if (!creditCheck.allowed) {
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

    let streamName: string;
    let streamCategories: Category[];
    let mklySource: string | null = null;

    // Handle stream or linked stream
    if (input.streamId) {
      // Check stream ownership
      const stream = await prisma.stream.findFirst({
        where: {
          id: input.streamId,
          userId: user.id,
        },
      });

      if (!stream) {
        return c.json(
          { error: { message: "Stream not found", code: "NOT_FOUND" } },
          404,
        );
      }

      streamName = stream.name;
      streamCategories = parseCategories(stream.categories) as Category[];

      // Get template structure for stream
      if (input.templateId) {
        const template = await prisma.template.findFirst({
          where: {
            id: input.templateId,
            streamId: input.streamId,
          },
        });

        if (template) {
          debugTemplate(
            `Using specified stream template - ID: ${template.id}, Name: ${template.name}`,
          );
          mklySource = template.mklySource;

        } else {
          debugTemplate(`Specified template not found: ${input.templateId}`);
        }
      } else {
        // Check for active template
        const activeTemplate = await prisma.template.findFirst({
          where: {
            streamId: input.streamId,
            isActive: true,
          },
        });

        if (activeTemplate) {
          debugTemplate(
            `Using active stream template - ID: ${activeTemplate.id}, Name: ${activeTemplate.name}`,
          );
          mklySource = activeTemplate.mklySource;

        } else {
          debugTemplate(
            `No active template found for stream: ${input.streamId}`,
          );
        }
      }
    } else if (input.linkedStreamId) {
      // Check linked stream ownership
      const linkedStream = await prisma.linkedStream.findFirst({
        where: {
          id: input.linkedStreamId,
          userId: user.id,
        },
        include: {
          members: true,
        },
      });

      if (!linkedStream) {
        return c.json(
          { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
          404,
        );
      }

      streamName = linkedStream.name;

      // Get streams to collect categories
      const streamIds = linkedStream.members.map((m) => m.streamId);
      const streams = await prisma.stream.findMany({
        where: { id: { in: streamIds } },
        select: { categories: true },
      });

      // Collect categories from all linked streams
      const allCategories = new Set<Category>();
      for (const stream of streams) {
        const cats = parseCategories(stream.categories) as Category[];
        cats.forEach((cat) => allCategories.add(cat));
      }
      streamCategories = Array.from(allCategories);

      // Get template structure for linked stream
      if (input.templateId) {
        const template = await prisma.linkedStreamTemplate.findFirst({
          where: {
            id: input.templateId,
            linkedStreamId: input.linkedStreamId,
          },
        });

        if (template) {
          debugTemplate(
            `Using specified linked stream template - ID: ${template.id}, Name: ${template.name}`,
          );
          mklySource = template.mklySource;

        } else {
          debugTemplate(
            `Specified linked stream template not found: ${input.templateId}`,
          );
        }
      } else {
        // Check for active template
        const activeTemplate = await prisma.linkedStreamTemplate.findFirst({
          where: {
            linkedStreamId: input.linkedStreamId,
            isActive: true,
          },
        });

        if (activeTemplate) {
          debugTemplate(
            `Using active linked stream template - ID: ${activeTemplate.id}, Name: ${activeTemplate.name}`,
          );
          mklySource = activeTemplate.mklySource;

        } else {
          debugTemplate(
            `No active template found for linked stream: ${input.linkedStreamId}`,
          );
        }
      }
    } else {
      return c.json(
        {
          error: {
            message: "Either streamId or linkedStreamId is required",
            code: "VALIDATION_ERROR",
          },
        },
        400,
      );
    }

    // Get user's tier for category filtering
    const userTier = await getUserTier(user.id);

    // If no template found, create a default mkly source with tier-filtered categories
    if (!mklySource) {
      debugTemplate(`No template found, creating default mkly template`);
      const categories = filterCategoriesForTier(streamCategories, userTier);

      // No fallback to news - if no categories are allowed, return error
      if (categories.length === 0) {
        return c.json(
          {
            error: {
              message:
                "This stream uses categories not available on your current plan. Please upgrade or edit the stream to add allowed categories.",
              code: "TIER_RESTRICTION",
              limit: "allowedCategories",
              upgradeUrl: "/pricing",
            },
          },
          403,
        );
      }

      mklySource = buildDefaultMklySource("Default", categories);
    }

    debugTemplate(`Using mkly template: ${mklySource.length} chars`);

    // Fetch content items from both ContentItem and LinkedStreamCustomItem tables
    const [contentItems, customItems] = await Promise.all([
      prisma.contentItem.findMany({
        where: { id: { in: input.contentItemIds } },
      }),
      input.linkedStreamId
        ? prisma.linkedStreamCustomItem.findMany({
            where: { id: { in: input.contentItemIds } },
          })
        : Promise.resolve([]),
    ]);

    debugPreview(
      `Items found in ContentItem table: ${contentItems.length}, IDs: ${contentItems.map((i) => i.id).join(", ")}`,
    );
    debugPreview(
      `Items found in LinkedStreamCustomItem table: ${customItems.length}, IDs: ${customItems.map((i) => i.id).join(", ")}`,
    );

    // Validate that all requested items were found
    const foundContentItemIds = new Set(contentItems.map((i) => i.id));
    const foundCustomItemIds = new Set(customItems.map((i) => i.id));
    const allFoundIds = new Set([
      ...foundContentItemIds,
      ...foundCustomItemIds,
    ]);

    const missingIds = input.contentItemIds.filter(
      (id) => !allFoundIds.has(id),
    );

    if (missingIds.length > 0) {
      debugPreview(
        `WARNING: ${missingIds.length} item IDs not found in either table`,
      );
      debugPreview(`Missing IDs: ${missingIds.join(", ")}`);

      // If more than half the items are missing, return an error
      if (missingIds.length > input.contentItemIds.length / 2) {
        return c.json(
          {
            error: {
              message: `Most requested items not found. ${missingIds.length} of ${input.contentItemIds.length} items are missing.`,
              code: "ITEMS_NOT_FOUND",
              details: {
                requestedCount: input.contentItemIds.length,
                foundCount: allFoundIds.size,
                missingCount: missingIds.length,
                missingIds: missingIds.slice(0, 10),
              },
            },
          },
          400,
        );
      }
    }

    debugPreview(
      `Item lookup summary: requested=${input.contentItemIds.length}, found=${allFoundIds.size}, missing=${missingIds.length}`,
    );

    // Combine and transform all items
    const allItems: ContentItem[] = [
      ...contentItems.map((item) => transformContentItem(item)),
      ...customItems.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url ?? "",
        description: item.description,
        imageUrl: item.imageUrl,
        source: item.source,
        category: item.category as Category,
        author: item.author,
        publishedAt: item.publishedAt,
        metadata: item.metadata ? JSON.parse(item.metadata) : null,
        createdAt: item.createdAt,
        batchId: null,
        fetchedAt: item.createdAt,
        streamId: input.linkedStreamId!,
        isCustomItem: true,
      })),
    ];

    debugPreview(`Combined items being sent to AI: ${allItems.length}`);
    debugPreview(
      `Combined item titles: ${allItems.map((i) => i.title).join(" | ")}`,
    );

    if (allItems.length === 0) {
      debugPreview(`No content items found, returning error`);
      return c.json(
        { error: { message: "No content items found", code: "NO_ITEMS" } },
        400,
      );
    }

    // Filter to only tier-allowed categories
    const transformedItems: ContentItem[] = allItems.filter((item) =>
      isCategoryAllowedForTier(item.category, userTier),
    );

    debugPreview(`After tier filtering: ${transformedItems.length} items`);

    // Resolve any media:// image URLs to signed URLs for AI
    for (const item of transformedItems) {
      if (item.imageUrl?.startsWith("media://")) {
        item.imageUrl = await resolveMediaUrl(item.imageUrl);
      }
    }

    // Build style learning options for preview
    const previewStyleOptions: GenerateContentOptions = {
      templateId: input.templateId ?? undefined,
      templateType: input.linkedStreamId ? "linkedStream" : "stream",
      userId: user.id,
    };

    // Generate content
    let content: string;

    if (isAIConfigured()) {
      try {
        content = await generateNewsletterContent(
          mklySource,
          transformedItems,
          streamName,
          input.title,
          input.itemNotes,
          previewStyleOptions,
        );
        await deductAICredits(user.id, "previewGeneration");
      } catch (error) {
        logError("Newsletters", "Error generating AI preview content:", error);
        content = generateFallbackContent(
          mklySource,
          transformedItems,
          streamName,
          input.title,
          input.itemNotes,
        );
      }
    } else {
      content = generateFallbackContent(
        mklySource,
        transformedItems,
        streamName,
        input.title,
        input.itemNotes,
      );
    }

    return c.json({ data: { content } });
  },
);

// POST /newsletters/generate-notes-from-items - generate notes from content item IDs (no newsletter required)
generateRouter.post(
  "/newsletters/generate-notes-from-items",
  requireAuth,
  zValidator("json", GenerateNotesFromItemsSchema),
  async (c) => {
    const user = c.get("user")!;
    const input = c.req.valid("json");

    // Check AI credits for notes generation (3 credits)
    const creditCheck = await checkAICredits(user.id, "notesGeneration");
    if (!creditCheck.allowed) {
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

    // Check if AI is configured
    if (!isAIConfigured()) {
      return c.json(
        {
          error: {
            message:
              "AI content generation is not configured. Please set your Google API key in the ENV tab.",
            code: "AI_NOT_CONFIGURED",
          },
        },
        400,
      );
    }

    let streamName: string;
    let streamIds: string[] = [];

    if (input.streamId) {
      // Check stream ownership
      const stream = await prisma.stream.findFirst({
        where: {
          id: input.streamId,
          userId: user.id,
        },
      });

      if (!stream) {
        return c.json(
          { error: { message: "Stream not found", code: "NOT_FOUND" } },
          404,
        );
      }

      streamName = stream.name;
      streamIds = [input.streamId];
    } else if (input.linkedStreamId) {
      // Check linked stream ownership
      const linkedStream = await prisma.linkedStream.findFirst({
        where: {
          id: input.linkedStreamId,
          userId: user.id,
        },
        include: {
          members: true,
        },
      });

      if (!linkedStream) {
        return c.json(
          { error: { message: "Linked stream not found", code: "NOT_FOUND" } },
          404,
        );
      }

      streamName = linkedStream.name;
      streamIds = linkedStream.members.map((m) => m.streamId);
    } else {
      return c.json(
        {
          error: {
            message: "Either streamId or linkedStreamId is required",
            code: "VALIDATION_ERROR",
          },
        },
        400,
      );
    }

    // Fetch content items from both ContentItem and LinkedStreamCustomItem tables
    const [contentItems, customItems] = await Promise.all([
      prisma.contentItem.findMany({
        where: {
          id: { in: input.contentItemIds },
          streamId: { in: streamIds },
        },
      }),
      input.linkedStreamId
        ? prisma.linkedStreamCustomItem.findMany({
            where: {
              id: { in: input.contentItemIds },
              linkedStreamId: input.linkedStreamId,
            },
          })
        : Promise.resolve([]),
    ]);

    debugGenerateNotes(
      `Items found in ContentItem table: ${contentItems.length}`,
    );
    debugGenerateNotes(
      `Items found in LinkedStreamCustomItem table: ${customItems.length}`,
    );

    // Validate that items were found
    const foundContentItemIds = new Set(contentItems.map((i) => i.id));
    const foundCustomItemIds = new Set(customItems.map((i) => i.id));
    const allFoundIds = new Set([
      ...foundContentItemIds,
      ...foundCustomItemIds,
    ]);

    const missingIds = input.contentItemIds.filter(
      (id) => !allFoundIds.has(id),
    );

    if (missingIds.length > 0) {
      debugGenerateNotes(`WARNING: ${missingIds.length} item IDs not found`);
      debugGenerateNotes(`Missing IDs: ${missingIds.join(", ")}`);
    }

    debugGenerateNotes(
      `Item lookup summary: requested=${input.contentItemIds.length}, found=${allFoundIds.size}, missing=${missingIds.length}`,
    );

    // Combine and transform all items
    const transformedItems: ContentItem[] = [
      ...contentItems.map(transformContentItem),
      ...customItems.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url ?? "",
        description: item.description,
        imageUrl: item.imageUrl,
        source: item.source,
        category: item.category as Category,
        author: item.author,
        publishedAt: item.publishedAt,
        metadata: item.metadata ? JSON.parse(item.metadata) : null,
        createdAt: item.createdAt,
        batchId: null,
        fetchedAt: item.createdAt,
        streamId: input.linkedStreamId!,
        isCustomItem: true,
      })),
    ];

    if (transformedItems.length === 0) {
      return c.json(
        { error: { message: "No content items found", code: "NO_ITEMS" } },
        400,
      );
    }

    try {
      // Generate notes using AI
      const generatedNotes = await generateItemNotes(
        transformedItems,
        streamName,
      );

      // Deduct AI credits for notes generation
      await deductAICredits(user.id, "notesGeneration");

      return c.json({ data: { notes: generatedNotes } });
    } catch (error) {
      logError("Newsletters", "Error generating item notes:", error);
      return c.json(
        {
          error: {
            message: "Failed to generate notes with AI",
            code: "AI_GENERATION_FAILED",
          },
        },
        500,
      );
    }
  },
);

export { generateRouter };
