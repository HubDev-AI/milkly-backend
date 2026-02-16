import type { Context, Next } from "hono";
import type { SubscriptionSnapshot } from "@prisma/client";
import { prisma } from "../prisma";
import {
  TIER_LIMITS,
  isUnlimited,
  getTierLimits,
  getAICreditCost,
  type TierName,
  type AIOperationType,
} from "../config/tiers";
import { logInfo } from "../lib/debug";
import { isFreeTierRenewalEnabled } from "../services/settings";

const TIER_LOG_PREFIX = "TIER";
const MONTHLY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

export type UsageAction = "refresh" | "aiCredits";

interface LimitError {
  code: "LIMIT_EXCEEDED" | "FEATURE_LOCKED";
  message: string;
  limit: string;
  current: number;
  max: number;
  upgradeUrl: string;
}

interface LimitErrorResponse {
  error: LimitError;
}

function createLimitError(
  code: "LIMIT_EXCEEDED" | "FEATURE_LOCKED",
  message: string,
  limit: string,
  current: number,
  max: number,
): LimitErrorResponse {
  return {
    error: {
      code,
      message,
      limit,
      current,
      max,
      upgradeUrl: "/pricing",
    },
  };
}

// Get user's current tier
export async function getUserTier(userId: string): Promise<TierName> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
  });

  // Normalize "free" to "essential" and ensure we always return a valid tier
  const tier = (subscription?.tier as string) || "essential";
  if (tier === "free") return "essential";

  // Check if it's a valid tier, otherwise fallback to essential
  return (tier in TIER_LIMITS ? tier : "essential") as TierName;
}

// Get usage period boundaries based on subscription or account creation
async function getUserPeriodBoundaries(
  userId: string,
): Promise<{ start: Date; end: Date }> {
  // Check if user has subscription with billing period
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    select: { currentPeriodStart: true, currentPeriodEnd: true, tier: true },
  });

  // Use subscription billing period if available (both paid and free users after renewal)
  if (subscription?.currentPeriodStart && subscription?.currentPeriodEnd) {
    return {
      start: subscription.currentPeriodStart,
      end: subscription.currentPeriodEnd,
    };
  }

  // Fallback for users without stored period dates: rolling 30-day period from account creation
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true },
  });

  const createdAt = user?.createdAt || new Date();
  const now = Date.now();
  const createdAtMs = createdAt.getTime();

  // Calculate how many full periods have passed since account creation
  const periodsPassed = Math.floor((now - createdAtMs) / MONTHLY_PERIOD_MS);
  const periodStartMs = createdAtMs + periodsPassed * MONTHLY_PERIOD_MS;

  return {
    start: new Date(periodStartMs),
    end: new Date(periodStartMs + MONTHLY_PERIOD_MS),
  };
}

export interface UsageWithStatus {
  id: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  aiCreditsUsed: number;
  refreshesUsed: number;
  freeTierExpired?: boolean;
  canRenew?: boolean;
  expiredMessage?: string;
}

// Get user's current usage for the period (handles free tier auto-renewal)
export async function getUserUsage(userId: string): Promise<UsageWithStatus> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    select: { tier: true },
  });

  // Normalize "free" to "essential"
  let tierRaw = (subscription?.tier as string) || "essential";
  if (tierRaw === "free") tierRaw = "essential";

  const tier = (tierRaw in TIER_LIMITS ? tierRaw : "essential") as TierName;

  if (tier === "essential") {
    const freeTierStatus = await checkFreeTierStatus(userId);

    if (freeTierStatus.periodExpired) {
      if (freeTierStatus.canRenew) {
        const renewResult = await renewUserPeriod(userId);
        if (renewResult.success && renewResult.usage) {
          const newUsage = await prisma.usageRecord.findFirst({
            where: {
              userId,
              periodStart: renewResult.usage.periodStart,
            },
          });

          if (newUsage) {
            logInfo(
              TIER_LOG_PREFIX,
              `Auto-renewed free tier period for user:`,
              {
                userId: userId.slice(0, 8),
                periodStart: renewResult.usage.periodStart.toISOString(),
                periodEnd: renewResult.usage.periodEnd.toISOString(),
              },
            );

            return {
              ...newUsage,
              freeTierExpired: false,
              canRenew: true,
            };
          }
        }
      } else {
        const { start, end } = await getUserPeriodBoundaries(userId);
        let usage = await prisma.usageRecord.findFirst({
          where: { userId, periodStart: start },
        });

        if (!usage) {
          usage = await prisma.usageRecord.create({
            data: {
              userId,
              periodStart: start,
              periodEnd: end,
              refreshesUsed: 0,
              aiCreditsUsed: 0,
            },
          });
        }

        return {
          ...usage,
          freeTierExpired: true,
          canRenew: false,
          expiredMessage: freeTierStatus.message,
        };
      }
    }
  }

  const { start, end } = await getUserPeriodBoundaries(userId);

  let usage = await prisma.usageRecord.findFirst({
    where: {
      userId,
      periodStart: start,
    },
  });

  if (!usage) {
    usage = await prisma.usageRecord.create({
      data: {
        userId,
        periodStart: start,
        periodEnd: end,
        refreshesUsed: 0,
        aiCreditsUsed: 0,
      },
    });
  }

  return usage;
}

