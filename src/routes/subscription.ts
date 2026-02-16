import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import {
  TIER_LIMITS,
  TIER_FEATURES,
  TIER_NAMES,
  type TierName,
} from "../config/tiers";
import { isDevMode } from "../config";
import {
  getPaymentProvider,
  getDefaultProviderName,
  isPaymentConfigured,
  getConfiguredProviders,
  type PaymentProviderName,
} from "../services/payment";
import { validate } from "../middleware/validation";
import { rateLimit } from "../middleware/rate-limit";
import { getRedis } from "../lib/redis";
import { logError, logInfo, logWarn } from "../lib/debug";
import {
  getUserUsage,
  getLimitsForUser,
  checkFreeTierStatus,
  renewUserPeriod,
  createEntitlementSnapshot,
} from "../middleware/tier-limits";
import {
  getSystemSetting,
  setSystemSetting,
  SYSTEM_SETTINGS,
  clearSettingsCache,
} from "../services/settings";

export const subscriptionRouter = new Hono<{ Variables: AuthVariables }>();

const paymentRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyPrefix: "payment",
});

// GET /api/subscription - Get current user's subscription and usage
subscriptionRouter.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;

  // Get or create subscription
  let subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
  });

  if (!subscription) {
    subscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        tier: "essential",
        status: "active",
      },
    });
  }

  // Get usage for current billing period
  const usage = await getUserUsage(user.id);

  // Get counts for limits
  const streamCount = await prisma.stream.count({
    where: { userId: user.id },
  });

  const tier = subscription.tier as TierName;
  const features = TIER_FEATURES[tier];

  // Get limits from snapshot or fall back to tier defaults
  const userLimits = await getLimitsForUser(user.id);
  const limits = userLimits || {
    ...TIER_LIMITS["essential"],
    fromSnapshot: false,
  };

  // Check free tier status and renewal setting
  const freeTierStatus = await checkFreeTierStatus(user.id);
  const freeTierRenewalSetting = await getSystemSetting(
    SYSTEM_SETTINGS.FREE_TIER_RENEWAL_ENABLED,
  );
  const freeTierRenewalEnabled = freeTierRenewalSetting !== "false";

  return c.json({
    data: {
      subscription: {
        id: subscription.id,
        tier: subscription.tier,
        status: subscription.status,
        provider: subscription.provider,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      },
      usage: {
        refreshesUsed: usage.refreshesUsed,
        aiCreditsUsed: usage.aiCreditsUsed,
        streamCount,
        periodStart: usage.periodStart,
        periodEnd: usage.periodEnd,
      },
      limits,
      features,
      snapshotedAt: userLimits?.snapshotedAt || null,
      fromSnapshot: userLimits?.fromSnapshot || false,
      freeTierStatus: {
        periodExpired: freeTierStatus.periodExpired,
        canRenew: freeTierStatus.canRenew,
        active: freeTierStatus.active,
        message: freeTierStatus.message || null,
      },
      freeTierRenewalEnabled,
    },
  });
});

// GET /api/subscription/plans - List available plans
subscriptionRouter.get("/plans", async (c) => {
  const provider = getPaymentProvider();

  let stripePrices: Array<{
    tier: string;
    interval: "monthly" | "yearly";
    amount: number;
  }> = [];
  if (provider.getPrices) {
    stripePrices = await provider.getPrices();
  }

  const getPricing = (tier: string) => {
    const monthly = stripePrices.find(
      (p) => p.tier === tier && p.interval === "monthly",
    );
    const yearly = stripePrices.find(
      (p) => p.tier === tier && p.interval === "yearly",
    );
    return {
      monthly: monthly?.amount ?? 0,
      yearly: yearly?.amount ?? 0,
    };
  };

  const plans = [
    {
      tier: "essential",
      name: TIER_NAMES.essential,
      description: "Get started with the basics",
      pricing: { monthly: 0, yearly: 0 },
      limits: TIER_LIMITS.essential,
      features: TIER_FEATURES.essential,
    },
    {
      tier: "professional",
      name: TIER_NAMES.professional,
      description: "For serious content creators",
      pricing: getPricing("professional"),
      limits: TIER_LIMITS.professional,
      features: TIER_FEATURES.professional,
    },
    {
      tier: "mastery",
      name: TIER_NAMES.mastery,
      description: "For teams and power users",
      pricing: getPricing("mastery"),
      limits: TIER_LIMITS.mastery,
      features: TIER_FEATURES.mastery,
    },
  ];

  return c.json({ data: plans });
});

