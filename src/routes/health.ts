import { Hono } from "hono";
import { isRedisHealthy } from "../lib/redis";
import { env } from "../env";
import { prisma } from "../prisma";

const healthRouter = new Hono();

async function isDatabaseHealthy(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

healthRouter.get("/", async (c) => {
  const [redisHealthy, databaseHealthy] = await Promise.all([
    isRedisHealthy(),
    isDatabaseHealthy(),
  ]);

  return c.json({
    status: databaseHealthy ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: {
      api: {
        status: "healthy",
      },
      database: {
        connected: databaseHealthy,
      },
      redis: {
        enabled: !!env.REDIS_URL,
        connected: redisHealthy,
      },
    },
  });
});

export { healthRouter };
