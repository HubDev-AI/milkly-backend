import { z } from "zod";

// ============ Stream Type ============

export const StreamTypeSchema = z.enum([
  "stream",
  "linkedStream",
  "all",
  "global",
]);
export type StreamType = z.infer<typeof StreamTypeSchema>;

// Stream type for specific stream (excludes "all")
export const SpecificStreamTypeSchema = z.enum(["stream", "linkedStream"]);
export type SpecificStreamType = z.infer<typeof SpecificStreamTypeSchema>;

// ============ Sort Options ============

export const SortOptionSchema = z.enum(["date", "relevancy", "popularity"]);
export type SortOption = z.infer<typeof SortOptionSchema>;

// ============ Newsletter Type ============

export const NewsletterTypeSchema = z.enum([
  "tech",
  "digest",
  "brand",
  "b2b",
  "personal",
  "educational",
]);
export type NewsletterType = z.infer<typeof NewsletterTypeSchema>;

// ============ Category Types ============

// Categories are now dynamic and stored in the database
// Use z.string() for validation, actual values come from Category table
export const CategorySchema = z.string().min(1);
export type Category = z.infer<typeof CategorySchema>;

// Database Category model
export const CategoryModelSchema = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  isSystem: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CategoryModel = z.infer<typeof CategoryModelSchema>;

// ============ Batch Tracking Types ============

// For single streams: each category maps to a single batch ID
export const StreamBatchIdsByCategorySchema = z.record(z.string(), z.string());
export type StreamBatchIdsByCategory = z.infer<
  typeof StreamBatchIdsByCategorySchema
>;

// For linked streams: each category maps to an array of batch IDs (one per stream)
export const LinkedStreamBatchIdsByCategorySchema = z.record(
  z.string(),
  z.array(z.string()),
);
export type LinkedStreamBatchIdsByCategory = z.infer<
  typeof LinkedStreamBatchIdsByCategorySchema
>;

// Helper to safely parse stream batch IDs from JSON string
export function parseStreamBatchIds(
  json: string | null,
): StreamBatchIdsByCategory {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return StreamBatchIdsByCategorySchema.parse(parsed);
  } catch {
    return {};
  }
}

// Helper to safely parse linked stream batch IDs from JSON string
export function parseLinkedStreamBatchIds(
  json: string | null,
): LinkedStreamBatchIdsByCategory {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    // Handle legacy format where it might be a single batch ID instead of array
    const normalized: LinkedStreamBatchIdsByCategory = {};
    for (const [category, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        normalized[category] = value;
      } else if (typeof value === "string") {
        // Convert legacy single batch ID to array
        normalized[category] = [value];
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

// ============ Stream Types ============

export const StreamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  categories: z.array(CategorySchema),
  keywords: z.array(z.string()),
  sortPreference: SortOptionSchema,
  userId: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Stream = z.infer<typeof StreamSchema>;

export const CreateStreamSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional(),
    categories: z
      .array(CategorySchema)
      .min(1, "At least one category is required"),
    keywords: z.array(z.string()).default([]),
    sortPreference: SortOptionSchema.optional(),
  })
  .refine(
    (data) => {
      // Keywords required unless it's a custom-only stream
      const isCustomOnly =
        data.categories.length === 1 && data.categories[0] === "custom";
      return isCustomOnly || data.keywords.length > 0;
    },
    {
      message: "At least one keyword is required for non-custom streams",
      path: ["keywords"],
    },
  );
export type CreateStreamInput = z.infer<typeof CreateStreamSchema>;

export const UpdateStreamSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  categories: z.array(CategorySchema).min(1).optional(),
  keywords: z.array(z.string()).optional(),
  sortPreference: SortOptionSchema.optional(),
});
export type UpdateStreamInput = z.infer<typeof UpdateStreamSchema>;

// Schema for generating keywords with AI
export const GenerateKeywordsSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type GenerateKeywordsInput = z.infer<typeof GenerateKeywordsSchema>;

// ============ Content Item Types ============

