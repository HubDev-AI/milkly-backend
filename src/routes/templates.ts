import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import {
  CreateTemplateSchema,
  CreateGlobalTemplateSchema,
  UpdateTemplateSchema,
  AllTemplatesQuerySchema,
  ActivateTemplateSchema,
  DeleteTemplateQuerySchema,
  DuplicateTemplateSchema,
  ApplyTemplateSchema,
  TemplatePreviewSchema,
  TemplatesPaginationQuerySchema,
  parseCategories,
  parseKeywords,
  calculatePagination,
  type Template,
  type TemplateWithStream,
  type TemplateCustomization,
  type Category,
  type ContentItem,
} from "../types";
import { env } from "../env";
import {
  generateMklyTemplate,
  isAIConfigured,
} from "../services/ai";
import { buildDefaultMklySource } from "../services/mkly-utils";
import { stripTemplateContent } from "../services/template-content";
import {
  activateTemplate as activateTemplateService,
  deactivateTemplate as deactivateTemplateService,
  deleteTemplate as deleteTemplateService,
  duplicateTemplate as duplicateTemplateService,
  type TemplateType,
} from "../services/templates";
import { transformContentItem } from "../services/feed";
import { createDebugger, logError } from "../lib/debug";
import { resolveMediaUrl } from "../lib/storage";
import {
  requireAICredits,
  deductCreditsFromContext,
} from "../middleware/tier-limits";

const debug = createDebugger("TEMPLATES-ROUTE");
import { requireAuth, type AuthVariables } from "../middleware/auth";
import crypto from "crypto";

const templatesRouter = new Hono<{ Variables: AuthVariables }>();

