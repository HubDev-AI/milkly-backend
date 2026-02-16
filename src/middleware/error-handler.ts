import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { debugLog, logError } from "../lib/debug";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

function getRequestContext(c: Context): string {
  return `${c.req.method} ${c.req.path}`;
}

function getUserId(c: Context): string | undefined {
  try {
    const user = c.get("user") as { id: string } | undefined;
    return user?.id;
  } catch {
    return undefined;
  }
}

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (err) {
    const requestContext = getRequestContext(c);
    const userId = getUserId(c);

    debugLog("[ErrorHandler]", "Caught error", {
      path: requestContext,
      userId,
    });

    if (err instanceof AppError) {
      logError("AppError", requestContext, {
        code: err.code,
        message: err.message,
        userId,
        ...(!IS_PRODUCTION && err.stack ? { stack: err.stack } : {}),
      });
      return c.json(
        {
          error: { code: err.code, message: err.message },
        },
        err.statusCode as 400,
      );
    }

    if (err instanceof ZodError) {
      const flatErrors = err.flatten().fieldErrors;
      logError("ValidationError", requestContext, {
        fields: flatErrors,
        userId,
      });
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request data",
            details: flatErrors,
          },
        },
        400,
      );
    }

    if (err instanceof HTTPException) {
      logError("HTTPException", requestContext, {
        status: err.status,
        message: err.message,
        userId,
        ...(!IS_PRODUCTION && err.stack ? { stack: err.stack } : {}),
      });
      return c.json(
        {
          error: { code: "HTTP_ERROR", message: err.message },
        },
        err.status,
      );
    }

    // Unknown error
    logError("UnhandledError", requestContext, {
      error: err instanceof Error ? err.message : String(err),
      userId,
      ...(!IS_PRODUCTION && err instanceof Error && err.stack
        ? { stack: err.stack }
        : {}),
    });
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      },
      500,
    );
  }
}

// Helper to throw typed errors
export function throwError(
  code: string,
  message: string,
  status: number = 400,
): never {
  throw new AppError(code, message, status);
}

// Helper to extract error message from unknown error
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