export const ContentItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  rawImageUrl: z.string().nullable().optional(), // Original value (media:// or URL) for editing
  source: z.string(),
  category: CategorySchema,
  author: z.string().nullable(),
  publishedAt: z.coerce.date().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  streamId: z.string(),
  createdAt: z.coerce.date(),
  batchId: z.string().nullable(),
  fetchedAt: z.coerce.date(),
  isCustomItem: z.boolean(),
  isEdited: z.boolean().optional(), // true if user edited this API-fetched item
});
export type ContentItem = z.infer<typeof ContentItemSchema>;

export const CreateContentItemSchema = z.object({
  title: z.string().min(1, "Title is required"),
  url: z.string().url("Must be a valid URL").optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(), // Accepts URLs or media:// references
  category: CategorySchema,
  author: z.string().optional(),
  customCategoryName: z.string().optional(), // Custom label for the category in newsletters
});
export type CreateContentItemInput = z.infer<typeof CreateContentItemSchema>;

export const BulkDeleteItemsSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(50),
});
export type BulkDeleteItemsInput = z.infer<typeof BulkDeleteItemsSchema>;

// ============ Template Types ============

export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  mklySource: z.string(),
  logoUrl: z.string().nullable().optional(),
  streamId: z.string().nullable(),
  linkedStreamId: z.string().optional(),
  userId: z.string().nullable(),
  isGlobal: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Template = z.infer<typeof TemplateSchema>;

// Template customization options for AI generation
export const TemplateCustomizationSchema = z.object({
  // Brand identity
  brandName: z.string().optional(), // Newsletter brand name (e.g., "Tech Weekly")
  tagline: z.string().optional(), // Short tagline (e.g., "Your weekly dose of tech news")
  description: z.string().optional(), // What the newsletter is about

  // Visual customization
  logoUrl: z.string().optional(), // Brand logo URL
  primaryColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(), // Primary brand color
  accentColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(), // Accent color

  // Tone and style
  tone: z
    .enum(["professional", "casual", "playful", "formal", "friendly"])
    .optional(),
  audience: z.string().optional(), // Target audience description (e.g., "Tech enthusiasts")

  // Newsletter type
  newsletterType: NewsletterTypeSchema.optional(),

  // Content preferences
  includeFooterCTA: z.boolean().optional(), // Include call-to-action in footer
  footerCTAText: z.string().optional(), // Custom CTA text

  // Custom user prompt for AI
  customPrompt: z.string().optional(), // Additional instructions for AI
});
export type TemplateCustomization = z.infer<typeof TemplateCustomizationSchema>;

export const CreateTemplateSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  generateWithAI: z.boolean().optional().default(true),
  customization: TemplateCustomizationSchema.optional(), // Add customization options
  newsletterType: NewsletterTypeSchema.optional(), // Top-level newsletter type for convenience
  setActive: z.boolean().optional().default(false), // If true, deactivate others and set this as active
});
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;

export const UpdateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  mklySource: z.string().optional(),
  logoUrl: z.string().nullable().optional(),
});
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;

// Schema for creating global templates (not tied to a stream)
export const CreateGlobalTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  generateWithAI: z.boolean().optional().default(true),
  customization: TemplateCustomizationSchema.optional(),
  newsletterType: NewsletterTypeSchema.optional(),
});
export type CreateGlobalTemplateInput = z.infer<
  typeof CreateGlobalTemplateSchema
>;

// Schema for activating a template (works for both stream and linked stream templates)
export const ActivateTemplateSchema = z.object({
  streamType: z.enum(["stream", "linkedStream"]),
});
export type ActivateTemplateInput = z.infer<typeof ActivateTemplateSchema>;

// Query schema for deleting a template (to identify template type)
export const DeleteTemplateQuerySchema = z.object({
  streamType: z.enum(["stream", "linkedStream"]),
});
export type DeleteTemplateQuery = z.infer<typeof DeleteTemplateQuerySchema>;

