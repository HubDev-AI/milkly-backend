import { parseMetadata, type ContentItem, type Category } from "../types";

/**
 * Transform DB content item to API content item.
 * Works for both regular stream content items and linked stream content items.
 */
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
  isEdited?: boolean;
}): ContentItem {
  return {
    id: dbItem.id,
    title: dbItem.title,
    url: dbItem.url,
    description: dbItem.description,
    imageUrl: dbItem.imageUrl,
    rawImageUrl: dbItem.imageUrl, // Keep original for editing (media:// refs)
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
    isEdited: dbItem.isEdited ?? false,
  };
}
