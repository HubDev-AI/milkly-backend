import type { Context, Next } from "hono";
import type { Session, User } from "better-auth";
import type { AIOperationType } from "../config/tiers";

// Define the Variables type for authenticated routes
export interface AuthVariables {
  user: User | null;
  session: Session | null;
  aiOperation?: AIOperationType;
}

export async function requireAuth(
  c: Context<{ Variables: AuthVariables }>,
  next: Next,
) {
  const user = c.get("user");
  if (!user) {
    return c.json(
      { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
      401,
    );
  }
  await next();
}
