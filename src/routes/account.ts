import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import {
  getUserTier,
  getUserUsage,
  getLimitsForUser,
} from "../middleware/tier-limits";
import { getTierLimits } from "../config/tiers";
import { getSystemSetting, SYSTEM_SETTINGS } from "../services/settings";

export const accountRouter = new Hono<{ Variables: AuthVariables }>();

// GET /api/account/usage - get current user's usage and limits
accountRouter.get("/usage", requireAuth, async (c) => {
  const user = c.get("user")!;

  const tier = await getUserTier(user.id);
  const usage = await getUserUsage(user.id);

  // Use snapshot-based limits if available, otherwise fall back to tier config
  const userLimits = await getLimitsForUser(user.id);
  const limits = userLimits || getTierLimits(tier);

  // Get free tier renewal setting
  const freeTierRenewalSetting = await getSystemSetting(
    SYSTEM_SETTINGS.FREE_TIER_RENEWAL_ENABLED,
  );
  const freeTierRenewalEnabled = freeTierRenewalSetting !== "false";

  return c.json({
    data: {
      tier,
      freeTierRenewalEnabled,
      aiCredits: {
        used: usage.aiCreditsUsed,
        limit: limits.aiCredits,
        periodStart: usage.periodStart.toISOString(),
        periodEnd: usage.periodEnd.toISOString(),
      },
      refreshes: {
        used: usage.refreshesUsed,
        limit: limits.refreshes,
        periodStart: usage.periodStart.toISOString(),
        periodEnd: usage.periodEnd.toISOString(),
      },
    },
  });
});

// DELETE /api/account - delete user account
const DeleteAccountSchema = z.object({
  confirmation: z.literal("DELETE MY ACCOUNT"),
});

accountRouter.delete(
  "/",
  requireAuth,
  zValidator("json", DeleteAccountSchema),
  async (c) => {
    const user = c.get("user")!;

    // Verify confirmation text
    const { confirmation } = c.req.valid("json");
    if (confirmation !== "DELETE MY ACCOUNT") {
      return c.json(
        {
          error: {
            message: "Invalid confirmation text",
            code: "INVALID_CONFIRMATION",
          },
        },
        400,
      );
    }

    // All deletion operations wrapped in a transaction
    await prisma.$transaction(async (tx) => {
      // For all streams with published newsletters, preserve the stream name
      const streamsWithPublished = await tx.stream.findMany({
        where: { userId: user.id },
        include: {
          newsletters: {
            where: { status: "published" },
            select: { id: true },
          },
        },
      });

      for (const stream of streamsWithPublished) {
        if (stream.newsletters.length > 0) {
          await tx.newsletter.updateMany({
            where: {
              streamId: stream.id,
              status: "published",
            },
            data: {
              streamName: stream.name,
            },
          });
        }
      }

      // Delete linked streams first (not cascaded from User)
      await tx.linkedNewsletterItem.deleteMany({
        where: {
          linkedNewsletter: {
            linkedStream: {
              userId: user.id,
            },
          },
        },
      });

      await tx.linkedNewsletter.deleteMany({
        where: {
          linkedStream: {
            userId: user.id,
          },
        },
      });

      await tx.linkedStreamMember.deleteMany({
        where: {
          linkedStream: {
            userId: user.id,
          },
        },
      });

      await tx.linkedStream.deleteMany({
        where: { userId: user.id },
      });

      // Delete the user - this cascades to sessions, accounts, streams, newsletters, subscriptions, usage records
      await tx.user.delete({
        where: { id: user.id },
      });
    });

    return c.json({ data: { message: "Account deleted successfully" } });
  },
);

// GET /api/account/data - export user data (for GDPR compliance)
accountRouter.get("/data", requireAuth, async (c) => {
  const user = c.get("user")!;

  // Get all user data
  const userData = await prisma.user.findUnique({
    where: { id: user.id },
    include: {
      streams: {
        include: {
          contentItems: true,
          templates: true,
          newsletters: {
            include: {
              items: true,
            },
          },
        },
      },
      subscription: true,
      usageRecords: true,
    },
  });

  // Get linked streams
  const linkedStreams = await prisma.linkedStream.findMany({
    where: { userId: user.id },
    include: {
      members: true,
      newsletters: {
        include: {
          items: true,
        },
      },
    },
  });

  return c.json({
    data: {
      user: {
        id: userData?.id,
        name: userData?.name,
        email: userData?.email,
        createdAt: userData?.createdAt,
      },
      streams: userData?.streams,
      linkedStreams,
      subscription: userData?.subscription,
      usageRecords: userData?.usageRecords,
    },
  });
});
