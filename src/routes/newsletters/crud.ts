import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import {
  CreateNewsletterSchema,
  UpdateNewsletterSchema,
  calculatePagination,
} from "../../types";
import { requireAuth, type AuthVariables } from "../../middleware/auth";
import {
  transformNewsletter,
  transformNewsletterWithItems,
  NewslettersPaginationQuerySchema,
} from "./shared";

const crudRouter = new Hono<{ Variables: AuthVariables }>();

// GET /streams/:id/newsletters - list newsletters for a stream with pagination
crudRouter.get(
  "/streams/:id/newsletters",
  requireAuth,
  zValidator("query", NewslettersPaginationQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const { page, limit, status } = c.req.valid("query");

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

    // Build where clause with optional status filter
    const where: { streamId: string; userId: string; status?: string } = {
      streamId,
      userId: user.id,
    };

    if (status) {
      where.status = status;
    }

    // Get total count
    const total = await prisma.newsletter.count({ where });

    // Get paginated newsletters
    const newsletters = await prisma.newsletter.findMany({
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

    // Transform and include _count
    const result = newsletters.map((n) => ({
      ...transformNewsletter(n),
      _count: n._count,
    }));

    return c.json({
      data: result,
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// POST /streams/:id/newsletters - create newsletter with selected items
crudRouter.post(
  "/streams/:id/newsletters",
  requireAuth,
  zValidator("json", CreateNewsletterSchema),
  async (c) => {
    const user = c.get("user")!;
    const streamId = c.req.param("id");
    const input = c.req.valid("json");

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

    // Determine which template to use
    let templateId = input.templateId ?? null;

    // If no template specified, check for active template
    if (!templateId) {
      const activeTemplate = await prisma.template.findFirst({
        where: {
          streamId,
          isActive: true,
        },
      });
      if (activeTemplate) {
        templateId = activeTemplate.id;
      }
    } else {
      // Validate provided template exists
      const template = await prisma.template.findFirst({
        where: {
          id: templateId,
          streamId,
        },
      });

      if (!template) {
        return c.json(
          { error: { message: "Template not found", code: "NOT_FOUND" } },
          404,
        );
      }
    }

    // Use provided content - don't auto-generate (user should use preview endpoint for that)
    const content = input.content ?? "";

    // Create newsletter with items
    const newsletter = await prisma.newsletter.create({
      data: {
        title: input.title,
        content,
        userId: user.id,
        streamId,
        templateId,
        items: {
          create: input.items.map((item, index) => ({
            contentItemId: item.contentItemId,
            note: item.note ?? null,
            order: item.order ?? index,
          })),
        },
      },
      include: {
        items: {
          include: {
            contentItem: true,
          },
          orderBy: { order: "asc" },
        },
      },
    });

    return c.json({ data: transformNewsletterWithItems(newsletter) }, 201);
  },
);

// GET /newsletters/:id - get single newsletter with items
crudRouter.get("/newsletters/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const newsletterId = c.req.param("id");

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
    },
  });

  if (!newsletter) {
    return c.json(
      { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
      404,
    );
  }

  return c.json({ data: transformNewsletterWithItems(newsletter) });
});

// PUT /newsletters/:id - update newsletter
crudRouter.put(
  "/newsletters/:id",
  requireAuth,
  zValidator("json", UpdateNewsletterSchema),
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");
    const input = c.req.valid("json");

    // Check ownership
    const existing = await prisma.newsletter.findFirst({
      where: {
        id: newsletterId,
        userId: user.id,
      },
    });

    if (!existing) {
      return c.json(
        { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Validate template if being updated
    if (input.templateId && existing.streamId) {
      const template = await prisma.template.findFirst({
        where: {
          id: input.templateId,
          streamId: existing.streamId,
        },
      });

      if (!template) {
        return c.json(
          { error: { message: "Template not found", code: "NOT_FOUND" } },
          404,
        );
      }
    }

    // Build update data
    const updateData: {
      title?: string;
      content?: string;
      blocksJson?: unknown;
      templateId?: string | null;
    } = {};

    if (input.title !== undefined) updateData.title = input.title;
    if (input.content !== undefined) updateData.content = input.content;
    if (input.blocksJson !== undefined)
      updateData.blocksJson = input.blocksJson;
    if (input.templateId !== undefined)
      updateData.templateId = input.templateId;

    const MAX_VERSIONS = 10;

    // Wrap all operations in a single transaction
    const newsletter = await prisma.$transaction(async (tx) => {
      // Create version if content or blocksJson is being updated
      if (input.content !== undefined || input.blocksJson !== undefined) {
        await tx.newsletterVersion.create({
          data: {
            newsletterId,
            content: existing.content,
            blocksJson: existing.blocksJson ?? undefined,
          },
        });

        // Limit versions to MAX_VERSIONS (delete oldest if exceeding)
        const versionCount = await tx.newsletterVersion.count({
          where: { newsletterId },
        });

        if (versionCount > MAX_VERSIONS) {
          const oldestVersions = await tx.newsletterVersion.findMany({
            where: { newsletterId },
            orderBy: { createdAt: "asc" },
            take: versionCount - MAX_VERSIONS,
            select: { id: true },
          });

          await tx.newsletterVersion.deleteMany({
            where: {
              id: { in: oldestVersions.map((v) => v.id) },
            },
          });
        }
      }

      // If items are provided, replace all items
      if (input.items !== undefined) {
        await tx.newsletterItem.deleteMany({
          where: { newsletterId },
        });

        await tx.newsletterItem.createMany({
          data: input.items.map((item, index) => ({
            newsletterId,
            contentItemId: item.contentItemId,
            note: item.note ?? null,
            order: item.order ?? index,
          })),
        });
      }

      // Update newsletter
      return tx.newsletter.update({
        where: { id: newsletterId },
        data: {
          title: updateData.title,
          content: updateData.content,
          blocksJson: updateData.blocksJson as
            | Prisma.InputJsonValue
            | undefined,
          templateId: updateData.templateId,
        },
        include: {
          items: {
            include: {
              contentItem: true,
            },
            orderBy: { order: "asc" },
          },
        },
      });
    });

    return c.json({ data: transformNewsletterWithItems(newsletter) });
  },
);

// DELETE /newsletters/:id - delete newsletter
crudRouter.delete("/newsletters/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const newsletterId = c.req.param("id");

  // Check ownership
  const existing = await prisma.newsletter.findFirst({
    where: {
      id: newsletterId,
      userId: user.id,
    },
  });

  if (!existing) {
    return c.json(
      { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
      404,
    );
  }

  await prisma.newsletter.delete({
    where: { id: newsletterId },
  });

  return c.body(null, 204);
});

export { crudRouter };