// GET /api/templates - Fetch all templates for a user across streams, linked streams, and global templates
templatesRouter.get(
  "/templates",
  requireAuth,
  zValidator("query", AllTemplatesQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const { page, limit, streamType, isActive, search, isGlobal } =
      c.req.valid("query");

    debug(
      `[${user.id}] GET /templates - streamType=${streamType}, isActive=${isActive}, isGlobal=${isGlobal}, search=${search || "none"}, page=${page}, limit=${limit}`,
    );

    // Build where clauses for each template type
    const streamWhere: {
      stream: { userId: string };
      isGlobal: boolean;
      isActive?: boolean;
      name?: { contains: string; mode: "insensitive" };
    } = {
      stream: { userId: user.id },
      isGlobal: false,
    };

    const linkedStreamWhere: {
      linkedStream: { userId: string };
      isActive?: boolean;
      name?: { contains: string; mode: "insensitive" };
    } = {
      linkedStream: { userId: user.id },
    };

    const globalWhere: {
      userId: string;
      isGlobal: boolean;
      isActive?: boolean;
      name?: { contains: string; mode: "insensitive" };
    } = {
      userId: user.id,
      isGlobal: true,
    };

    if (isActive !== undefined) {
      streamWhere.isActive = isActive;
      linkedStreamWhere.isActive = isActive;
      globalWhere.isActive = isActive;
    }

    if (search) {
      streamWhere.name = { contains: search, mode: "insensitive" };
      linkedStreamWhere.name = { contains: search, mode: "insensitive" };
      globalWhere.name = { contains: search, mode: "insensitive" };
    }

    // Determine which template types to include based on streamType and isGlobal filters
    let includeStreams = streamType === "all" || streamType === "stream";
    let includeLinkedStreams =
      streamType === "all" || streamType === "linkedStream";
    let includeGlobal = streamType === "all" || streamType === "global";

    // If isGlobal filter is explicitly set, override the streamType logic
    if (isGlobal === true) {
      includeStreams = false;
      includeLinkedStreams = false;
      includeGlobal = true;
    } else if (isGlobal === false) {
      includeGlobal = false;
    }

    // Get counts and data in parallel
    const [
      streamTemplatesCount,
      linkedStreamTemplatesCount,
      globalTemplatesCount,
      streamTemplates,
      linkedStreamTemplates,
      globalTemplates,
    ] = await Promise.all([
      includeStreams
        ? prisma.template.count({ where: streamWhere })
        : Promise.resolve(0),
      includeLinkedStreams
        ? prisma.linkedStreamTemplate.count({ where: linkedStreamWhere })
        : Promise.resolve(0),
      includeGlobal
        ? prisma.template.count({ where: globalWhere })
        : Promise.resolve(0),
      includeStreams
        ? prisma.template.findMany({
            where: streamWhere,
            include: { stream: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      includeLinkedStreams
        ? prisma.linkedStreamTemplate.findMany({
            where: linkedStreamWhere,
            include: { linkedStream: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      includeGlobal
        ? prisma.template.findMany({
            where: globalWhere,
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
    ]);

    // Transform and combine results (filter out templates without streams, then assert non-null)
    const streamTemplateResults: TemplateWithStream[] = streamTemplates
      .filter((t) => t.stream !== null)
      .map((t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        mklySource: t.mklySource,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        streamType: "stream" as const,
        streamId: t.stream!.id,
        streamName: t.stream!.name,
      }));

    const linkedStreamTemplateResults: TemplateWithStream[] =
      linkedStreamTemplates.map((t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        mklySource: t.mklySource,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        streamType: "linkedStream" as const,
        streamId: t.linkedStream.id,
        streamName: t.linkedStream.name,
      }));

    // Transform global templates - set streamId and streamName to null
    const globalTemplateResults: TemplateWithStream[] = globalTemplates.map(
      (t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        mklySource: t.mklySource,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        streamType: "global" as const,
        streamId: null,
        streamName: null,
      }),
    );

    // Combine and sort by createdAt descending
    const allTemplates = [
      ...streamTemplateResults,
      ...linkedStreamTemplateResults,
      ...globalTemplateResults,
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Calculate total and apply pagination
    const total =
      streamTemplatesCount + linkedStreamTemplatesCount + globalTemplatesCount;
    const paginatedTemplates = allTemplates.slice(
      (page - 1) * limit,
      page * limit,
    );

    debug(
      `[${user.id}] GET /templates - found ${total} total (stream=${streamTemplatesCount}, linkedStream=${linkedStreamTemplatesCount}, global=${globalTemplatesCount}), returning ${paginatedTemplates.length}`,
    );

    return c.json({
      data: paginatedTemplates,
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// Transform DB template to API template
function transformTemplate(dbTemplate: {
  id: string;
  name: string;
  mklySource: string;
  logoUrl?: string | null;
  streamId: string | null;
  userId: string | null;
  isGlobal: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): Template {
  return {
    id: dbTemplate.id,
    name: dbTemplate.name,
    mklySource: dbTemplate.mklySource,
    logoUrl: dbTemplate.logoUrl ?? null,
    streamId: dbTemplate.streamId,
    userId: dbTemplate.userId,
    isGlobal: dbTemplate.isGlobal,
    isActive: dbTemplate.isActive,
    createdAt: dbTemplate.createdAt,
    updatedAt: dbTemplate.updatedAt,
  };
}

// POST /api/templates - Create a global template (not tied to a stream)
templatesRouter.post(
  "/templates",
  requireAuth,
  requireAICredits("templateGeneration"),
  zValidator("json", CreateGlobalTemplateSchema),
  async (c) => {
    const user = c.get("user")!;
    const input = c.req.valid("json");

    debug(
      `[${user.id}] POST /templates (global) - generateWithAI=${input.generateWithAI !== false}, name=${input.name || "auto"}`,
    );

    // Merge newsletterType into customization if provided at top level
    const customization = input.newsletterType
      ? { ...input.customization, newsletterType: input.newsletterType }
      : input.customization;

    // Determine the final newsletterType
    const newsletterType =
      input.newsletterType ?? input.customization?.newsletterType ?? null;

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
        const templateName = input.name || "Global Template";
        debug(
          `Generating global template with AI: name=${templateName}, customization=${JSON.stringify(customization || {})}`,
        );
        mklySource = await generateMklyTemplate(
          templateName,
          [],
          customization,
        );
        debug(`Global template AI generated: ${mklySource.length} chars`);
        // Strip editorial content — save structure only
        mklySource = await stripTemplateContent(mklySource);
      } catch (error) {
        logError("Templates", "Error generating template:", error);
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
        input.name || "Global Template",
        [],
        { primaryColor: "#4A3728", accentColor: "#D4A574" },
      );
    }

    // Use provided name with fallback
    const templateName = input.name || "Global Template";

    // Create global template in database
    // Global templates are active by default so they're visible in streams
    debug(
      `Creating global template in DB: name=${templateName}, newsletterType=${newsletterType || "none"}`,
    );
    const template = await prisma.template.create({
      data: {
        name: templateName,
        mklySource,
        streamId: null,
        userId: user.id,
        isGlobal: true,
        isActive: true,
        newsletterType,
      },
    });

    debug(
      `Global template created: id=${template.id}, isGlobal=true, isActive=true`,
    );

    // Deduct AI credits after successful generation
    await deductCreditsFromContext(c);

    return c.json({ data: transformTemplate(template) }, 201);
  },
);

// GET /api/templates/:id - Get a single template by ID (supports both stream and linked stream templates)
templatesRouter.get("/templates/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const templateId = c.req.param("id");

  debug(`[${user.id}] GET /templates/${templateId}`);

  // First, try to find in Template table (stream templates and global templates)
  const template = await prisma.template.findFirst({
    where: { id: templateId },
    include: { stream: true },
  });

  if (template) {
    // Verify ownership: either direct userId for global templates, or via stream.userId for stream templates
    const isOwnedByUser = template.isGlobal
      ? template.userId === user.id
      : template.stream?.userId === user.id;

    if (!isOwnedByUser) {
      debug(
        `[${user.id}] GET /templates/${templateId} - unauthorized access attempt`,
      );
      return c.json(
        { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
        403,
      );
    }

    debug(
      `[${user.id}] GET /templates/${templateId} - found in Template: name=${template.name}, isGlobal=${template.isGlobal}`,
    );
    return c.json({ data: transformTemplate(template) });
  }

  // If not found in Template table, try LinkedStreamTemplate table
  const linkedStreamTemplate = await prisma.linkedStreamTemplate.findFirst({
    where: { id: templateId },
    include: { linkedStream: true },
  });

  if (linkedStreamTemplate) {
    // Verify ownership via linkedStream.userId
    if (linkedStreamTemplate.linkedStream?.userId !== user.id) {
      debug(
        `[${user.id}] GET /templates/${templateId} - unauthorized access attempt (linked stream template)`,
      );
      return c.json(
        { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
        403,
      );
    }

    debug(
      `[${user.id}] GET /templates/${templateId} - found in LinkedStreamTemplate: name=${linkedStreamTemplate.name}`,
    );

    // Transform linked stream template to match Template interface
    return c.json({
      data: {
        id: linkedStreamTemplate.id,
        name: linkedStreamTemplate.name,
        mklySource: linkedStreamTemplate.mklySource,
        logoUrl: linkedStreamTemplate.logoUrl ?? null,
        streamId: null,
        linkedStreamId: linkedStreamTemplate.linkedStreamId,
        userId: null,
        isGlobal: false,
        isActive: linkedStreamTemplate.isActive,
        createdAt: linkedStreamTemplate.createdAt,
        updatedAt: linkedStreamTemplate.updatedAt,
      },
    });
  }

  // Not found in either table
  return c.json(
    { error: { message: "Template not found", code: "NOT_FOUND" } },
    404,
  );
});

// POST /api/streams/:id/templates - Generate a new template for a stream
templatesRouter.post(
  "/:id/templates",
  requireAuth,
  requireAICredits("templateGeneration"),
  zValidator("json", CreateTemplateSchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const input = c.req.valid("json");

    debug(
      `[${user.id}] POST /streams/${streamId}/templates - generateWithAI=${input.generateWithAI !== false}, setActive=${input.setActive || false}`,
    );

    // Check stream ownership - include description and keywords for context
    const stream = await prisma.stream.findFirst({
      where: {
        id: streamId,
        userId: user.id,
      },
      select: {
        id: true,
        name: true,
        categories: true,
        description: true,
        keywords: true,
      },
    });

    if (!stream) {
      debug(
        `[${user.id}] POST /streams/${streamId}/templates - stream not found`,
      );
      return c.json(
        { error: { message: "Stream not found", code: "NOT_FOUND" } },
        404,
      );
    }

    const categories = parseCategories(stream.categories) as Category[];
    const streamKeywords = parseKeywords(stream.keywords);

    let mklySource: string;

    // Build effective customization: merge user-provided with stream context
    const baseCustomization: TemplateCustomization = {
      ...input.customization,
    };
    if (!baseCustomization.description && stream.description) {
      baseCustomization.description = stream.description;
    }

    // Merge newsletterType into customization if provided at top level
    const customization = input.newsletterType
      ? { ...baseCustomization, newsletterType: input.newsletterType }
      : baseCustomization;

    // Add stream keywords to custom context if available
    if (streamKeywords.length > 0 && !customization.customPrompt) {
      const keywordsNote = `Stream keywords: ${streamKeywords.join(", ")}`;
      customization.customPrompt = keywordsNote;
    } else if (streamKeywords.length > 0 && customization.customPrompt) {
      customization.customPrompt = `Stream keywords: ${streamKeywords.join(", ")}\n${customization.customPrompt}`;
    }

    // Determine the final newsletterType (top-level takes precedence)
    const newsletterType =
      input.newsletterType ?? input.customization?.newsletterType ?? null;

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
        // Fetch recent content items for realistic template content
        const recentItems = await prisma.contentItem.findMany({
          where: { streamId },
          orderBy: { publishedAt: "desc" },
          take: 8,
        });

        debug(
          `Generating template with AI for stream: ${streamId}, name=${stream.name}, categories=${categories.length}, items=${recentItems.length}`,
        );
        mklySource = await generateMklyTemplate(
          stream.name,
          categories,
          customization,
          recentItems.length > 0 ? (recentItems as unknown as ContentItem[]) : undefined,
        );
        debug(`Template AI generated: ${mklySource.length} chars`);
        // Strip editorial content — save structure only
        mklySource = await stripTemplateContent(mklySource);
      } catch (error) {
        logError("Templates", "Error generating template:", error);
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
        input.name || `${stream.name} Template`,
        categories,
        { primaryColor: "#4A3728", accentColor: "#D4A574" },
      );
    }

    // Use provided name with fallback to stream name
    const templateName =
      input.name || stream.name || "Newsletter Template";

    // Create template in database (with transaction for atomicity when setActive)
    debug(
      `Creating stream template in DB: streamId=${streamId}, name=${templateName}, isActive=${input.setActive ?? false}`,
    );
    const template = await prisma.$transaction(async (tx) => {
      // Only deactivate others if setActive is true
      if (input.setActive) {
        debug(`Deactivating other templates for stream: ${streamId}`);
        await tx.template.updateMany({
          where: { streamId, isActive: true },
          data: { isActive: false },
        });
      }

      return tx.template.create({
        data: {
          name: templateName,
          mklySource,
          logoUrl: input.customization?.logoUrl ?? null,
          streamId,
          isActive: input.setActive ?? false,
          newsletterType,
        },
      });
    });

    debug(
      `Stream template created: id=${template.id}, streamId=${streamId}, isActive=${template.isActive}`,
    );

    // Deduct AI credits after successful generation
    await deductCreditsFromContext(c);

    return c.json({ data: transformTemplate(template) }, 201);
  },
);

// GET /api/streams/:id/templates - Get all templates for a stream with pagination
templatesRouter.get(
  "/:id/templates",
  requireAuth,
  zValidator("query", TemplatesPaginationQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const { page, limit } = c.req.valid("query");

    debug(
      `[${user.id}] GET /streams/${streamId}/templates - page=${page}, limit=${limit}`,
    );

    // Check stream ownership
    const stream = await prisma.stream.findFirst({
      where: {
        id: streamId,
        userId: user.id,
      },
    });

    if (!stream) {
      debug(
        `[${user.id}] GET /streams/${streamId}/templates - stream not found`,
      );
      return c.json(
        { error: { message: "Stream not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Get total count
    const total = await prisma.template.count({
      where: { streamId },
    });

    // Get paginated templates
    const templates = await prisma.template.findMany({
      where: { streamId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    });

    debug(
      `[${user.id}] GET /streams/${streamId}/templates - found ${total} total, returning ${templates.length}`,
    );

    return c.json({
      data: templates.map(transformTemplate),
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// PUT /api/templates/:id - Update a template (supports stream, linked stream, and global templates)
templatesRouter.put(
  "/templates/:id",
  requireAuth,
  zValidator("json", UpdateTemplateSchema),
  async (c) => {
    const user = c.get("user")!;
    const templateId = c.req.param("id");
    const input = c.req.valid("json");

    debug(
      `[${user.id}] PUT /templates/${templateId} - updating name=${input.name !== undefined}, mklySource=${input.mklySource !== undefined}`,
    );

    const updateData: {
      name?: string;
      mklySource?: string;
      logoUrl?: string | null;
    } = {};

    if (input.name !== undefined) {
      updateData.name = input.name;
    }

    if (input.mklySource !== undefined) {
      updateData.mklySource = input.mklySource;
    }

    if (input.logoUrl !== undefined) {
      updateData.logoUrl = input.logoUrl;
    }

    // First, try to find in Template table (stream templates and global templates)
    const template = await prisma.template.findFirst({
      where: { id: templateId },
      include: { stream: true },
    });

    if (template) {
      // Verify ownership: either direct userId for global templates, or via stream.userId for stream templates
      const isOwnedByUser = template.isGlobal
        ? template.userId === user.id
        : template.stream?.userId === user.id;

      if (!isOwnedByUser) {
        debug(
          `[${user.id}] PUT /templates/${templateId} - unauthorized access attempt`,
        );
        return c.json(
          { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
          403,
        );
      }

      debug(
        `[${user.id}] PUT /templates/${templateId} - before update: name=${template.name}, isGlobal=${template.isGlobal}`,
      );
      const updatedTemplate = await prisma.template.update({
        where: { id: templateId },
        data: updateData,
      });

      debug(
        `[${user.id}] PUT /templates/${templateId} - updated: name=${updatedTemplate.name}`,
      );
      return c.json({ data: transformTemplate(updatedTemplate) });
    }

    // If not found in Template table, try LinkedStreamTemplate table
    const linkedStreamTemplate = await prisma.linkedStreamTemplate.findFirst({
      where: { id: templateId },
      include: { linkedStream: true },
    });

    if (linkedStreamTemplate) {
      // Verify ownership via linkedStream.userId
      if (linkedStreamTemplate.linkedStream?.userId !== user.id) {
        debug(
          `[${user.id}] PUT /templates/${templateId} - unauthorized access attempt (linked stream template)`,
        );
        return c.json(
          { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
          403,
        );
      }

      debug(
        `[${user.id}] PUT /templates/${templateId} - before update (linked stream): name=${linkedStreamTemplate.name}`,
      );
      const updatedTemplate = await prisma.linkedStreamTemplate.update({
        where: { id: templateId },
        data: updateData,
      });

      debug(
        `[${user.id}] PUT /templates/${templateId} - updated (linked stream): name=${updatedTemplate.name}`,
      );

      // Return in same format as Template
      return c.json({
        data: {
          id: updatedTemplate.id,
          name: updatedTemplate.name,
          mklySource: updatedTemplate.mklySource,
          logoUrl: updatedTemplate.logoUrl ?? null,
          streamId: null,
          linkedStreamId: updatedTemplate.linkedStreamId,
          userId: null,
          isGlobal: false,
          isActive: updatedTemplate.isActive,
          createdAt: updatedTemplate.createdAt,
          updatedAt: updatedTemplate.updatedAt,
        },
      });
    }

    // Not found in either table
    debug(`[${user.id}] PUT /templates/${templateId} - template not found`);
    return c.json(
      { error: { message: "Template not found", code: "NOT_FOUND" } },
      404,
    );
  },
);

// DELETE /api/templates/:id - Delete a template (supports stream, linked stream, and global templates)
templatesRouter.delete(
  "/templates/:id",
  requireAuth,
  zValidator("query", DeleteTemplateQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const templateId = c.req.param("id");
    const { streamType } = c.req.valid("query");

    debug(
      `[${user.id}] DELETE /templates/${templateId} - streamType=${streamType}`,
    );

    try {
      await deleteTemplateService(
        templateId,
        user.id,
        streamType as TemplateType,
      );
      debug(
        `[${user.id}] DELETE /templates/${templateId} - deleted successfully`,
      );
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Template not found") {
          debug(`[${user.id}] DELETE /templates/${templateId} - not found`);
          return c.json(
            { error: { message: "Template not found", code: "NOT_FOUND" } },
            404,
          );
        }
        if (error.message === "Unauthorized") {
          debug(`[${user.id}] DELETE /templates/${templateId} - unauthorized`);
          return c.json(
            { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
            403,
          );
        }
      }
      throw error;
    }
  },
);

// PATCH /api/templates/:id/activate - Activate a template (deactivate others for same stream)
templatesRouter.patch(
  "/templates/:id/activate",
  requireAuth,
  zValidator("json", ActivateTemplateSchema),
  async (c) => {
    const user = c.get("user")!;
    const templateId = c.req.param("id");
    const { streamType } = c.req.valid("json");

    debug(
      `[${user.id}] PATCH /templates/${templateId}/activate - streamType=${streamType}`,
    );

    try {
      const { templateInfo, parentId, parentName } =
        await activateTemplateService(
          templateId,
          user.id,
          streamType as TemplateType,
        );

      debug(
        `[${user.id}] Template activated: id=${templateId}, parentId=${parentId}, isActive=${templateInfo.isActive}`,
      );

      return c.json({
        data: {
          id: templateInfo.id,
          name: templateInfo.name,
          isActive: templateInfo.isActive,
          mklySource: templateInfo.mklySource,
          createdAt: templateInfo.createdAt,
          updatedAt: templateInfo.updatedAt,
          streamType: streamType as "stream" | "linkedStream",
          streamId: parentId,
          streamName: parentName,
        },
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Template not found") {
          debug(
            `[${user.id}] PATCH /templates/${templateId}/activate - not found`,
          );
          return c.json(
            { error: { message: "Template not found", code: "NOT_FOUND" } },
            404,
          );
        }
        if (error.message === "Unauthorized") {
          debug(
            `[${user.id}] PATCH /templates/${templateId}/activate - unauthorized`,
          );
          return c.json(
            { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
            403,
          );
        }
      }
      throw error;
    }
  },
);

// POST /api/templates/:id/duplicate - Duplicate a template
templatesRouter.post(
  "/templates/:id/duplicate",
  requireAuth,
  zValidator("json", DuplicateTemplateSchema),
  async (c) => {
    const user = c.get("user")!;
    const templateId = c.req.param("id");
    const { streamType, name } = c.req.valid("json");

    debug(
      `[${user.id}] POST /templates/${templateId}/duplicate - streamType=${streamType}, name=${name || "auto"}`,
    );

    try {
      const { templateInfo, parentId, parentName } =
        await duplicateTemplateService(
          templateId,
          user.id,
          streamType as TemplateType,
          name,
        );

      debug(
        `[${user.id}] Template duplicated: sourceId=${templateId}, newId=${templateInfo.id}, parentId=${parentId}`,
      );

      return c.json(
        {
          data: {
            id: templateInfo.id,
            name: templateInfo.name,
            isActive: templateInfo.isActive,
            mklySource: templateInfo.mklySource,
            createdAt: templateInfo.createdAt,
            updatedAt: templateInfo.updatedAt,
            streamType: streamType as "stream" | "linkedStream",
            streamId: parentId,
            streamName: parentName,
          },
        },
        201,
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Template not found") {
          debug(
            `[${user.id}] POST /templates/${templateId}/duplicate - not found`,
          );
          return c.json(
            { error: { message: "Template not found", code: "NOT_FOUND" } },
            404,
          );
        }
        if (error.message === "Unauthorized") {
          debug(
            `[${user.id}] POST /templates/${templateId}/duplicate - unauthorized`,
          );
          return c.json(
            { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
            403,
          );
        }
      }
      throw error;
    }
  },
);

// POST /api/templates/:id/apply - Apply global template to a stream
templatesRouter.post(
  "/templates/:id/apply",
  requireAuth,
  zValidator("json", ApplyTemplateSchema),
  async (c) => {
    const user = c.get("user")!;
    const globalTemplateId = c.req.param("id");
    const { streamType, streamId, setActive } = c.req.valid("json");

    debug(
      `[${user.id}] POST /templates/${globalTemplateId}/apply - streamType=${streamType}, streamId=${streamId}, setActive=${setActive}`,
    );

    // Fetch the global template
    const globalTemplate = await prisma.template.findFirst({
      where: { id: globalTemplateId, isGlobal: true, userId: user.id },
    });

    if (!globalTemplate) {
      debug(
        `[${user.id}] POST /templates/${globalTemplateId}/apply - global template not found`,
      );
      return c.json(
        { error: { code: "NOT_FOUND", message: "Global template not found" } },
        404,
      );
    }

    if (streamType === "stream") {
      // Verify user owns the stream
      const stream = await prisma.stream.findFirst({
        where: { id: streamId, userId: user.id },
      });
      if (!stream) {
        debug(
          `[${user.id}] POST /templates/${globalTemplateId}/apply - stream not found: ${streamId}`,
        );
        return c.json(
          { error: { code: "NOT_FOUND", message: "Stream not found" } },
          404,
        );
      }

      // Create copy for stream (with transaction for atomicity when setActive)
      debug(
        `Applying global template ${globalTemplateId} to stream ${streamId}`,
      );
      const newTemplate = await prisma.$transaction(async (tx) => {
        // Deactivate others if setActive
        if (setActive) {
          debug(
            `Deactivating other templates for stream: ${streamId} before applying global template`,
          );
          await tx.template.updateMany({
            where: { streamId: streamId, isActive: true },
            data: { isActive: false },
          });
        }

        return tx.template.create({
          data: {
            name: globalTemplate.name,
            mklySource: globalTemplate.mklySource,
            newsletterType: globalTemplate.newsletterType,
            streamId: streamId,
            isActive: setActive,
            isGlobal: false,
          },
        });
      });

      debug(
        `Global template applied: newId=${newTemplate.id}, streamId=${streamId}, isActive=${setActive}`,
      );
      return c.json(
        {
          data: {
            id: newTemplate.id,
            name: newTemplate.name,
            isActive: newTemplate.isActive,
            mklySource: newTemplate.mklySource,
            createdAt: newTemplate.createdAt,
            updatedAt: newTemplate.updatedAt,
            streamType: "stream" as const,
            streamId: stream.id,
            streamName: stream.name,
          },
        },
        201,
      );
    } else {
      // Verify user owns the linked stream
      const linkedStream = await prisma.linkedStream.findFirst({
        where: { id: streamId, userId: user.id },
      });
      if (!linkedStream) {
        debug(
          `[${user.id}] POST /templates/${globalTemplateId}/apply - linked stream not found: ${streamId}`,
        );
        return c.json(
          { error: { code: "NOT_FOUND", message: "Linked stream not found" } },
          404,
        );
      }

      // Create copy for linked stream (with transaction for atomicity when setActive)
      debug(
        `Applying global template ${globalTemplateId} to linked stream ${streamId}`,
      );
      const newTemplate = await prisma.$transaction(async (tx) => {
        // Deactivate others if setActive
        if (setActive) {
          debug(
            `Deactivating other templates for linked stream: ${streamId} before applying global template`,
          );
          await tx.linkedStreamTemplate.updateMany({
            where: { linkedStreamId: streamId, isActive: true },
            data: { isActive: false },
          });
        }

        return tx.linkedStreamTemplate.create({
          data: {
            name: globalTemplate.name,
            mklySource: globalTemplate.mklySource,
            linkedStreamId: streamId,
            isActive: setActive,
          },
        });
      });

      debug(
        `Global template applied to linked stream: newId=${newTemplate.id}, linkedStreamId=${streamId}, isActive=${setActive}`,
      );
      return c.json(
        {
          data: {
            id: newTemplate.id,
            name: newTemplate.name,
            isActive: newTemplate.isActive,
            mklySource: newTemplate.mklySource,
            createdAt: newTemplate.createdAt,
            updatedAt: newTemplate.updatedAt,
            streamType: "linkedStream" as const,
            streamId: linkedStream.id,
            streamName: linkedStream.name,
          },
        },
        201,
      );
    }
  },
);

// In-memory cache for template previews
interface CacheEntry {
  html: string;
  generatedAt: Date;
  timestamp: number;
}
const previewCache = new Map<string, CacheEntry>();
const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(mklySource: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(mklySource);
  return hash.digest("hex");
}

function cleanExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of previewCache.entries()) {
    if (now - entry.timestamp > PREVIEW_CACHE_TTL_MS) {
      previewCache.delete(key);
    }
  }
}

// POST /api/templates/preview - Compile mkly source and return HTML preview
templatesRouter.post(
  "/templates/preview",
  requireAuth,
  zValidator("json", TemplatePreviewSchema),
  async (c) => {
    const user = c.get("user")!;
    const { mklySource } = c.req.valid("json");

    debug(`[${user.id}] POST /templates/preview - compiling mkly source`);

    const cacheKey = getCacheKey(mklySource);
    const cachedEntry = previewCache.get(cacheKey);
    const now = Date.now();

    if (cachedEntry && now - cachedEntry.timestamp < PREVIEW_CACHE_TTL_MS) {
      debug(`[${user.id}] POST /templates/preview - cache hit`);
      return c.json({
        data: {
          html: cachedEntry.html,
          generatedAt: cachedEntry.generatedAt,
        },
      });
    }

    // Clean expired entries periodically
    cleanExpiredCache();

    try {
      // Import mkly compiler (runtime dynamic imports from monorepo sibling)
      // @ts-expect-error -- monorepo sibling import resolved by Bun at runtime
      const { mkly, CORE_KIT } = await import("../../milkly-mklyml/mkly/src/index");
      // @ts-expect-error -- monorepo sibling import resolved by Bun at runtime
      const { NEWSLETTER_KIT } = await import("../../milkly-mklyml/mkly-kits/newsletter/src/index");

      debug(`[${user.id}] POST /templates/preview - compiling with mkly`);

      // Compile mkly source to HTML
      const result = mkly(mklySource, {
        kits: { core: CORE_KIT, newsletter: NEWSLETTER_KIT },
      });

      const generatedAt = new Date();

      // Cache the result
      previewCache.set(cacheKey, {
        html: result.html,
        generatedAt,
        timestamp: now,
      });

      debug(`[${user.id}] POST /templates/preview - compilation successful`);

      return c.json({
        data: {
          html: result.html,
          generatedAt,
        },
      });
    } catch (error) {
      logError("Templates", "Error compiling template preview:", error);
      return c.json(
        {
          error: {
            message: "Failed to compile template preview",
            code: "PREVIEW_COMPILATION_FAILED",
          },
        },
        500,
      );
    }
  },
);

// PATCH /api/templates/:id/deactivate - Remove active status from template
templatesRouter.patch("/templates/:id/deactivate", requireAuth, async (c) => {
  const user = c.get("user")!;
  const templateId = c.req.param("id");

  debug(`[${user.id}] PATCH /templates/${templateId}/deactivate`);

  // Check template exists
  const template = await prisma.template.findFirst({
    where: { id: templateId },
    include: { stream: true },
  });

  if (!template) {
    debug(`[${user.id}] PATCH /templates/${templateId}/deactivate - not found`);
    return c.json(
      { error: { message: "Template not found", code: "NOT_FOUND" } },
      404,
    );
  }

  // Verify ownership: either direct userId for global templates, or via stream.userId for stream templates
  const isOwnedByUser = template.isGlobal
    ? template.userId === user.id
    : template.stream?.userId === user.id;

  if (!isOwnedByUser) {
    debug(
      `[${user.id}] PATCH /templates/${templateId}/deactivate - unauthorized`,
    );
    return c.json(
      { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
      403,
    );
  }

  debug(
    `[${user.id}] Deactivating template: id=${templateId}, wasActive=${template.isActive}`,
  );

  // Deactivate this template
  const updatedTemplate = await prisma.template.update({
    where: { id: templateId },
    data: { isActive: false },
  });

  debug(
    `[${user.id}] Template deactivated: id=${templateId}, isActive=${updatedTemplate.isActive}`,
  );
  return c.json({ data: transformTemplate(updatedTemplate) });
});

export { templatesRouter };
