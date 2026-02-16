import { PrismaClient, Prisma } from "@prisma/client";

// Models that use soft delete (have deletedAt field)
const SOFT_DELETE_MODELS = [
  "ContentItem",
  "LinkedStreamCustomItem",
  "Template",
  "LinkedStreamTemplate",
] as const;
type SoftDeleteModel = (typeof SOFT_DELETE_MODELS)[number];

function isSoftDeleteModel(model: string): model is SoftDeleteModel {
  return SOFT_DELETE_MODELS.includes(model as SoftDeleteModel);
}

// Create base PrismaClient
const basePrisma = new PrismaClient({
  log:
    process.env.LOG_LEVEL === "trace" ? ["query", "error", "warn"] : ["error"],
});

// Extend with soft delete filtering and methods
export const prisma = basePrisma
  .$extends({
    name: "softDeleteFilter",
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          if (isSoftDeleteModel(model)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async findFirst({ model, args, query }) {
          if (isSoftDeleteModel(model)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async findUnique({ model, args, query }) {
          if (isSoftDeleteModel(model)) {
            // findUnique doesn't support deletedAt in where directly,
            // so we need to use findFirst instead for soft delete models
            // But we'll let it pass through and rely on explicit checks
          }
          return query(args);
        },
        async count({ model, args, query }) {
          if (isSoftDeleteModel(model)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async aggregate({ model, args, query }) {
          if (isSoftDeleteModel(model)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async groupBy({ model, args, query }) {
          if (isSoftDeleteModel(model)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
      },
    },
  })
  .$extends({
    name: "softDeleteMethods",
    model: {
      contentItem: {
        /**
         * Soft delete a single ContentItem by setting deletedAt
         */
        async softDelete(where: Prisma.ContentItemWhereUniqueInput) {
          return basePrisma.contentItem.update({
            where,
            data: { deletedAt: new Date() },
          });
        },
        /**
         * Soft delete multiple ContentItems by setting deletedAt
         */
        async softDeleteMany(where: Prisma.ContentItemWhereInput) {
          return basePrisma.contentItem.updateMany({
            where,
            data: { deletedAt: new Date() },
          });
        },
      },
      linkedStreamCustomItem: {
        /**
         * Soft delete a single LinkedStreamCustomItem by setting deletedAt
         */
        async softDelete(where: Prisma.LinkedStreamCustomItemWhereUniqueInput) {
          return basePrisma.linkedStreamCustomItem.update({
            where,
            data: { deletedAt: new Date() },
          });
        },
        /**
         * Soft delete multiple LinkedStreamCustomItems by setting deletedAt
         */
        async softDeleteMany(where: Prisma.LinkedStreamCustomItemWhereInput) {
          return basePrisma.linkedStreamCustomItem.updateMany({
            where,
            data: { deletedAt: new Date() },
          });
        },
      },
      template: {
        /**
         * Soft delete a single Template by setting deletedAt
         */
        async softDelete(where: Prisma.TemplateWhereUniqueInput) {
          return basePrisma.template.update({
            where,
            data: { deletedAt: new Date() },
          });
        },
        /**
         * Soft delete multiple Templates by setting deletedAt
         */
        async softDeleteMany(where: Prisma.TemplateWhereInput) {
          return basePrisma.template.updateMany({
            where,
            data: { deletedAt: new Date() },
          });
        },
      },
      linkedStreamTemplate: {
        /**
         * Soft delete a single LinkedStreamTemplate by setting deletedAt
         */
        async softDelete(where: Prisma.LinkedStreamTemplateWhereUniqueInput) {
          return basePrisma.linkedStreamTemplate.update({
            where,
            data: { deletedAt: new Date() },
          });
        },
        /**
         * Soft delete multiple LinkedStreamTemplates by setting deletedAt
         */
        async softDeleteMany(where: Prisma.LinkedStreamTemplateWhereInput) {
          return basePrisma.linkedStreamTemplate.updateMany({
            where,
            data: { deletedAt: new Date() },
          });
        },
      },
    },
  });

// For global singleton in development
const globalForPrisma = globalThis as unknown as {
  prisma: typeof prisma | undefined;
};

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type ExtendedPrismaClient = typeof prisma;
