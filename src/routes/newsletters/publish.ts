import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../../prisma";
import { env } from "../../env";
import {
  checkSubscriberLimit,
  getUserTier,
} from "../../middleware/tier-limits";
import { isStyleFeatureEnabled } from "../../config/tiers";
import { STYLE_LEARNING } from "../../config";
import { requireAuth, type AuthVariables } from "../../middleware/auth";
import { transformNewsletterWithItems } from "./shared";
import { logError } from "../../lib/debug";

const publishRouter = new Hono<{ Variables: AuthVariables }>();

// POST /newsletters/:id/publish - publish newsletter
publishRouter.post("/newsletters/:id/publish", requireAuth, async (c) => {
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

  if (existing.status === "published") {
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

  // Replace signed S3 URLs with permanent public URLs before publishing
  const { publishNewsletterContent } =
    await import("../../services/newsletter-publish");
  const publicContent = existing.content
    ? await publishNewsletterContent(
        existing.content,
        newsletterId,
        existing.templateId,
      )
    : undefined;

  const newsletter = await prisma.newsletter.update({
    where: { id: newsletterId },
    data: {
      status: "published",
      publishedAt: new Date(),
      ...(publicContent !== undefined && { content: publicContent }),
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

  // Fire-and-forget: style learning analysis
  if (STYLE_LEARNING.ENABLED && existing.templateId) {
    (async () => {
      try {
        const tier = await getUserTier(user.id);
        const styleLearning = await import("../../services/style-learning");
        const content = publicContent || existing.content;

        // Phase 2: Style profile analysis
        if (isStyleFeatureEnabled("styleProfile", tier) && content) {
          styleLearning
            .analyzeAndUpdateStyleProfile(
              content,
              existing.templateId!,
              "stream",
              user.id,
            )
            .catch((err: unknown) =>
              logError("STYLE-LEARNING", "Profile analysis failed:", err),
            );
        }

        // Phase 3: Edit-diff tracking
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
              "stream",
            )
            .catch((err: unknown) =>
              logError("STYLE-LEARNING", "Edit diff analysis failed:", err),
            );
        }

        // Phase 4: Writing baseline
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
  return c.json({
    data: { ...transformNewsletterWithItems(newsletter), publicUrl },
  });
});

// POST /newsletters/:id/send-email - send newsletter to all subscribers (creator only)
const SendEmailSchema = z.object({
  subject: z.string().min(1).optional(),
});

publishRouter.post(
  "/newsletters/:id/send-email",
  requireAuth,
  zValidator("json", SendEmailSchema.optional()),
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");
    const input = c.req.valid("json") || {};

    // Import email service and tier limits
    const {
      isEmailConfigured,
      sendNewsletterToSubscribers,
      wrapNewsletterContent,
    } = await import("../../services/email");

    // Check ownership
    const newsletter = await prisma.newsletter.findFirst({
      where: {
        id: newsletterId,
        userId: user.id,
        status: "published",
      },
      include: {
        subscribers: {
          where: { confirmed: true },
          select: {
            id: true,
            email: true,
            unsubscribeToken: true,
          },
        },
      },
    });

    if (!newsletter) {
      return c.json(
        {
          error: {
            message: "Published newsletter not found",
            code: "NOT_FOUND",
          },
        },
        404,
      );
    }

    if (newsletter.subscribers.length === 0) {
      return c.json(
        {
          error: {
            message: "No subscribers to send to",
            code: "NO_SUBSCRIBERS",
          },
        },
        400,
      );
    }

    // Check subscriber count limit
    const subscriberCheck = await checkSubscriberLimit(
      user.id,
      newsletter.subscribers.length,
    );
    if (!subscriberCheck.allowed && subscriberCheck.error) {
      return c.json({ error: subscriberCheck.error }, 403);
    }

    const emailSubject = input.subject || newsletter.title;

    // Check if email service is configured
    if (!isEmailConfigured()) {
      return c.json(
        {
          error: {
            message:
              "Email service not configured. Set RESEND_API_KEY in your environment variables.",
            code: "EMAIL_NOT_CONFIGURED",
          },
        },
        503,
      );
    }

    // Get base URL for unsubscribe links
    const baseUrl = env.MILKLY_NEWS_URL;

    // Send emails
    const result = await sendNewsletterToSubscribers(
      {
        title: newsletter.title,
        content: wrapNewsletterContent(newsletter.content, newsletter.title),
      },
      newsletter.subscribers,
      {
        subject: emailSubject,
        baseUrl,
      },
    );

    if (result.failed > 0 && result.successful === 0) {
      return c.json(
        {
          error: {
            message: `Failed to send emails: ${result.errors.slice(0, 3).join(", ")}`,
            code: "EMAIL_SEND_FAILED",
          },
        },
        500,
      );
    }

    return c.json({
      data: {
        message:
          result.failed > 0
            ? `Sent to ${result.successful} subscribers, ${result.failed} failed`
            : `Successfully sent to ${result.successful} subscribers`,
        subject: emailSubject,
        subscriberCount: newsletter.subscribers.length,
        successful: result.successful,
        failed: result.failed,
      },
    });
  },
);

export { publishRouter };