// Schema for duplicating a template
export const DuplicateTemplateSchema = z.object({
  streamType: z.enum(["stream", "linkedStream"]),
  name: z.string().min(1).optional(),
});
export type DuplicateTemplateInput = z.infer<typeof DuplicateTemplateSchema>;

// Schema for applying a global template to a stream
export const ApplyTemplateSchema = z.object({
  streamType: z.enum(["stream", "linkedStream"]),
  streamId: z.string(),
  setActive: z.boolean().optional().default(false),
});
export type ApplyTemplateInput = z.infer<typeof ApplyTemplateSchema>;

// Helper to properly parse boolean query params (z.coerce.boolean() treats "false" as true)
const booleanQueryParam = z.preprocess(
  (val) => (val === undefined || val === "" ? undefined : val === "true"),
  z.boolean().optional(),
);

// Query schema for GET /api/templates (all templates across streams)
export const AllTemplatesQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(50).optional().default(20),
  streamType: StreamTypeSchema.optional().default("all"),
  isActive: booleanQueryParam,
  search: z.string().optional(),
  isGlobal: booleanQueryParam,
});
export type AllTemplatesQuery = z.infer<typeof AllTemplatesQuerySchema>;

// Response schema for templates with stream context
// For global templates, streamId and streamName are null
export const TemplateWithStreamSchema = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  mklySource: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  streamType: StreamTypeSchema.exclude(["all"]),
  streamId: z.string().nullable(),
  streamName: z.string().nullable(),
});
export type TemplateWithStream = z.infer<typeof TemplateWithStreamSchema>;

// ============ Newsletter Item Types ============

export const NewsletterItemSchema = z.object({
  id: z.string(),
  contentItemId: z.string().nullable(),
  note: z.string().nullable(),
  order: z.number(),
});
export type NewsletterItem = z.infer<typeof NewsletterItemSchema>;

export const NewsletterItemWithContentSchema = NewsletterItemSchema.extend({
  contentItem: ContentItemSchema.nullable(),
});
export type NewsletterItemWithContent = z.infer<
  typeof NewsletterItemWithContentSchema
>;

// ============ Newsletter Types ============

export const NewsletterStatusSchema = z.enum(["draft", "published"]);
export type NewsletterStatus = z.infer<typeof NewsletterStatusSchema>;

export const NewsletterSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  blocksJson: z.unknown().nullable().optional(), // JSON array of BlockNote blocks
  status: NewsletterStatusSchema,
  userId: z.string(),
  streamId: z.string(),
  templateId: z.string().nullable(),
  publishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Newsletter = z.infer<typeof NewsletterSchema>;

export const NewsletterWithItemsSchema = NewsletterSchema.extend({
  items: z.array(NewsletterItemWithContentSchema),
});
export type NewsletterWithItems = z.infer<typeof NewsletterWithItemsSchema>;

export const CreateNewsletterItemSchema = z.object({
  contentItemId: z.string(),
  note: z.string().optional(),
  order: z.number().optional(),
});
export type CreateNewsletterItemInput = z.infer<
  typeof CreateNewsletterItemSchema
>;

export const CreateNewsletterSchema = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.string().optional().default(""),
  templateId: z.string().optional(),
  items: z.array(CreateNewsletterItemSchema).optional().default([]),
});
export type CreateNewsletterInput = z.infer<typeof CreateNewsletterSchema>;

export const UpdateNewsletterSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  blocksJson: z.unknown().optional(), // JSON array of BlockNote blocks
  templateId: z.string().nullable().optional(),
  items: z.array(CreateNewsletterItemSchema).optional(),
});
export type UpdateNewsletterInput = z.infer<typeof UpdateNewsletterSchema>;

// Schema for preview generation (without saving)
export const GeneratePreviewSchema = z
  .object({
    streamId: z.string().optional(),
    linkedStreamId: z.string().optional(),
    templateId: z.string().optional(),
    contentItemIds: z
      .array(z.string())
      .min(1, "At least one content item is required"),
    itemNotes: z.record(z.string(), z.string()).optional(), // Map of itemId -> note
    title: z.string().optional(), // Newsletter title for the preview
  })
  .refine((data) => data.streamId || data.linkedStreamId, {
    message: "Either streamId or linkedStreamId is required",
  });
