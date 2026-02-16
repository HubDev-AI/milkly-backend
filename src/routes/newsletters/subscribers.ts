import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../../prisma";
import { calculatePagination } from "../../types";
import { requireAuth, type AuthVariables } from "../../middleware/auth";

const subscribersRouter = new Hono<{ Variables: AuthVariables }>();

// Pagination schema for subscribers
const SubscribersPaginationQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

// GET /newsletters/:id/subscribers - get subscribers for a newsletter (creator only)
subscribersRouter.get(
  "/newsletters/:id/subscribers",
  requireAuth,
  zValidator("query", SubscribersPaginationQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");
    const { page, limit } = c.req.valid("query");

    // Check ownership
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

    const total = await prisma.newsletterSubscriber.count({
      where: { newsletterId },
    });

    const subscribers = await prisma.newsletterSubscriber.findMany({
      where: { newsletterId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        email: true,
        confirmed: true,
        createdAt: true,
      },
    });

    return c.json({
      data: subscribers,
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// DELETE /newsletters/:id/subscribers/:subscriberId - remove a subscriber (creator only)
subscribersRouter.delete(
  "/newsletters/:id/subscribers/:subscriberId",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");
    const subscriberId = c.req.param("subscriberId");

    // Check ownership
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

    const subscriber = await prisma.newsletterSubscriber.findFirst({
      where: {
        id: subscriberId,
        newsletterId,
      },
    });

    if (!subscriber) {
      return c.json(
        { error: { message: "Subscriber not found", code: "NOT_FOUND" } },
        404,
      );
    }

    await prisma.newsletterSubscriber.delete({
      where: { id: subscriberId },
    });

    return c.body(null, 204);
  },
);

export { subscribersRouter };
