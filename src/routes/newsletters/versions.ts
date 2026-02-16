import { Hono } from "hono";
import { prisma } from "../../prisma";
import { requireAuth, type AuthVariables } from "../../middleware/auth";
import { transformNewsletterWithItems } from "./shared";

const versionsRouter = new Hono<{ Variables: AuthVariables }>();

// GET /newsletters/:id/versions - List versions (limit 10, newest first)
versionsRouter.get("/newsletters/:id/versions", requireAuth, async (c) => {
  const user = c.get("user")!;
  const newsletterId = c.req.param("id");

  // Check newsletter ownership
  const newsletter = await prisma.newsletter.findFirst({
    where: {
      id: newsletterId,
      userId: user.id,
    },
    select: { id: true },
  });

  if (!newsletter) {
    return c.json(
      { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
      404,
    );
  }

  // Get versions (limit 10, newest first, only metadata)
  const versions = await prisma.newsletterVersion.findMany({
    where: { newsletterId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      createdAt: true,
    },
  });

  return c.json({
    data: versions.map((v) => ({
      id: v.id,
      createdAt: v.createdAt.toISOString(),
    })),
  });
});

// GET /newsletters/:id/versions/:versionId - Get specific version
versionsRouter.get(
  "/newsletters/:id/versions/:versionId",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");
    const versionId = c.req.param("versionId");

    // Check newsletter ownership
    const newsletter = await prisma.newsletter.findFirst({
      where: {
        id: newsletterId,
        userId: user.id,
      },
      select: { id: true },
    });

    if (!newsletter) {
      return c.json(
        { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Get the specific version
    const version = await prisma.newsletterVersion.findFirst({
      where: {
        id: versionId,
        newsletterId,
      },
    });

    if (!version) {
      return c.json(
        { error: { message: "Version not found", code: "NOT_FOUND" } },
        404,
      );
    }

    return c.json({
      data: {
        id: version.id,
        content: version.content,
        blocksJson: version.blocksJson,
        createdAt: version.createdAt.toISOString(),
      },
    });
  },
);

// POST /newsletters/:id/restore/:versionId - Restore a version
versionsRouter.post(
  "/newsletters/:id/restore/:versionId",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");
    const versionId = c.req.param("versionId");

    // Check newsletter ownership
    const newsletter = await prisma.newsletter.findFirst({
      where: {
        id: newsletterId,
        userId: user.id,
      },
    });

    if (!newsletter) {
      return c.json(
        { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Get the specific version
    const version = await prisma.newsletterVersion.findFirst({
      where: {
        id: versionId,
        newsletterId,
      },
    });

    if (!version) {
      return c.json(
        { error: { message: "Version not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Create a new version with current content before restoring
    await prisma.newsletterVersion.create({
      data: {
        newsletterId,
        content: newsletter.content,
        blocksJson: newsletter.blocksJson ?? undefined,
      },
    });

    // Limit versions to 10 (delete oldest if exceeding)
    const versionCount = await prisma.newsletterVersion.count({
      where: { newsletterId },
    });

    if (versionCount > 10) {
      const oldestVersions = await prisma.newsletterVersion.findMany({
        where: { newsletterId },
        orderBy: { createdAt: "asc" },
        take: versionCount - 10,
        select: { id: true },
      });

      await prisma.newsletterVersion.deleteMany({
        where: {
          id: { in: oldestVersions.map((v) => v.id) },
        },
      });
    }

    // Update newsletter with version content
    const updatedNewsletter = await prisma.newsletter.update({
      where: { id: newsletterId },
      data: {
        content: version.content ?? "",
        blocksJson: version.blocksJson ?? undefined,
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

    return c.json({ data: transformNewsletterWithItems(updatedNewsletter) });
  },
);

export { versionsRouter };
