import {
  parseMetadata,
  parseCategories,
  NewslettersPaginationQuerySchema,
  type Newsletter,
  type NewsletterWithItems,
  type NewsletterItemWithContent,
  type ContentItem,
  type Category,
} from "../../types";

// Re-export types for convenience
export type {
  Newsletter,
  NewsletterWithItems,
  NewsletterItemWithContent,
  ContentItem,
  Category,
};
export { parseCategories };

// Transform DB newsletter to API newsletter
export function transformNewsletter(dbNewsletter: {
  id: string;
  title: string;
  content: string;
  status: string;
  userId: string;
  streamId: string | null;
  templateId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  streamName?: string | null;
}): Newsletter & { streamName?: string | null } {
  return {
    id: dbNewsletter.id,
    title: dbNewsletter.title,
    content: dbNewsletter.content,
    status: dbNewsletter.status as "draft" | "published",
    userId: dbNewsletter.userId,
    streamId: dbNewsletter.streamId ?? "",
    templateId: dbNewsletter.templateId,
    publishedAt: dbNewsletter.publishedAt,
    createdAt: dbNewsletter.createdAt,
    updatedAt: dbNewsletter.updatedAt,
    streamName: dbNewsletter.streamName,
  };
}

// Transform DB content item to API content item
export function transformContentItem(dbItem: {
  id: string;
  title: string;
  url: string;
  description: string | null;
  imageUrl: string | null;
  source: string;
  category: string;
  author: string | null;
  publishedAt: Date | null;
  metadata: string | null;
  streamId: string;
  createdAt: Date;
  batchId?: string | null;
  fetchedAt?: Date;
  isCustomItem?: boolean;
}): ContentItem {
  return {
    id: dbItem.id,
    title: dbItem.title,
    url: dbItem.url,
    description: dbItem.description,
    imageUrl: dbItem.imageUrl,
    rawImageUrl: dbItem.imageUrl,
    source: dbItem.source,
    category: dbItem.category as Category,
    author: dbItem.author,
    publishedAt: dbItem.publishedAt,
    metadata: parseMetadata(dbItem.metadata),
    streamId: dbItem.streamId,
    createdAt: dbItem.createdAt,
    batchId: dbItem.batchId ?? null,
    fetchedAt: dbItem.fetchedAt ?? dbItem.createdAt,
    isCustomItem: dbItem.isCustomItem ?? false,
  };
}

// Transform newsletter with items
export function transformNewsletterWithItems(dbNewsletter: {
  id: string;
  title: string;
  content: string;
  status: string;
  userId: string;
  streamId: string | null;
  templateId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  streamName?: string | null;
  items: Array<{
    id: string;
    contentItemId: string | null;
    note: string | null;
    order: number;
    contentItem: {
      id: string;
      title: string;
      url: string;
      description: string | null;
      imageUrl: string | null;
      source: string;
      category: string;
      author: string | null;
      publishedAt: Date | null;
      metadata: string | null;
      streamId: string;
      createdAt: Date;
      batchId?: string | null;
      fetchedAt?: Date;
    } | null;
  }>;
}): NewsletterWithItems {
  return {
    ...transformNewsletter(dbNewsletter),
    items: dbNewsletter.items.map(
      (item): NewsletterItemWithContent => ({
        id: item.id,
        contentItemId: item.contentItemId,
        note: item.note,
        order: item.order,
        contentItem: item.contentItem
          ? transformContentItem(item.contentItem)
          : null,
      }),
    ),
  };
}

// Re-export pagination schema from types
export { NewslettersPaginationQuerySchema };
