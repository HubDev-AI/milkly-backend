import { Hono } from "hono";
import type { Context, Next } from "hono";
import "./env";
import { auth } from "./auth";
import { streamsRouter } from "./routes/streams";
import { feedRouter } from "./routes/feed";
import { newslettersRouter } from "./routes/newsletters/index";
import { templatesRouter } from "./routes/templates";
import { subscriptionRouter } from "./routes/subscription";
import { linkedStreamsRouter } from "./routes/linked-streams";
import { accountRouter } from "./routes/account";
import { publicRouter } from "./routes/public";
import { aiGenerateRouter } from "./routes/ai-generate";
import { mediaRouter } from "./routes/media";
import { healthRouter } from "./routes/health";
import { adminRouter } from "./routes/admin";
import { authRateLimit, apiRateLimit } from "./middleware/rate-limit";
import { errorHandler } from "./middleware/error-handler";
import type { Session, User } from "better-auth";

// API version prefix - change this when releasing new API versions
const API_PREFIX = "/api/v1";

// Define variable types for Hono context
type Variables = {
  user: User | null;
  session: Session | null;
};

const app = new Hono<{ Variables: Variables }>();

// Error handler middleware (first in chain)
app.use("*", errorHandler);

// CORS middleware - validates origin against allowlist
const allowedOrigins = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/[a-z0-9-]+\.milkly\.app$/,
];

function isAllowedOrigin(origin: string | undefined): string | null {
  return origin && allowedOrigins.some((re) => re.test(origin)) ? origin : null;
}

async function corsMiddleware(c: Context, next: Next) {
  const origin = isAllowedOrigin(c.req.header("origin"));

  if (c.req.method === "OPTIONS") {
    const headers = new Headers();
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Credentials", "true");
    }
    headers.set("Access-Control-Allow-Methods", "GET,HEAD,PUT,POST,DELETE,PATCH");
    const reqHeaders = c.req.header("Access-Control-Request-Headers");
    if (reqHeaders) {
      headers.set("Access-Control-Allow-Headers", reqHeaders);
    }
    headers.set("Vary", "Origin");
    return new Response(null, { status: 204, headers });
  }

  await next();

  if (origin) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Access-Control-Allow-Credentials", "true");
    c.res.headers.append("Vary", "Origin");
  }
}

app.use("*", corsMiddleware);

// Logging with timestamps
app.use("*", async (c, next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  const method = c.req.method;
  const path = c.req.path;

  console.log(`[${timestamp}] <-- ${method} ${path}`);

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;
  const endTimestamp = new Date().toISOString();

  console.log(
    `[${endTimestamp}] --> ${method} ${path} ${status} ${duration}ms`,
  );
});

// Auth middleware - populates user and session for all routes
app.use("*", async (c, next) => {
  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (session) {
      c.set("user", session.user as User);
      c.set("session", session.session as Session);
    } else {
      c.set("user", null);
      c.set("session", null);
    }
  } catch {
    c.set("user", null);
    c.set("session", null);
  }

  await next();
});

// Mount health check endpoint
app.route(`${API_PREFIX}/health`, healthRouter);

// Mount Better Auth handler with rate limiting
app.use(`${API_PREFIX}/auth/*`, authRateLimit);
app.on(["POST", "GET"], `${API_PREFIX}/auth/*`, async (c) => {
  const response = await auth.handler(c.req.raw);
  // Strip better-auth's CORS headers — our middleware handles CORS
  const headers = new Headers(response.headers);
  headers.delete("access-control-allow-origin");
  headers.delete("access-control-allow-credentials");
  headers.delete("access-control-allow-methods");
  headers.delete("access-control-allow-headers");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});

// Apply general API rate limiting to all API routes (except auth which has stricter limits)
app.use(`${API_PREFIX}/streams/*`, apiRateLimit);
app.use(`${API_PREFIX}/newsletters/*`, apiRateLimit);
app.use(`${API_PREFIX}/templates/*`, apiRateLimit);
app.use(`${API_PREFIX}/subscription/*`, apiRateLimit);
app.use(`${API_PREFIX}/linked-streams/*`, apiRateLimit);
app.use(`${API_PREFIX}/account/*`, apiRateLimit);
app.use(`${API_PREFIX}/ai/*`, apiRateLimit);
app.use(`${API_PREFIX}/media/*`, apiRateLimit);
app.use(`${API_PREFIX}/admin/*`, apiRateLimit);

// Mount API routes
app.route(`${API_PREFIX}/streams`, streamsRouter);
app.route(`${API_PREFIX}/streams`, feedRouter);
app.route(`${API_PREFIX}`, newslettersRouter);
app.route(`${API_PREFIX}/streams`, templatesRouter);
app.route(`${API_PREFIX}`, templatesRouter);
app.route(`${API_PREFIX}/subscription`, subscriptionRouter);
app.route(`${API_PREFIX}/linked-streams`, linkedStreamsRouter);
app.route(`${API_PREFIX}/account`, accountRouter);
app.route(`${API_PREFIX}/public`, publicRouter);
app.route(`${API_PREFIX}/ai`, aiGenerateRouter);
app.route(`${API_PREFIX}/media`, mediaRouter);
app.route(`${API_PREFIX}/admin`, adminRouter);

const port = Number(process.env.PORT) || 3000;

export default {
  port,
  fetch: app.fetch,
};