export type GeneratePreviewInput = z.infer<typeof GeneratePreviewSchema>;

// Schema for generating notes from content items (no newsletter required)
export const GenerateNotesFromItemsSchema = z
  .object({
    streamId: z.string().optional(),
    linkedStreamId: z.string().optional(),
    contentItemIds: z
      .array(z.string())
      .min(1, "At least one content item is required"),
  })
  .refine((data) => data.streamId || data.linkedStreamId, {
    message: "Either streamId or linkedStreamId is required",
  });
export type GenerateNotesFromItemsInput = z.infer<
  typeof GenerateNotesFromItemsSchema
>;

// Response type for generated notes
export const GeneratedNoteSchema = z.object({
  itemId: z.string(),
  note: z.string(),
});
export type GeneratedNote = z.infer<typeof GeneratedNoteSchema>;

// ============ Available Categories Response ============

export const TierNameSchema = z.enum(["essential", "professional", "mastery"]);
export type TierName = z.infer<typeof TierNameSchema>;

export const AvailableCategoriesResponseSchema = z.object({
  allowedCategories: z.array(CategorySchema),
  allCategories: z.array(CategorySchema),
  tier: TierNameSchema,
});
export type AvailableCategoriesResponse = z.infer<
  typeof AvailableCategoriesResponseSchema
>;

// ============ API Response Types ============

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// Response envelope types (for reference - actual responses use { data: T })
export type ApiResponse<T> = { data: T };
export type ApiErrorResponse = ApiError;

// ============ Page-based Pagination Types ============

export const PaginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

// Page-based paginated response type
export type PagedResponse<T> = {
  data: T[];
  pagination: PaginationMeta;
};

// Helper to create pagination query schema with custom defaults and max
// Uses transform to clamp the limit instead of failing validation
export function createPaginationQuerySchema(
  defaultLimit: number,
  maxLimit: number,
) {
  return z.object({
    page: z.coerce.number().min(1).optional().default(1),
    limit: z.coerce
      .number()
      .min(1)
      .optional()
      .default(defaultLimit)
      .transform((val) => Math.min(val, maxLimit)),
  });
}

// Helper to calculate pagination metadata
export function calculatePagination(
  page: number,
  limit: number,
  total: number,
): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

// Pagination schema for linked streams list (default: 20, max: 50)
export const LinkedStreamsPaginationQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(50).optional().default(20),
});
export type LinkedStreamsPaginationQuery = z.infer<
  typeof LinkedStreamsPaginationQuerySchema
>;

// Pagination schema for newsletters list (default: 10, max: 50)
export const NewslettersPaginationQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(50).optional().default(10),
  status: NewsletterStatusSchema.optional(),
});
export type NewslettersPaginationQuery = z.infer<
  typeof NewslettersPaginationQuerySchema
>;

// Pagination schema for templates list (default: 10, max: 20)
export const TemplatesPaginationQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(20).optional().default(10),
});
export type TemplatesPaginationQuery = z.infer<
  typeof TemplatesPaginationQuerySchema
>;

// ============ Feed Types ============

export const FeedQuerySchema = z.object({
  category: CategorySchema.optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
  lastMilkOnly: z.coerce.boolean().optional().default(false),
  since: z.coerce.date().optional(),
  batchId: z.string().optional(),
});
export type FeedQuery = z.infer<typeof FeedQuerySchema>;

// Paginated response type for lists
export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
    latestBatchId: z.string().nullable(),
  });

export type PaginatedResponse<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  latestBatchId: string | null;
};

// ============ Helper Functions ============

// Parse JSON categories string from DB to array
export function parseCategories(categoriesJson: string): Category[] {
  try {
    const parsed = JSON.parse(categoriesJson);
    return CategorySchema.array().parse(parsed);
  } catch {
    return [];
  }
}