// Check if user can perform an action
export async function checkUsageLimit(
  userId: string,
  action: UsageAction,
  amount: number = 1,
): Promise<{
  allowed: boolean;
  current: number;
  limit: number;
  resetAt: Date;
  error?: string;
}> {
  const userLimits = await getLimitsForUser(userId);
  const usage = await getUserUsage(userId);

  if (!userLimits) {
    const freeTierStatus = await checkFreeTierStatus(userId);
    if (!freeTierStatus.active) {
      return {
        allowed: false,
        current: 0,
        limit: 0,
        resetAt: new Date(),
        error:
          freeTierStatus.message ||
          "Subscription expired. Please upgrade to continue.",
      };
    }
    const limits = getTierLimits("essential");
    logInfo(
      TIER_LOG_PREFIX,
      `[${userId.slice(0, 8)}] Using limits from config (essential tier fallback):`,
      {
        aiCredits: limits.aiCredits,
        refreshes: limits.refreshes,
      },
    );
    return checkUsageLimitWithLimits(userId, action, amount, limits, usage);
  }

  logInfo(
    TIER_LOG_PREFIX,
    `[${userId.slice(0, 8)}] Using limits from ${userLimits.fromSnapshot ? "snapshot" : "config"}:`,
    {
      aiCredits: userLimits.aiCredits,
      refreshes: userLimits.refreshes,
    },
  );

  return checkUsageLimitWithLimits(userId, action, amount, userLimits, usage);
}

function checkUsageLimitWithLimits(
  _userId: string,
  action: UsageAction,
  amount: number,
  limits: { aiCredits: number; refreshes: number },
  usage: UsageWithStatus,
): {
  allowed: boolean;
  current: number;
  limit: number;
  resetAt: Date;
  error?: string;
} {
  if (action === "refresh") {
    const limit = limits.refreshes;
    if (isUnlimited(limit)) {
      return {
        allowed: true,
        current: usage.refreshesUsed,
        limit: -1,
        resetAt: usage.periodEnd,
      };
    }
    return {
      allowed: usage.refreshesUsed + amount <= limit,
      current: usage.refreshesUsed,
      limit,
      resetAt: usage.periodEnd,
    };
  }

  if (action === "aiCredits") {
    const limit = limits.aiCredits;
    if (isUnlimited(limit)) {
      return {
        allowed: true,
        current: usage.aiCreditsUsed,
        limit: -1,
        resetAt: usage.periodEnd,
      };
    }
    return {
      allowed: usage.aiCreditsUsed + amount <= limit,
      current: usage.aiCreditsUsed,
      limit,
      resetAt: usage.periodEnd,
    };
  }

  throw new Error(`Unknown action: ${action}`);
}

