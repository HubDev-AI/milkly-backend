import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets, Context } from "hono";
import type { Hook } from "@hono/zod-validator";

// Custom error formatter for consistent API error responses
export const validationHook: Hook<any, any, string, any> = (result, c) => {
  if (!result.success) {
    const zodError = result.error as z.ZodError;
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request data",
          details: zodError.flatten().fieldErrors,
        },
      },
      400,
    );
  }
};

// Re-export zValidator with custom hook
export function validate<T extends z.ZodSchema>(
  target: keyof ValidationTargets,
  schema: T,
) {
  return zValidator(target, schema, validationHook);
}

// Common validation schemas for reuse
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});
