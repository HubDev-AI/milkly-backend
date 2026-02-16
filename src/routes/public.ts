import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import { calculatePagination } from "../types";
import { publicRateLimit } from "../middleware/rate-limit";
import { TIER_FEATURES } from "../config/tiers";

export const publicRouter = new Hono();

// ============ Tier Config Endpoint ============

// GET /api/public/tier-config - public endpoint for tier features (pricing page)
publicRouter.get("/tier-config", async (c) => {
  const configs = await prisma.tierConfig.findMany({
    orderBy: { tier: "asc" },
  });

  if (configs.length > 0) {
    const tierFeatures: Record<string, string[]> = {};
    for (const config of configs) {
      tierFeatures[config.tier] = config.features as string[];
    }
    return c.json({ data: tierFeatures });
  }

  return c.json({ data: TIER_FEATURES });
});

// ============ Newsletter Subscription Endpoints ============

const SubscribeSchema = z.object({
  email: z.string().email("Invalid email address"),
});

// POST /api/public/newsletters/:id/subscribe - subscribe to a newsletter
publicRouter.post(
  "/newsletters/:id/subscribe",
  publicRateLimit,
  zValidator("json", SubscribeSchema),
  async (c) => {
    const newsletterId = c.req.param("id");
    const { email } = c.req.valid("json");

    // Check if newsletter exists and is published
    const newsletter = await prisma.newsletter.findFirst({
      where: { id: newsletterId, status: "published" },
      select: { id: true, title: true },
    });

    if (!newsletter) {
      return c.json(
        { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Check if already subscribed
    const existing = await prisma.newsletterSubscriber.findUnique({
      where: {
        email_newsletterId: { email, newsletterId },
      },
    });

    if (existing) {
      return c.json({
        data: { message: "Already subscribed", subscribed: true },
      });
    }

    // Create subscription
    await prisma.newsletterSubscriber.create({
      data: { email, newsletterId },
    });

    return c.json({
      data: { message: "Successfully subscribed", subscribed: true },
    });
  },
);

// POST /api/public/newsletters/:id/unsubscribe - unsubscribe from a newsletter
publicRouter.post(
  "/newsletters/:id/unsubscribe",
  publicRateLimit,
  zValidator("json", SubscribeSchema),
  async (c) => {
    const newsletterId = c.req.param("id");
    const { email } = c.req.valid("json");

    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: {
        email_newsletterId: { email, newsletterId },
      },
    });

    if (!subscriber) {
      return c.json({
        data: { message: "Not subscribed", subscribed: false },
      });
    }

    await prisma.newsletterSubscriber.delete({
      where: { id: subscriber.id },
    });

    return c.json({
      data: { message: "Successfully unsubscribed", subscribed: false },
    });
  },
);

// GET /api/public/unsubscribe/:token - unsubscribe via token link
publicRouter.get("/unsubscribe/:token", publicRateLimit, async (c) => {
  const token = c.req.param("token");

  const subscriber = await prisma.newsletterSubscriber.findUnique({
    where: { unsubscribeToken: token },
    include: {
      newsletter: { select: { title: true } },
    },
  });

  if (!subscriber) {
    return c.json(
      {
        error: {
          message: "Invalid or expired unsubscribe link",
          code: "INVALID_TOKEN",
        },
      },
      404,
    );
  }

  await prisma.newsletterSubscriber.delete({
    where: { id: subscriber.id },
  });

  return c.json({
    data: {
      message: `Successfully unsubscribed from "${subscriber.newsletter.title}"`,
      newsletterTitle: subscriber.newsletter.title,
    },
  });
});

// GET /api/public/newsletters/:id/subscription-status - check if email is subscribed
publicRouter.get(
  "/newsletters/:id/subscription-status",
  zValidator("query", z.object({ email: z.string().email() })),
  async (c) => {
    const newsletterId = c.req.param("id");
    const { email } = c.req.valid("query");

    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: {
        email_newsletterId: { email, newsletterId },
      },
    });

    return c.json({
      data: { subscribed: !!subscriber },
    });
  },
);

// ============ Stream Subscription Endpoints ============