// Increment usage counter
export async function incrementUsage(
  userId: string,
  action: UsageAction,
  amount: number = 1,
): Promise<void> {
  const usage = await getUserUsage(userId);
  const tier = await getUserTier(userId);
  const limits = getTierLimits(tier);

  if (action === "refresh") {
    await prisma.usageRecord.update({
      where: { id: usage.id },
      data: { refreshesUsed: { increment: amount } },
    });

    const newUsed = usage.refreshesUsed + amount;
    const remaining = isUnlimited(limits.refreshes)
      ? "unlimited"
      : limits.refreshes - newUsed;
    const resetIn = Math.ceil(
      (usage.periodEnd.getTime() - Date.now()) / (1000 * 60 * 60),
    );

    logInfo(
      TIER_LOG_PREFIX,
      `[${userId.slice(0, 8)}] Refresh count incremented:`,
      {
        before: usage.refreshesUsed,
        after: newUsed,
        limit: isUnlimited(limits.refreshes) ? "unlimited" : limits.refreshes,
        remaining,
        resetIn: `${resetIn}h`,
        resetAt: usage.periodEnd.toISOString(),
      },
    );
  } else if (action === "aiCredits") {
    await prisma.usageRecord.update({
      where: { id: usage.id },
      data: { aiCreditsUsed: { increment: amount } },
    });
  }
}

// Check AI credits for a specific operation
export async function checkAICredits(
  userId: string,
  operation: AIOperationType,
): Promise<{
  allowed: boolean;
  current: number;
  limit: number;
  cost: number;
  resetAt: Date;
  error?: string;
}> {
  const cost = getAICreditCost(operation);
  const result = await checkUsageLimit(userId, "aiCredits", cost);

  if (result.error) {
    return { ...result, cost };
  }

  const remaining = isUnlimited(result.limit)
    ? "unlimited"
    : result.limit - result.current;
  const resetIn = Math.ceil(
    (result.resetAt.getTime() - Date.now()) / (1000 * 60 * 60),
  );

  logInfo(
    TIER_LOG_PREFIX,
    `[${userId.slice(0, 8)}] AI credits check for "${operation}":`,
    {
      operation,
      cost,
      used: result.current,
      limit: isUnlimited(result.limit) ? "unlimited" : result.limit,
      remaining,
      allowed: result.allowed,
      resetIn: `${resetIn}h`,
      resetAt: result.resetAt.toISOString(),
    },
  );

  return { ...result, cost };
}

// Deduct AI credits for a specific operation
export async function deductAICredits(
  userId: string,
  operation: AIOperationType,
): Promise<void> {
  const cost = getAICreditCost(operation);
  const tier = await getUserTier(userId);
  const limits = getTierLimits(tier);
  const usageBefore = await getUserUsage(userId);

  await incrementUsage(userId, "aiCredits", cost);

  const newUsed = usageBefore.aiCreditsUsed + cost;
  const remaining = isUnlimited(limits.aiCredits)
    ? "unlimited"
    : limits.aiCredits - newUsed;
  const resetIn = Math.ceil(
    (usageBefore.periodEnd.getTime() - Date.now()) / (1000 * 60 * 60),
  );

  logInfo(
    TIER_LOG_PREFIX,
    `[${userId.slice(0, 8)}] AI credits DEDUCTED for "${operation}":`,
    {
      operation,
      cost,
      before: usageBefore.aiCreditsUsed,
      after: newUsed,
      limit: isUnlimited(limits.aiCredits) ? "unlimited" : limits.aiCredits,
      remaining,
      resetIn: `${resetIn}h`,
      resetAt: usageBefore.periodEnd.toISOString(),
    },
  );
}

/**
 * Middleware factory that checks if user has enough AI credits for an operation.
 * Returns 403 with proper error if insufficient credits.
 * Does NOT deduct credits - that should be done after successful operation.
 */
export function requireAICredits(operation: AIOperationType) {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        401,
      );
    }

    const result = await checkAICredits(user.id, operation);

    if (!result.allowed) {
      const cost = getAICreditCost(operation);
      return c.json(
        {
          error: {
            code: "LIMIT_EXCEEDED",
            message: `Insufficient AI credits. This operation requires ${cost} credits.`,
            limit: "aiCredits",
            current: result.current,
            max: result.limit,
            cost: cost,
            resetAt: result.resetAt.toISOString(),
            upgradeUrl: "/pricing",
          },
        },
        403,
      );
    }

    // Store the operation in context so route handler can deduct after success
    c.set("aiOperation", operation);

    await next();
  };
}