// POST /api/subscription/checkout - Create checkout session
const CheckoutSchema = z.object({
  tier: z.enum(["professional", "mastery"]),
  interval: z.enum(["monthly", "yearly"]),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

subscriptionRouter.post(
  "/checkout",
  requireAuth,
  paymentRateLimit,
  zValidator("json", CheckoutSchema),
  async (c) => {
    const provider = getPaymentProvider();

    if (!provider.isConfigured()) {
      return c.json(
        {
          error: {
            message: `Payment provider (${provider.name}) is not configured.`,
            code: "PAYMENT_NOT_CONFIGURED",
          },
        },
        503,
      );
    }

    const user = c.get("user")!;
    const { tier, interval, successUrl, cancelUrl } = c.req.valid("json");

    // Get existing customer ID if any
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
    });

    const result = await provider.createCheckout({
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      tier,
      interval,
      successUrl,
      cancelUrl,
      existingCustomerId: dbUser?.paymentCustomerId || undefined,
    });

    if (!result.success) {
      return c.json(
        {
          error: {
            message: result.error || "Failed to create checkout",
            code: "CHECKOUT_FAILED",
          },
        },
        400,
      );
    }

    // Save customer ID if newly created
    if (result.customerId && !dbUser?.paymentCustomerId) {
      await prisma.user.update({
        where: { id: user.id },
        data: { paymentCustomerId: result.customerId },
      });
    }

    return c.json({ data: { url: result.url } });
  },
);

// POST /api/subscription/portal - Create billing portal session
const PortalSchema = z.object({
  returnUrl: z.string().url(),
});

subscriptionRouter.post(
  "/portal",
  requireAuth,
  paymentRateLimit,
  zValidator("json", PortalSchema),
  async (c) => {
    const provider = getPaymentProvider();

    if (!provider.isConfigured()) {
      return c.json(
        {
          error: {
            message: "Payment provider is not configured",
            code: "PAYMENT_NOT_CONFIGURED",
          },
        },
        503,
      );
    }

    const user = c.get("user")!;
    const { returnUrl } = c.req.valid("json");

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
    });

    if (!dbUser?.paymentCustomerId) {
      return c.json(
        { error: { message: "No billing account found", code: "NO_BILLING" } },
        400,
      );
    }

    const result = await provider.createPortal({
      customerId: dbUser.paymentCustomerId,
      returnUrl,
    });

    if (!result.success) {
      return c.json(
        {
          error: {
            message: result.error || "Failed to create portal",
            code: "PORTAL_FAILED",
          },
        },
        400,
      );
    }

    return c.json({ data: { url: result.url } });
  },
);

// POST /api/subscription/webhooks/:provider - Handle payment provider webhooks
const WebhookProviderParamSchema = z.object({
  provider: z.enum(["stripe"]),
});

