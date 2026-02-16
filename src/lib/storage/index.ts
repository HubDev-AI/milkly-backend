import { S3StorageAdapter } from "./s3";
import type { StorageAdapter } from "./types";
import { prisma } from "../../prisma";
import { env } from "../../env";
import { logWarn, logError } from "../debug";

export type { StorageAdapter, StorageConfig } from "./types";
export { S3StorageAdapter } from "./s3";

const MEDIA_URL_EXPIRY = 3600; // 1 hour for media references

let storageInstance: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (!storageInstance) {
    const bucket = env.S3_BUCKET;
    const region = env.S3_REGION;
    const accessKeyId = env.S3_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY;

    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "S3 storage not configured. Please set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.",
      );
    }

    storageInstance = new S3StorageAdapter({
      bucket,
      region,
      endpoint: env.S3_ENDPOINT,
      accessKeyId,
      secretAccessKey,
      publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    });
  }

  return storageInstance;
}

export function isStorageConfigured(): boolean {
  return !!(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
}

/**
 * Resolve media:// URLs to fresh signed URLs
 * Returns the URL unchanged if not a media reference
 */
export async function resolveMediaUrl(
  url: string | null,
): Promise<string | null> {
  if (!url) return null;

  // Check if it's a media reference
  if (!url.startsWith("media://")) return url;

  // Extract media file ID
  const mediaId = url.slice(8); // Remove "media://" prefix

  if (!mediaId) {
    logWarn("resolveMediaUrl", "Empty media ID in URL:", url);
    return null;
  }

  if (!isStorageConfigured()) {
    logWarn("resolveMediaUrl", "Storage not configured, cannot resolve:", url);
    return null;
  }

  try {
    const mediaFile = await prisma.mediaFile.findUnique({
      where: { id: mediaId },
      select: { key: true },
    });

    if (!mediaFile) {
      logWarn("resolveMediaUrl", "Media file not found for ID:", mediaId);
      return null;
    }

    const storage = getStorage();
    const signedUrl = await storage.getSignedUrl(
      mediaFile.key,
      MEDIA_URL_EXPIRY,
    );
    return signedUrl;
  } catch (error) {
    logError("resolveMediaUrl", "Error resolving media URL:", error);
    return null;
  }
}

/**
 * Copy a media file to the public/ prefix and return a permanent public URL.
 * Reuses existing publicKey if already copied.
 */
export async function makeMediaPublic(mediaId: string): Promise<string | null> {
  if (!isStorageConfigured()) return null;

  try {
    const mediaFile = await prisma.mediaFile.findUnique({
      where: { id: mediaId },
      select: { key: true, publicKey: true },
    });
    if (!mediaFile) return null;

    const storage = getStorage();

    if (mediaFile.publicKey) {
      return storage.getPublicUrl(mediaFile.publicKey);
    }

    const publicKey = `public/${mediaFile.key}`;
    await storage.copy(mediaFile.key, publicKey);

    await prisma.mediaFile.update({
      where: { id: mediaId },
      data: { publicKey },
    });

    return storage.getPublicUrl(publicKey);
  } catch (error) {
    logError("makeMediaPublic", "Error making media public:", error);
    return null;
  }
}

/**
 * Resolve a media:// URL to a permanent public URL (copies to public/ prefix).
 * For non-media URLs, returns the URL unchanged.
 */
export async function resolveMediaUrlPublic(
  url: string | null,
): Promise<string | null> {
  if (!url) return null;
  if (!url.startsWith("media://")) return url;
  const mediaId = url.slice(8);
  if (!mediaId || !isStorageConfigured()) return null;
  return makeMediaPublic(mediaId);
}