/**
 * Call this after a successful AI operation to deduct credits.
 * Usage: await deductCreditsFromContext(c);
 */
export async function deductCreditsFromContext(c: Context): Promise<void> {
  const user = c.get("user");
  const operation = c.get("aiOperation") as AIOperationType | undefined;

  if (user && operation) {
    logInfo(
      TIER_LOG_PREFIX,
      `[${user.id.slice(0, 8)}] Deducting credits from context for "${operation}"`,
    );
    await deductAICredits(user.id, operation);
  }
}

/**
 * Middleware factory that checks if user has enough refreshes for the period.
 * Returns 403 with proper error if limit exceeded.
 */
export function requireRefreshLimit() {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        401,
      );
    }

    const result = await checkUsageLimit(user.id, "refresh");

    const remaining = isUnlimited(result.limit)
      ? "unlimited"
      : result.limit - result.current;
    const resetIn = Math.ceil(
      (result.resetAt.getTime() - Date.now()) / (1000 * 60 * 60),
    );

    logInfo(TIER_LOG_PREFIX, `[${user.id.slice(0, 8)}] Refresh limit check:`, {
      used: result.current,
      limit: isUnlimited(result.limit) ? "unlimited" : result.limit,
      remaining,
      allowed: result.allowed,
      resetIn: `${resetIn}h`,
      resetAt: result.resetAt.toISOString(),
    });

    if (!result.allowed) {
      return c.json(
        {
          error: {
            code: "LIMIT_EXCEEDED",
            message: "Refresh limit reached for this period.",
            limit: "refreshes",
            current: result.current,
            max: result.limit,
            resetAt: result.resetAt.toISOString(),
            upgradeUrl: "/pricing",
          },
        },
        403,
      );
    }

    await next();
  };
}

// Check stream count limit
export async function checkStreamLimit(
  userId: string,
): Promise<{ allowed: boolean; error?: LimitError }> {
  const tier = await getUserTier(userId);
  const limits = TIER_LIMITS[tier];

  if (isUnlimited(limits.maxStreams)) {
    return { allowed: true };
  }

  const streamCount = await prisma.stream.count({
    where: { userId },
  });

  if (streamCount >= limits.maxStreams) {
    return {
      allowed: false,
      ...createLimitError(
        "LIMIT_EXCEEDED",
        `You've reached your stream limit (${limits.maxStreams}). Upgrade or delete a stream to create a new one.`,
        "maxStreams",
        streamCount,
        limits.maxStreams,
      ),
    };
  }

  return { allowed: true };
}

// Check if user can use linked streams feature
export async function checkLinkedStreamsAccess(
  userId: string,
): Promise<{ allowed: boolean; error?: LimitError }> {
  const tier = await getUserTier(userId);
  const limits = TIER_LIMITS[tier];

  if (!limits.linkedStreams) {
    return {
      allowed: false,
      ...createLimitError(
        "FEATURE_LOCKED",
        "Linked streams is a Professional feature. Upgrade to access.",
        "linkedStreams",
        0,
        0,
      ),
    };
  }

  return { allowed: true };
}

// Check subscriber count limit for sending emails
export async function checkSubscriberLimit(
  userId: string,
  subscriberCount: number,
): Promise<{ allowed: boolean; error?: LimitError }> {
  const tier = await getUserTier(userId);
  const limits = TIER_LIMITS[tier];

  if (isUnlimited(limits.maxEmailSubscribers)) {
    return { allowed: true };
  }

  if (subscriberCount > limits.maxEmailSubscribers) {
    return {
      allowed: false,
      error: {
        code: "LIMIT_EXCEEDED",
        message: `Your plan allows sending to ${limits.maxEmailSubscribers} subscribers. You have ${subscriberCount}. Upgrade to send to more subscribers.`,
        limit: "maxEmailSubscribers",
        current: subscriberCount,
        max: limits.maxEmailSubscribers,
        upgradeUrl: "/pricing",
      },
    };
  }

  return { allowed: true };
}