subscriptionRouter.post(
  "/webhooks/:provider",
  validate("param", WebhookProviderParamSchema),
  async (c) => {
    const providerName = c.req.valid("param").provider as PaymentProviderName;
    const provider = getPaymentProvider(providerName);

    if (!provider.isConfigured()) {
      return c.json({ error: { message: "Provider not configured" } }, 503);
    }

    const body = await c.req.text();

    // Get signature from appropriate header based on provider
    const signature = c.req.header("stripe-signature");

    const result = await provider.parseWebhook(body, signature);

    if (!result.success) {
      logError("Subscription", "Webhook error:", result.error);
      return c.json({ error: { message: result.error } }, 400);
    }

    // Deduplicate webhook events via Redis (24h TTL)
    if (
      result.success &&
      result.action &&
      result.action !== "none" &&
      result.eventId
    ) {
      const redis = getRedis();
      if (redis) {
        try {
          const dedupKey = `webhook:evt:${result.eventId}`;
          const isNew = await redis.set(dedupKey, "1", "EX", 86400, "NX");
          if (!isNew) {
            logInfo("Subscription", "Duplicate webhook event skipped", {
              eventId: result.eventId,
            });
            return c.json({ received: true });
          }
        } catch {
          logWarn(
            "Subscription",
            "Redis dedup check failed, processing anyway",
          );
        }
      }
    }

    // Handle subscription updates
    if (result.subscriptionUpdate) {
      const update = result.subscriptionUpdate;

      switch (result.action) {
        case "subscription_created": {
          if (update.userId && update.tier) {
            await prisma.$transaction(async (tx) => {
              const subscription = await tx.subscription.upsert({
                where: { userId: update.userId! },
                update: {
                  tier: update.tier,
                  status: update.status || "active",
                  provider: providerName,
                  providerSubscriptionId: update.providerSubscriptionId,
                  providerPriceId: update.providerPriceId,
                  currentPeriodStart: update.currentPeriodStart,
                  currentPeriodEnd: update.currentPeriodEnd,
                },
                create: {
                  userId: update.userId!,
                  tier: update.tier!,
                  status: update.status || "active",
                  provider: providerName,
                  providerSubscriptionId: update.providerSubscriptionId,
                  providerPriceId: update.providerPriceId,
                  currentPeriodStart: update.currentPeriodStart,
                  currentPeriodEnd: update.currentPeriodEnd,
                },
              });

              if (update.currentPeriodStart && update.currentPeriodEnd) {
                await createEntitlementSnapshot(
                  subscription.id,
                  update.tier!,
                  update.currentPeriodStart,
                  update.currentPeriodEnd,
                  tx,
                );
                logInfo(
                  "Subscription",
                  "Created initial snapshot for new subscription",
                  {
                    subscriptionId: subscription.id.slice(0, 8),
                    userId: update.userId!.slice(0, 8),
                    tier: update.tier,
                  },
                );
              }
            });
          }
          break;
        }

        case "subscription_paused":
        case "subscription_resumed":
        case "subscription_updated": {
          // Find by provider subscription ID or user ID
          const whereClause = update.providerSubscriptionId
            ? { providerSubscriptionId: update.providerSubscriptionId }
            : update.userId
              ? { userId: update.userId }
              : null;

          if (whereClause) {
            const existing = await prisma.subscription.findFirst({
              where: whereClause,
            });
            if (existing) {
              const periodChanged =
                update.currentPeriodStart &&
                existing.currentPeriodStart &&
                update.currentPeriodStart.getTime() !==
                  existing.currentPeriodStart.getTime();

              await prisma.$transaction(async (tx) => {
                await tx.subscription.update({
                  where: { id: existing.id },
                  data: {
                    status: update.status,
                    currentPeriodStart: update.currentPeriodStart,
                    currentPeriodEnd: update.currentPeriodEnd,
                    cancelAtPeriodEnd: update.cancelAtPeriodEnd,
                  },
                });

                if (periodChanged && existing.userId) {
                  const renewResult = await renewUserPeriod(
                    existing.userId,
                    tx,
                  );
                  if (renewResult.success) {
                    logInfo(
                      "Subscription",
                      "Renewed subscription period and reset usage",
                      {
                        userId: existing.userId.slice(0, 8),
                        subscriptionId: existing.id.slice(0, 8),
                        newPeriodStart:
                          renewResult.usage?.periodStart.toISOString(),
                        newPeriodEnd:
                          renewResult.usage?.periodEnd.toISOString(),
                      },
                    );
                  }
                }
              });
            }
          }
          break;
        }

        case "subscription_deleted": {
          const whereClause = update.providerSubscriptionId
            ? { providerSubscriptionId: update.providerSubscriptionId }
            : update.userId
              ? { userId: update.userId }
              : null;

          if (whereClause) {
            const existing = await prisma.subscription.findFirst({
              where: whereClause,
            });
            if (existing) {
              // Downgrade to essential tier
              await prisma.subscription.update({
                where: { id: existing.id },
                data: {
                  tier: "essential",
                  status: "active",
                  provider: null,
                  providerSubscriptionId: null,
                  providerPriceId: null,
                  currentPeriodStart: null,
                  currentPeriodEnd: null,
                  cancelAtPeriodEnd: false,
                },
              });
            }
          }
          break;
        }

        case "payment_failed": {
          const whereClause = update.providerSubscriptionId
            ? { providerSubscriptionId: update.providerSubscriptionId }
            : update.userId
              ? { userId: update.userId }
              : null;

          if (whereClause) {
            await prisma.subscription.updateMany({
              where: whereClause,
              data: { status: "past_due" },
            });
          }
          break;
        }
      }
    }

    return c.json({ received: true });
  },
);