// Parse JSON keywords string from DB to array
export function parseKeywords(keywordsJson: string | null): string[] {
  if (!keywordsJson) return [];
  try {
    const parsed = JSON.parse(keywordsJson);
    return z.array(z.string()).parse(parsed);
  } catch {
    return [];
  }
}

// Parse JSON metadata string from DB to object
export function parseMetadata(
  metadataJson: string | null,
): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    return JSON.parse(metadataJson);
  } catch {
    return null;
  }
}

// ============ Linked Stream Types ============

export const LinkedStreamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  userId: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  lastMilkedAt: z.coerce.date().nullable(),
});
export type LinkedStream = z.infer<typeof LinkedStreamSchema>;

export const LinkedStreamWithMembersSchema = LinkedStreamSchema.extend({
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      categories: z.string(), // JSON string from DB
      order: z.number(),
    }),
  ),
});
export type LinkedStreamWithMembers = z.infer<
  typeof LinkedStreamWithMembersSchema
>;

export const CreateLinkedStreamSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  streamIds: z.array(z.string()).min(2, "At least 2 streams are required"),
});
export type CreateLinkedStreamInput = z.infer<typeof CreateLinkedStreamSchema>;

export const UpdateLinkedStreamSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  streamIds: z.array(z.string()).min(2).optional(),
});
export type UpdateLinkedStreamInput = z.infer<typeof UpdateLinkedStreamSchema>;

// ============ Linked Stream Template Types ============

export const LinkedStreamTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  mklySource: z.string(),
  linkedStreamId: z.string(),
  isActive: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type LinkedStreamTemplate = z.infer<typeof LinkedStreamTemplateSchema>;

// ============ Linked Stream Custom Item Types ============

export const LinkedStreamCustomItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  source: z.string(),
  category: z.string(),
  author: z.string().nullable(),
  publishedAt: z.coerce.date().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  linkedStreamId: z.string(),
  createdAt: z.coerce.date(),
  fetchedAt: z.coerce.date(),
});
export type LinkedStreamCustomItem = z.infer<
  typeof LinkedStreamCustomItemSchema
>;

export const CreateLinkedStreamCustomItemSchema = z.object({
  title: z.string().min(1, "Title is required"),
  url: z.string().url("Must be a valid URL").optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(), // Accepts URLs or media:// references
  category: z.string().optional().default("custom"),
  author: z.string().optional(),
});
export type CreateLinkedStreamCustomItemInput = z.infer<
  typeof CreateLinkedStreamCustomItemSchema
>;

export const UpdateLinkedStreamCustomItemSchema = z.object({
  title: z.string().min(1, "Title is required").optional(),
  url: z.string().url("Must be a valid URL").optional().nullable(),
  description: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(), // Accepts URLs or media:// references
  category: z.string().optional(),
  author: z.string().optional().nullable(),
});
export type UpdateLinkedStreamCustomItemInput = z.infer<
  typeof UpdateLinkedStreamCustomItemSchema
>;

// ============ Linked Stream Feed Types ============

// Feed item that can come from either a stream's ContentItem or LinkedStreamCustomItem
export const LinkedStreamFeedItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  rawImageUrl: z.string().nullable().optional(), // Original value (media:// or URL) for editing
  source: z.string(),
  category: z.string(),
  author: z.string().nullable(),
  publishedAt: z.coerce.date().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.coerce.date(),
  batchId: z.string().nullable(),
  fetchedAt: z.coerce.date(),
  // Source identification
  streamId: z.string().nullable(), // null for linked stream custom items
  streamName: z.string().nullable(), // null for linked stream custom items
  isLinkedStreamCustomItem: z.boolean(), // true if from LinkedStreamCustomItem table
  isCustomItem: z.boolean(), // true for any custom item (linked stream or stream custom)
  isEdited: z.boolean().optional(), // true if user edited this item
});
export type LinkedStreamFeedItem = z.infer<typeof LinkedStreamFeedItemSchema>;