// POST /api/public/streams/:id/subscribe - subscribe to all newsletters in a stream
publicRouter.post(
  "/streams/:id/subscribe",
  publicRateLimit,
  zValidator("json", SubscribeSchema),
  async (c) => {
    const streamId = c.req.param("id");
    const { email } = c.req.valid("json");

    // Check if stream exists
    const stream = await prisma.stream.findUnique({
      where: { id: streamId },
      select: { id: true, name: true },
    });

    if (!stream) {
      return c.json(
        { error: { message: "Stream not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // Check if already subscribed
    const existing = await prisma.streamSubscriber.findUnique({
      where: {
        email_streamId: { email, streamId },
      },
    });

    if (existing) {
      return c.json({
        data: {
          message: "Already subscribed to this stream",
          subscribed: true,
        },
      });
    }

    await prisma.streamSubscriber.create({
      data: { email, streamId },
    });

    return c.json({
      data: {
        message: `Successfully subscribed to ${stream.name}`,
        subscribed: true,
      },
    });
  },
);

// ============ Existing Newsletter Listing Endpoints ============

// GET /api/public/newsletters - list all published newsletters
const PublicNewslettersQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(50).optional().default(20),
});

publicRouter.get(
  "/newsletters",
  zValidator("query", PublicNewslettersQuerySchema),
  async (c) => {
    const { page, limit } = c.req.valid("query");

    const total = await prisma.newsletter.count({
      where: { status: "published" },
    });

    const newsletters = await prisma.newsletter.findMany({
      where: { status: "published" },
      orderBy: { publishedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        publishedAt: true,
        streamId: true,
        streamName: true,
        stream: {
          select: {
            id: true,
            name: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const result = newsletters.map((n) => ({
      id: n.id,
      title: n.title,
      publishedAt: n.publishedAt,
      streamName: n.streamName || n.stream?.name || "Unknown",
      author: n.user?.name || "Anonymous",
      userId: n.user?.id ?? null,
      type: "newsletter" as const,
    }));

    const linkedTotal = await prisma.linkedNewsletter.count({
      where: { status: "published" },
    });

    const linkedNewsletters = await prisma.linkedNewsletter.findMany({
      where: { status: "published" },
      orderBy: { publishedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        publishedAt: true,
        linkedStreamName: true,
        linkedStream: {
          select: {
            id: true,
            name: true,
            userId: true,
          },
        },
      },
    });

    const linkedResult = linkedNewsletters.map((n) => ({
      id: n.id,
      title: n.title,
      publishedAt: n.publishedAt,
      streamName: n.linkedStreamName || n.linkedStream?.name || "Unknown",
      author: "Anonymous",
      userId: n.linkedStream?.userId ?? null,
      type: "linked" as const,
    }));

    const combined = [...result, ...linkedResult].sort((a, b) => {
      const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return dateB - dateA;
    });

    return c.json({
      data: combined,
      pagination: calculatePagination(page, limit, total + linkedTotal),
    });
  },
);

// GET /api/public/newsletters/:id - get single published newsletter
publicRouter.get("/newsletters/:id", async (c) => {
  const newsletterId = c.req.param("id");

  const newsletter = await prisma.newsletter.findFirst({
    where: {
      id: newsletterId,
      status: "published",
    },
    select: {
      id: true,
      title: true,
      content: true,
      publishedAt: true,
      streamId: true,
      streamName: true,
      stream: {
        select: {
          id: true,
          name: true,
        },
      },
      user: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (newsletter) {
    return c.json({
      data: {
        id: newsletter.id,
        title: newsletter.title,
        content: newsletter.content,
        publishedAt: newsletter.publishedAt,
        streamName:
          newsletter.streamName || newsletter.stream?.name || "Unknown",
        author: newsletter.user?.name || "Anonymous",
        userId: newsletter.user?.id ?? null,
        type: "newsletter" as const,
      },
    });
  }

  const linkedNewsletter = await prisma.linkedNewsletter.findFirst({
    where: {
      id: newsletterId,
      status: "published",
    },
    select: {
      id: true,
      title: true,
      content: true,
      publishedAt: true,
      linkedStreamName: true,
      linkedStream: {
        select: {
          id: true,
          name: true,
          userId: true,
        },
      },
    },
  });

  if (linkedNewsletter) {
    return c.json({
      data: {
        id: linkedNewsletter.id,
        title: linkedNewsletter.title,
        content: linkedNewsletter.content,
        publishedAt: linkedNewsletter.publishedAt,
        streamName:
          linkedNewsletter.linkedStreamName ||
          linkedNewsletter.linkedStream?.name ||
          "Unknown",
        author: "Anonymous",
        userId: linkedNewsletter.linkedStream?.userId ?? null,
        type: "linked" as const,
      },
    });
  }

  return c.json(
    { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
    404,
  );
});

// Pagination schema for public streams
const PublicStreamsQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(50).optional().default(20),
});

// GET /api/public/streams - list streams that have published newsletters
publicRouter.get(
  "/streams",
  zValidator("query", PublicStreamsQuerySchema),
  async (c) => {
    const { page, limit } = c.req.valid("query");

    // Get unique streams that have at least one published newsletter
    // First get all unique streams with published newsletters
    const streamsWithNewsletters = await prisma.newsletter.findMany({
      where: {
        status: "published",
        streamId: { not: null },
      },
      select: {
        streamId: true,
        streamName: true,
        stream: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      distinct: ["streamId"],
    });

    const streams = streamsWithNewsletters
      .filter((s) => s.streamId || s.streamName)
      .map((s) => ({
        id: s.streamId || "unknown",
        name: s.streamName || s.stream?.name || "Unknown",
      }));

    // Remove duplicates by name
    const uniqueStreams = Array.from(
      new Map(streams.map((s) => [s.name, s])).values(),
    );

    // Apply pagination to the unique streams
    const total = uniqueStreams.length;
    const paginatedStreams = uniqueStreams.slice(
      (page - 1) * limit,
      page * limit,
    );

    return c.json({
      data: paginatedStreams,
      pagination: calculatePagination(page, limit, total),
    });
  },
);

// GET /api/public/streams/:id/newsletters - list newsletters for a stream
publicRouter.get(
  "/streams/:id/newsletters",
  zValidator("query", PublicNewslettersQuerySchema),
  async (c) => {
    const streamId = c.req.param("id");
    const { page, limit } = c.req.valid("query");

    const total = await prisma.newsletter.count({
      where: {
        status: "published",
        streamId,
      },
    });

    const newsletters = await prisma.newsletter.findMany({
      where: {
        status: "published",
        streamId,
      },
      orderBy: { publishedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        publishedAt: true,
        streamName: true,
        stream: {
          select: {
            name: true,
          },
        },
        user: {
          select: {
            name: true,
          },
        },
      },
    });

    const result = newsletters.map((n) => ({
      id: n.id,
      title: n.title,
      publishedAt: n.publishedAt,
      streamName: n.streamName || n.stream?.name || "Unknown",
      author: n.user?.name || "Anonymous",
    }));

    return c.json({
      data: result,
      pagination: calculatePagination(page, limit, total),
    });
  },
);