// GET /api/subscription/verify-checkout - Verify a completed checkout session
subscriptionRouter.get("/verify-checkout", requireAuth, async (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) {
    return c.json(
      { error: { message: "Missing session_id", code: "MISSING_PARAM" } },
      400,
    );
  }

  const provider = getPaymentProvider();
  if (!provider.verifyCheckoutSession) {
    return c.json(
      {
        error: {
          message: "Checkout verification not supported",
          code: "NOT_SUPPORTED",
        },
      },
      501,
    );
  }

  const result = await provider.verifyCheckoutSession(sessionId);
  if (!result.success) {
    return c.json(
      {
        error: {
          message: result.error || "Verification failed",
          code: "VERIFICATION_FAILED",
        },
      },
      400,
    );
  }

  const user = c.get("user")!;
  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
    select: { tier: true, status: true },
  });

  return c.json({
    data: {
      paymentStatus: result.paymentStatus,
      subscriptionActive:
        subscription?.tier !== "essential" && subscription?.status === "active",
    },
  });
});

// ============ Provider Status Endpoints ============

// GET /api/subscription/provider-status - Check payment provider status
subscriptionRouter.get("/provider-status", async (c) => {
  return c.json({
    data: {
      defaultProvider: getDefaultProviderName(),
      configured: isPaymentConfigured(),
      availableProviders: getConfiguredProviders(),
      devMode: isDevMode(),
    },
  });
});

// ============ Dev Mode Endpoints ============

// GET /api/subscription/dev-status - Check if dev mode is enabled
subscriptionRouter.get("/dev-status", async (c) => {
  return c.json({
    data: {
      devMode: isDevMode(),
      paymentConfigured: isPaymentConfigured(),
      provider: getDefaultProviderName(),
    },
  });
});

// POST /api/subscription/dev-switch - Switch tier in dev mode (no payment required)
const DevSwitchSchema = z.object({
  tier: z.enum(["essential", "professional", "mastery"]),
});

subscriptionRouter.post(
  "/dev-switch",
  requireAuth,
  zValidator("json", DevSwitchSchema),
  async (c) => {
    if (!isDevMode()) {
      return c.json(
        {
          error: {
            message: "Dev mode is not enabled",
            code: "DEV_MODE_DISABLED",
          },
        },
        403,
      );
    }

    const user = c.get("user")!;
    const { tier } = c.req.valid("json");

    // Update or create subscription with new tier
    const subscription = await prisma.subscription.upsert({
      where: { userId: user.id },
      update: {
        tier,
        status: "active",
        provider: null,
        providerSubscriptionId: null,
        providerPriceId: null,
        currentPeriodStart: tier !== "essential" ? new Date() : null,
        currentPeriodEnd:
          tier !== "essential"
            ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            : null,
        cancelAtPeriodEnd: false,
      },
      create: {
        userId: user.id,
        tier,
        status: "active",
        currentPeriodStart: tier !== "essential" ? new Date() : null,
        currentPeriodEnd:
          tier !== "essential"
            ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            : null,
      },
    });

    const limits = TIER_LIMITS[tier as TierName];
    const features = TIER_FEATURES[tier as TierName];

    return c.json({
      data: {
        subscription: {
          id: subscription.id,
          tier: subscription.tier,
          status: subscription.status,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        },
        limits,
        features,
        message: `Switched to ${tier} tier (dev mode)`,
      },
    });
  },
);

// ============ Admin Endpoints ============

// GET /api/admin/settings - Get all system settings
subscriptionRouter.get("/admin/settings", requireAuth, async (c) => {
  if (!isDevMode()) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Admin access required" } },
      403,
    );
  }

  const freeTierRenewalEnabled = await getSystemSetting(
    SYSTEM_SETTINGS.FREE_TIER_RENEWAL_ENABLED,
  );

  return c.json({
    data: {
      FREE_TIER_RENEWAL_ENABLED: freeTierRenewalEnabled ?? "true",
    },
  });
});

// POST /api/admin/settings - Update a system setting
const UpdateSettingSchema = z.object({
  key: z.string(),
  value: z.string(),
  description: z.string().optional(),
});

subscriptionRouter.post(
  "/admin/settings",
  requireAuth,
  validate("json", UpdateSettingSchema),
  async (c) => {
    const user = c.get("user")!;

    if (!isDevMode()) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin access required" } },
        403,
      );
    }

    const { key, value, description } = c.req.valid("json");

    const validKeys = Object.values(SYSTEM_SETTINGS);
    if (!validKeys.includes(key as (typeof validKeys)[number])) {
      return c.json(
        {
          error: {
            code: "INVALID_KEY",
            message: `Unknown setting key: ${key}`,
          },
        },
        400,
      );
    }

    await setSystemSetting(key, value, description);
    clearSettingsCache();

    logInfo("Admin", `System setting updated: ${key}=${value}`, {
      userId: user.id.slice(0, 8),
    });

    return c.json({
      data: { key, value, message: "Setting updated successfully" },
    });
  },
);