// Middleware factory to check usage before action
export function requireUsageLimit(action: UsageAction) {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
        401,
      );
    }

    const result = await checkUsageLimit(user.id, action);
    if (!result.allowed) {
      return c.json(
        {
          error: {
            code: "LIMIT_EXCEEDED",
            message: `You've reached your ${action} limit. Upgrade to continue.`,
            limit: action,
            current: result.current,
            max: result.limit,
            upgradeUrl: "/pricing",
          },
        },
        403,
      );
    }

    await next();
  };
}

// Middleware to check stream limit
export async function requireStreamLimit(c: Context, next: Next) {
  const user = c.get("user");
  if (!user) {
    return c.json(
      { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
      401,
    );
  }

  const { allowed, error } = await checkStreamLimit(user.id);
  if (!allowed && error) {
    return c.json({ error }, 403);
  }

  await next();
}

// Generic static limit types (not periodic counters)
export type StaticLimitType =
  | "maxStreams"
  | "maxEmailSubscribers"
  | "maxStorageMB";

const STATIC_LIMIT_MESSAGES: Record<
  StaticLimitType,
  (max: number, current: number) => string
> = {
  maxStreams: (max, _current) =>
    `You've reached your stream limit (${max}). Upgrade or delete a stream to create a new one.`,
  maxEmailSubscribers: (max, current) =>
    `Your plan allows sending to ${max} subscribers. You have ${current}. Upgrade to send to more subscribers.`,
  maxStorageMB: (max, current) =>
    `You've reached your storage limit (${max} MB). You're using ${current} MB. Upgrade for more storage.`,
};

// Generic check for static limits (not periodic counters)
export async function checkStaticLimit(
  userId: string,
  limitType: StaticLimitType,
  currentValue: number,
): Promise<{ allowed: boolean; error?: LimitError }> {
  const tier = await getUserTier(userId);
  const limits = TIER_LIMITS[tier];
  const maxValue = limits[limitType] as number;

  if (isUnlimited(maxValue)) {
    return { allowed: true };
  }

  if (currentValue > maxValue) {
    return {
      allowed: false,
      ...createLimitError(
        "LIMIT_EXCEEDED",
        STATIC_LIMIT_MESSAGES[limitType](maxValue, currentValue),
        limitType,
        currentValue,
        maxValue,
      ),
    };
  }

  return { allowed: true };
}

type PrismaTransaction = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

export async function createEntitlementSnapshot(
  subscriptionId: string,
  tier: TierName,
  periodStart: Date,
  periodEnd: Date,
  tx?: PrismaTransaction,
): Promise<SubscriptionSnapshot> {
  const limits = TIER_LIMITS[tier];
  const db = tx || prisma;

  const snapshot = await db.subscriptionSnapshot.create({
    data: {
      subscriptionId,
      tier,
      maxStreams: limits.maxStreams,
      aiCredits: limits.aiCredits,
      refreshes: limits.refreshes,
      maxEmailSubscribers: limits.maxEmailSubscribers,
      maxStorageMB: limits.maxStorageMB,
      linkedStreams: limits.linkedStreams,
      allowedCategories: JSON.stringify(limits.allowedCategories),
      periodStart,
      periodEnd,
    },
  });

  logInfo(TIER_LOG_PREFIX, `Created entitlement snapshot for subscription:`, {
    subscriptionId: subscriptionId.slice(0, 8),
    tier,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    snapshotId: snapshot.id.slice(0, 8),
  });

  return snapshot;
}

export async function getActiveSnapshot(
  subscriptionId: string,
): Promise<SubscriptionSnapshot | null> {
  const now = new Date();

  const snapshot = await prisma.subscriptionSnapshot.findFirst({
    where: {
      subscriptionId,
      periodStart: { lte: now },
      periodEnd: { gt: now },
    },
    orderBy: { periodStart: "desc" },
  });

  return snapshot;
}

export interface UserLimits {
  maxStreams: number;
  aiCredits: number;
  refreshes: number;
  maxEmailSubscribers: number;
  maxStorageMB: number;
  linkedStreams: boolean;
  allowedCategories: string[];
  fromSnapshot: boolean;
  snapshotedAt?: Date;
}

export async function getLimitsForUser(
  userId: string,
): Promise<UserLimits | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
  });

  if (!subscription) {
    return null;
  }

  const snapshot = await getActiveSnapshot(subscription.id);

  if (snapshot) {
    return {
      maxStreams: snapshot.maxStreams,
      aiCredits: snapshot.aiCredits,
      refreshes: snapshot.refreshes,
      maxEmailSubscribers: snapshot.maxEmailSubscribers,
      maxStorageMB: snapshot.maxStorageMB,
      linkedStreams: snapshot.linkedStreams,
      allowedCategories: JSON.parse(snapshot.allowedCategories) as string[],
      fromSnapshot: true,
      snapshotedAt: snapshot.createdAt,
    };
  }

  // Normalize "free" to "essential" and ensure valid tier
  let tierName = (subscription.tier as string) || "essential";
  if (tierName === "free") tierName = "essential";

  const tier = (tierName in TIER_LIMITS ? tierName : "essential") as TierName;
  const limits = TIER_LIMITS[tier];

  return {
    maxStreams: limits.maxStreams,
    aiCredits: limits.aiCredits,
    refreshes: limits.refreshes,
    maxEmailSubscribers: limits.maxEmailSubscribers,
    maxStorageMB: limits.maxStorageMB,
    linkedStreams: limits.linkedStreams,
    allowedCategories: limits.allowedCategories,
    fromSnapshot: false,
  };
}

