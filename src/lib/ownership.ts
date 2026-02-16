import { prisma } from "../prisma";
import { throwError } from "../middleware/error-handler";

type ResourceType =
  | "stream"
  | "linkedStream"
  | "template"
  | "linkedStreamTemplate"
  | "newsletter"
  | "mediaFile";

/**
 * Verify that a user owns a specific resource.
 * Throws NOT_FOUND error if the resource doesn't exist or isn't owned by the user.
 */
export async function verifyOwnership(
  resource: ResourceType,
  id: string,
  userId: string,
): Promise<void> {
  let exists = false;

  switch (resource) {
    case "stream":
      exists = !!(await prisma.stream.findFirst({
        where: { id, userId },
        select: { id: true },
      }));
      break;
    case "linkedStream":
      exists = !!(await prisma.linkedStream.findFirst({
        where: { id, userId },
        select: { id: true },
      }));
      break;
    case "template":
      exists = !!(await prisma.template.findFirst({
        where: { id, stream: { userId } },
        select: { id: true },
      }));
      break;
    case "linkedStreamTemplate":
      exists = !!(await prisma.linkedStreamTemplate.findFirst({
        where: { id, linkedStream: { userId } },
        select: { id: true },
      }));
      break;
    case "newsletter":
      exists = !!(await prisma.newsletter.findFirst({
        where: { id, stream: { userId } },
        select: { id: true },
      }));
      break;
    case "mediaFile":
      exists = !!(await prisma.mediaFile.findFirst({
        where: { id, userId },
        select: { id: true },
      }));
      break;
  }

  if (!exists) {
    throwError("NOT_FOUND", `${resource} not found`, 404);
  }
}

/**
 * Verify ownership and return the resource if found.
 * Returns null if not found (doesn't throw).
 */
export async function findWithOwnership<T>(
  resource: ResourceType,
  id: string,
  userId: string,
  select?: Record<string, boolean>,
): Promise<T | null> {
  const defaultSelect = { id: true };
  const selectClause = select ?? defaultSelect;

  switch (resource) {
    case "stream":
      return prisma.stream.findFirst({
        where: { id, userId },
        select: selectClause,
      }) as Promise<T | null>;
    case "linkedStream":
      return prisma.linkedStream.findFirst({
        where: { id, userId },
        select: selectClause,
      }) as Promise<T | null>;
    default:
      return null;
  }
}
