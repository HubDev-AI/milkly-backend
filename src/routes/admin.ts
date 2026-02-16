import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireAuth, type AuthVariables } from "../middleware/auth";

export const adminRouter = new Hono<{ Variables: AuthVariables }>();

const VALID_TIERS = ["essential", "professional", "mastery"] as const;

const UpdateTierConfigSchema = z.object({
  features: z.array(z.string()).min(1).max(10),
});

// GET /api/admin/tier-config - get all tier configs (admin only)
adminRouter.get("/tier-config", requireAuth, async (c) => {
  const user = c.get("user")!;

  const isAdmin = user.email?.endsWith("@milkly.app") || false;
  if (!isAdmin) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Admin access required" } },
      403,
    );
  }

  const configs = await prisma.tierConfig.findMany({
    orderBy: { tier: "asc" },
  });

  return c.json({ data: configs });
});

// PUT /api/admin/tier-config/:tier - update tier features (admin only)
adminRouter.put(
  "/tier-config/:tier",
  requireAuth,
  zValidator("json", UpdateTierConfigSchema),
  async (c) => {
    const user = c.get("user")!;
    const tier = c.req.param("tier");
    const { features } = c.req.valid("json");

    const isAdmin = user.email?.endsWith("@milkly.app") || false;
    if (!isAdmin) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin access required" } },
        403,
      );
    }

    if (!VALID_TIERS.includes(tier as (typeof VALID_TIERS)[number])) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid tier" } },
        400,
      );
    }

    const config = await prisma.tierConfig.upsert({
      where: { tier },
      update: { features },
      create: { tier, features },
    });

    return c.json({ data: config });
  },
);