export const LinkedStreamFeedQuerySchema = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(25),
  offset: z.coerce.number().min(0).optional().default(0),
  lastMilkOnly: z.coerce.boolean().optional().default(false),
  search: z.string().optional(),
});
export type LinkedStreamFeedQuery = z.infer<typeof LinkedStreamFeedQuerySchema>;

// ============ Linked Newsletter Types ============

export const LinkedNewsletterSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  status: NewsletterStatusSchema,
  linkedStreamId: z.string(),
  linkedStreamName: z.string().nullable(),
  templateId: z.string().nullable(),
  publishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type LinkedNewsletter = z.infer<typeof LinkedNewsletterSchema>;

export const LinkedNewsletterItemSchema = z.object({
  id: z.string(),
  contentItemId: z.string().nullable(),
  linkedStreamCustomItemId: z.string().nullable(),
  sourceStreamId: z.string().nullable(),
  note: z.string().nullable(),
  order: z.number(),
  // Preserved fields
  preservedTitle: z.string().nullable(),
  preservedUrl: z.string().nullable(),
  preservedDescription: z.string().nullable(),
  preservedImageUrl: z.string().nullable(),
  preservedSource: z.string().nullable(),
  preservedCategory: z.string().nullable(),
});
export type LinkedNewsletterItem = z.infer<typeof LinkedNewsletterItemSchema>;

export const CreateLinkedNewsletterItemSchema = z
  .object({
    contentItemId: z.string().optional(),
    linkedStreamCustomItemId: z.string().optional(),
    sourceStreamId: z.string().optional(),
    note: z.string().optional(),
    order: z.number().optional(),
  })
  .refine((data) => data.contentItemId || data.linkedStreamCustomItemId, {
    message: "Either contentItemId or linkedStreamCustomItemId is required",
  });
export type CreateLinkedNewsletterItemInput = z.infer<
  typeof CreateLinkedNewsletterItemSchema
>;

export const CreateLinkedNewsletterSchema = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.string().optional().default(""),
  templateId: z.string().optional(),
  items: z.array(CreateLinkedNewsletterItemSchema).optional().default([]),
});
export type CreateLinkedNewsletterInput = z.infer<
  typeof CreateLinkedNewsletterSchema
>;

export const UpdateLinkedNewsletterSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  templateId: z.string().nullable().optional(),
  items: z.array(CreateLinkedNewsletterItemSchema).optional(),
});
export type UpdateLinkedNewsletterInput = z.infer<
  typeof UpdateLinkedNewsletterSchema
>;

// With populated items
export const LinkedNewsletterItemWithContentSchema =
  LinkedNewsletterItemSchema.extend({
    contentItem: ContentItemSchema.nullable(),
    isLinkedStreamCustomItem: z.boolean().optional(),
  });
export type LinkedNewsletterItemWithContent = z.infer<
  typeof LinkedNewsletterItemWithContentSchema
>;

export const LinkedNewsletterWithItemsSchema = LinkedNewsletterSchema.extend({
  items: z.array(LinkedNewsletterItemWithContentSchema),
});
export type LinkedNewsletterWithItems = z.infer<
  typeof LinkedNewsletterWithItemsSchema
>;

// ============ Refresh Response Types ============

export const RefreshResultSchema = z.object({
  streamId: z.string(),
  streamName: z.string(),
  refreshed: z.number(),
  batchId: z.string(),
  error: z.string().optional(),
});
export type RefreshResult = z.infer<typeof RefreshResultSchema>;

export const LinkedStreamRefreshResponseSchema = z.object({
  refreshed: z.number(),
  streamsRefreshed: z.number(),
  streamsFailed: z.number(),
  errors: z.array(z.string()).optional(),
  results: z.array(RefreshResultSchema),
});
export type LinkedStreamRefreshResponse = z.infer<
  typeof LinkedStreamRefreshResponseSchema
>;

// ============ Media Library Types ============