export async function renewUserPeriod(
  userId: string,
  tx?: PrismaTransaction,
): Promise<{
  success: boolean;
  snapshot?: SubscriptionSnapshot;
  usage?: { periodStart: Date; periodEnd: Date };
  error?: string;
}> {
  const db = tx || prisma;

  const subscription = await db.subscription.findUnique({
    where: { userId },
  });

  if (!subscription) {
    return { success: false, error: "No subscription found" };
  }

  // Normalize "free" to "essential"
  let tierRaw = (subscription.tier as string) || "essential";
  if (tierRaw === "free") tierRaw = "essential";

  const tier = (tierRaw in TIER_LIMITS ? tierRaw : "essential") as TierName;
  let periodStart: Date;
  let periodEnd: Date;

  if (tier !== "essential") {
    if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) {
      return {
        success: false,
        error: "Paid subscription missing period dates",
      };
    }
    periodStart = subscription.currentPeriodStart;
    periodEnd = subscription.currentPeriodEnd;
  } else {
    periodStart = new Date();
    periodEnd = new Date(periodStart.getTime() + MONTHLY_PERIOD_MS);
  }

  const snapshot = await createEntitlementSnapshot(
    subscription.id,
    tier,
    periodStart,
    periodEnd,
    db,
  );

  await db.usageRecord.create({
    data: {
      userId,
      periodStart,
      periodEnd,
      aiCreditsUsed: 0,
      refreshesUsed: 0,
    },
  });

  if (tier === "essential") {
    await db.subscription.update({
      where: { id: subscription.id },
      data: {
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
  }

  logInfo(TIER_LOG_PREFIX, `Renewed period for user:`, {
    userId: userId.slice(0, 8),
    tier,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    snapshotId: snapshot.id.slice(0, 8),
  });

  return {
    success: true,
    snapshot,
    usage: { periodStart, periodEnd },
  };
}

export interface FreeTierStatus {
  active: boolean;
  canRenew: boolean;
  periodExpired: boolean;
  expiredAt?: Date;
  message?: string;
}

export async function checkFreeTierStatus(
  userId: string,
): Promise<FreeTierStatus> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
  });

  // Normalize "free" to "essential"
  let tier = (subscription?.tier as string) || "essential";
  if (tier === "free") tier = "essential";

  // If undefined tier, treat as essential
  if (tier && !(tier in TIER_LIMITS)) tier = "essential";

  if (!subscription || tier !== "essential") {
    return { active: true, canRenew: true, periodExpired: false };
  }

  const now = new Date();
  const periodEnd = subscription.currentPeriodEnd;

  if (!periodEnd || periodEnd > now) {
    return { active: true, canRenew: true, periodExpired: false };
  }

  const renewalEnabled = await isFreeTierRenewalEnabled();

  if (renewalEnabled) {
    return { active: true, canRenew: true, periodExpired: true };
  }

  return {
    active: false,
    canRenew: false,
    periodExpired: true,
    expiredAt: periodEnd,
    message: "Essential plan period ended. Please upgrade to continue.",
  };
}