export const MediaFileSchema = z.object({
  id: z.string(),
  userId: z.string(),
  filename: z.string(),
  key: z.string(),
  publicKey: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  isLogo: z.boolean(),
  tags: z.array(z.string()),
  extractedColors: z.array(z.string()),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type MediaFile = z.infer<typeof MediaFileSchema>;

export const MediaFileWithUrlSchema = MediaFileSchema.extend({
  url: z.string(),
});
export type MediaFileWithUrl = z.infer<typeof MediaFileWithUrlSchema>;

export const UpdateMediaFileSchema = z.object({
  filename: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  isLogo: z.boolean().optional(),
});
export type UpdateMediaFileInput = z.infer<typeof UpdateMediaFileSchema>;

export const MediaListQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  tags: z.string().optional(),
  search: z.string().optional(),
});
export type MediaListQuery = z.infer<typeof MediaListQuerySchema>;

export const MediaUsageSchema = z.object({
  usedBytes: z.number(),
  maxBytes: z.number(),
  fileCount: z.number(),
  percentage: z.number(),
});
export type MediaUsage = z.infer<typeof MediaUsageSchema>;

export const ImageEditOptionsSchema = z.object({
  crop: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  resize: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional(),
    })
    .optional(),
  rotate: z.number().optional(),
  flip: z.boolean().optional(),
  flop: z.boolean().optional(),
  grayscale: z.boolean().optional(),
  blur: z.number().optional(),
  sharpen: z.boolean().optional(),
  format: z.enum(["jpeg", "png", "webp"]).optional(),
  quality: z.number().min(1).max(100).optional(),
});
export type ImageEditOptions = z.infer<typeof ImageEditOptionsSchema>;

export function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson);
    return z.array(z.string()).parse(parsed);
  } catch {
    return [];
  }
}

export function parseExtractedColors(colorsJson: string | null): string[] {
  if (!colorsJson) return [];
  try {
    const parsed = JSON.parse(colorsJson);
    return z.array(z.string()).parse(parsed);
  } catch {
    return [];
  }
}

// ============ Limit Error Types ============

export const LimitTypeSchema = z.enum([
  "aiCredits",
  "refreshes",
  "maxStreams",
  "maxEmailSubscribers",
  "maxStorageMB",
  "linkedStreams",
  "allowCustomItems",
  "allowedCategories",
  "generatesPerWeek",
  "maxNewsletterItems",
]);
export type LimitType = z.infer<typeof LimitTypeSchema>;

// ============ AI Operation Types ============

export const AIOperationTypeSchema = z.enum([
  "aiGenerateFull",
  "previewGeneration",
  "templateGeneration",
  "contentRegeneration",
  "templatePreview",
  "notesGeneration",
  "blockRegeneration",
  "keywordGeneration",
]);
export type AIOperationType = z.infer<typeof AIOperationTypeSchema>;

export const LimitErrorSchema = z.object({
  code: z.enum(["LIMIT_EXCEEDED", "FEATURE_LOCKED", "TIER_RESTRICTION"]),
  message: z.string(),
  limit: LimitTypeSchema,
  current: z.number().optional(),
  max: z.number().optional(),
  cost: z.number().optional(),
  resetAt: z.string().optional(),
  upgradeUrl: z.string().optional(),
});
export type LimitError = z.infer<typeof LimitErrorSchema>;

// ============ Usage Response Types ============

export const UsageResponseSchema = z.object({
  aiCredits: z.object({
    used: z.number(),
    limit: z.number(), // -1 for unlimited
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  refreshes: z.object({
    used: z.number(),
    limit: z.number(), // -1 for unlimited
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  tier: z.enum(["essential", "professional", "mastery"]),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

// ============ Template Preview Types ============

export const TemplatePreviewSchema = z.object({
  mklySource: z.string(),
  logoUrl: z.string().optional(),
  streamId: z.string().optional(),
  linkedStreamId: z.string().optional(),
});
export type TemplatePreviewInput = z.infer<typeof TemplatePreviewSchema>;

export const TemplatePreviewResponseSchema = z.object({
  html: z.string(),
  generatedAt: z.coerce.date(),
});
export type TemplatePreviewResponse = z.infer<
  typeof TemplatePreviewResponseSchema
>;
