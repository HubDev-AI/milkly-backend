import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import {
  MediaListQuerySchema,
  UpdateMediaFileSchema,
  ImageEditOptionsSchema,
  parseTags,
  parseExtractedColors,
  calculatePagination,
  type MediaFile,
  type MediaFileWithUrl,
  type MediaUsage,
} from "../types";
import { getStorage, isStorageConfigured } from "../lib/storage";
import { getTierLimits, isUnlimited } from "../config/tiers";
import { getUserTier } from "../middleware/tier-limits";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { logError } from "../lib/debug";

const mediaRouter = new Hono<{ Variables: AuthVariables }>();

const SIGNED_URL_EXPIRY = 3600; // 1 hour

const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

async function stripImageMetadata(
  buffer: Buffer,
  mimeType: string,
): Promise<Buffer> {
  // SVG doesn't need/support sharp processing
  if (mimeType === "image/svg+xml") {
    return buffer;
  }

  // Use sharp to strip all metadata (EXIF, GPS, etc.)
  // rotate() with no args auto-orients based on EXIF, preserving correct orientation
  const image = sharp(buffer).rotate();

  // Get format from mime type and re-encode without metadata
  switch (mimeType) {
    case "image/png":
      return image.png().toBuffer();
    case "image/jpeg":
      return image.jpeg({ quality: 90 }).toBuffer();
    case "image/gif":
      // Sharp handles GIFs but converts to single frame - just return original for GIF
      return buffer;
    case "image/webp":
      return image.webp({ quality: 90 }).toBuffer();
    default:
      return buffer;
  }
}

function transformMediaFile(dbFile: {
  id: string;
  userId: string;
  filename: string;
  key: string;
  publicKey: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  isLogo: boolean;
  tags: string;
  extractedColors: string;
  createdAt: Date;
  updatedAt: Date;
}): MediaFile {
  return {
    id: dbFile.id,
    userId: dbFile.userId,
    filename: dbFile.filename,
    key: dbFile.key,
    publicKey: dbFile.publicKey,
    mimeType: dbFile.mimeType,
    sizeBytes: dbFile.sizeBytes,
    width: dbFile.width,
    height: dbFile.height,
    isLogo: dbFile.isLogo,
    tags: parseTags(dbFile.tags),
    extractedColors: parseExtractedColors(dbFile.extractedColors),
    createdAt: dbFile.createdAt,
    updatedAt: dbFile.updatedAt,
  };
}

async function transformMediaFileWithUrl(dbFile: {
  id: string;
  userId: string;
  filename: string;
  key: string;
  publicKey: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  isLogo: boolean;
  tags: string;
  extractedColors: string;
  createdAt: Date;
  updatedAt: Date;
}): Promise<MediaFileWithUrl> {
  let url = "";
  if (isStorageConfigured()) {
    const storage = getStorage();
    url = await storage.getSignedUrl(dbFile.key, SIGNED_URL_EXPIRY);
  }
  return {
    ...transformMediaFile(dbFile),
    url,
  };
}

async function getUserStorageUsage(
  userId: string,
): Promise<{ usedBytes: number; fileCount: number }> {
  const result = await prisma.mediaFile.aggregate({
    where: { userId },
    _sum: { sizeBytes: true },
    _count: true,
  });
  return {
    usedBytes: result._sum.sizeBytes || 0,
    fileCount: result._count,
  };
}

async function checkStorageQuota(
  userId: string,
  newFileSize: number,
): Promise<{ allowed: boolean; message?: string }> {
  const tier = await getUserTier(userId);
  const limits = getTierLimits(tier);

  if (isUnlimited(limits.maxStorageMB)) {
    return { allowed: true };
  }

  const maxBytes = limits.maxStorageMB * 1024 * 1024;
  const { usedBytes } = await getUserStorageUsage(userId);

  if (usedBytes + newFileSize > maxBytes) {
    const usedMB = (usedBytes / 1024 / 1024).toFixed(1);
    const maxMB = limits.maxStorageMB;
    return {
      allowed: false,
      message: `Storage limit exceeded. You are using ${usedMB}MB of ${maxMB}MB. Upgrade your plan for more storage.`,
    };
  }

  return { allowed: true };
}

function getImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  try {
    if (mimeType === "image/png") {
      if (buffer.length < 24) return null;
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }

    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
      return null;
    }

    if (mimeType === "image/gif") {
      if (buffer.length < 10) return null;
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height };
    }

    if (mimeType === "image/webp") {
      if (buffer.length < 30) return null;
      const riff = buffer.toString("ascii", 0, 4);
      const webp = buffer.toString("ascii", 8, 12);
      if (riff !== "RIFF" || webp !== "WEBP") return null;

      const vp8 = buffer.toString("ascii", 12, 16);
      if (vp8 === "VP8 ") {
        const width = buffer.readUInt16LE(26) & 0x3fff;
        const height = buffer.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
      if (vp8 === "VP8L") {
        const bits = buffer.readUInt32LE(21);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        return { width, height };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

// GET /api/media/status - check if storage is configured
mediaRouter.get("/status", requireAuth, async (c) => {
  return c.json({
    data: {
      configured: isStorageConfigured(),
    },
  });
});

// POST /api/media/upload - upload a file
mediaRouter.post("/upload", requireAuth, async (c) => {
  if (!isStorageConfigured()) {
    return c.json(
      {
        error: {
          message: "Storage not configured. Use external image URLs instead.",
          code: "STORAGE_NOT_CONFIGURED",
        },
      },
      503,
    );
  }

  const user = c.get("user")!;

  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return c.json(
        { error: { message: "No file provided", code: "NO_FILE" } },
        400,
      );
    }

    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return c.json(
        {
          error: {
            message: `File type not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`,
            code: "INVALID_FILE_TYPE",
          },
        },
        400,
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return c.json(
        {
          error: {
            message: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
            code: "FILE_TOO_LARGE",
          },
        },
        400,
      );
    }

    const quotaCheck = await checkStorageQuota(user.id, file.size);
    if (!quotaCheck.allowed) {
      return c.json(
        { error: { message: quotaCheck.message!, code: "QUOTA_EXCEEDED" } },
        400,
      );
    }

    const rawBuffer = Buffer.from(await file.arrayBuffer());

    // Strip metadata (EXIF, GPS, etc.) for privacy and auto-rotate based on EXIF
    const buffer = await stripImageMetadata(rawBuffer, file.type);

    // Get dimensions from processed buffer (correct after auto-rotation)
    let dimensions: { width: number; height: number } | null = null;
    if (file.type !== "image/svg+xml" && file.type !== "image/gif") {
      const meta = await sharp(buffer).metadata();
      if (meta.width && meta.height) {
        dimensions = { width: meta.width, height: meta.height };
      }
    } else {
      dimensions = getImageDimensions(buffer, file.type);
    }

    // Use UUID-only filename to prevent collisions and hide original names
    const uuid = randomUUID();
    const extension = MIME_TO_EXTENSION[file.type] || "bin";
    const key = `users/${user.id}/media/${uuid}.${extension}`;

    const storage = getStorage();
    await storage.upload(key, buffer, file.type);

    const mediaFile = await prisma.mediaFile.create({
      data: {
        userId: user.id,
        filename: file.name, // Keep original name for display purposes
        key,
        mimeType: file.type,
        sizeBytes: buffer.length, // Use processed buffer size
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        tags: "[]",
        extractedColors: "[]",
      },
    });

    const url = await storage.getSignedUrl(key, SIGNED_URL_EXPIRY);

    return c.json({
      data: {
        ...transformMediaFile(mediaFile),
        url,
      },
    });
  } catch (error) {
    logError("Media", "Upload error:", error);
    return c.json(
      { error: { message: "Upload failed", code: "UPLOAD_FAILED" } },
      500,
    );
  }
});

// GET /api/media - list user's files
mediaRouter.get(
  "/",
  requireAuth,
  zValidator("query", MediaListQuerySchema),
  async (c) => {
    const user = c.get("user")!;
    const { page, limit, tags, search } = c.req.valid("query");

    const where: any = { userId: user.id };

    // Search by original filename (stored in database)
    if (search?.trim()) {
      where.filename = { contains: search.trim() };
    }

    if (tags) {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (tagList.length > 0) {
        where.tags = { contains: tagList[0] };
      }
    }

    const [total, files] = await Promise.all([
      prisma.mediaFile.count({ where }),
      prisma.mediaFile.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const filesWithUrls = await Promise.all(
      files.map(transformMediaFileWithUrl),
    );

    return c.json({
      data: {
        files: filesWithUrls,
        pagination: calculatePagination(page, limit, total),
      },
    });
  },
);

// GET /api/media/usage - get storage usage stats
mediaRouter.get("/usage", requireAuth, async (c) => {
  const user = c.get("user")!;

  const tier = await getUserTier(user.id);
  const limits = getTierLimits(tier);
  const { usedBytes, fileCount } = await getUserStorageUsage(user.id);

  const maxBytes = isUnlimited(limits.maxStorageMB)
    ? -1
    : limits.maxStorageMB * 1024 * 1024;
  const percentage =
    maxBytes === -1 ? 0 : Math.round((usedBytes / maxBytes) * 100);

  const usage: MediaUsage = {
    usedBytes,
    maxBytes,
    fileCount,
    percentage,
  };

  return c.json({ data: usage });
});

// GET /api/media/logo - get user's current logo
mediaRouter.get("/logo", requireAuth, async (c) => {
  const user = c.get("user")!;

  const logo = await prisma.mediaFile.findFirst({
    where: { userId: user.id, isLogo: true },
    orderBy: { updatedAt: "desc" },
  });

  if (!logo) {
    return c.json({ data: null });
  }

  let url = "";
  if (isStorageConfigured()) {
    const storage = getStorage();
    url = await storage.getSignedUrl(logo.key, SIGNED_URL_EXPIRY);
  }

  return c.json({
    data: {
      id: logo.id,
      url,
      thumbnailUrl: null,
      brandColors: parseExtractedColors(logo.extractedColors),
    },
  });
});

// GET /api/media/:id - get file metadata with signed URL
mediaRouter.get("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const file = await prisma.mediaFile.findFirst({
    where: { id, userId: user.id },
  });

  if (!file) {
    return c.json(
      { error: { message: "File not found", code: "NOT_FOUND" } },
      404,
    );
  }

  return c.json({ data: await transformMediaFileWithUrl(file) });
});

// GET /api/media/:id/url - get fresh signed URL only
mediaRouter.get("/:id/url", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const file = await prisma.mediaFile.findFirst({
    where: { id, userId: user.id },
  });

  if (!file) {
    return c.json(
      { error: { message: "File not found", code: "NOT_FOUND" } },
      404,
    );
  }

  if (!isStorageConfigured()) {
    return c.json({ data: { url: "" } });
  }

  const storage = getStorage();
  const url = await storage.getSignedUrl(file.key, SIGNED_URL_EXPIRY);

  return c.json({ data: { url } });
});

// PATCH /api/media/:id - update file metadata
mediaRouter.patch(
  "/:id",
  requireAuth,
  zValidator("json", UpdateMediaFileSchema),
  async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const data = c.req.valid("json");

    const file = await prisma.mediaFile.findFirst({
      where: { id, userId: user.id },
    });

    if (!file) {
      return c.json(
        { error: { message: "File not found", code: "NOT_FOUND" } },
        404,
      );
    }

    const updateData: any = {};
    if (data.filename !== undefined) updateData.filename = data.filename;
    if (data.tags !== undefined) updateData.tags = JSON.stringify(data.tags);
    if (data.isLogo !== undefined) {
      updateData.isLogo = data.isLogo;
      if (data.isLogo) {
        await prisma.mediaFile.updateMany({
          where: { userId: user.id, isLogo: true, id: { not: id } },
          data: { isLogo: false },
        });
      }
    }

    const updated = await prisma.mediaFile.update({
      where: { id },
      data: updateData,
    });

    return c.json({ data: transformMediaFile(updated) });
  },
);

// DELETE /api/media/:id - delete file
mediaRouter.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const file = await prisma.mediaFile.findFirst({
    where: { id, userId: user.id },
  });

  if (!file) {
    return c.json(
      { error: { message: "File not found", code: "NOT_FOUND" } },
      404,
    );
  }

  if (isStorageConfigured()) {
    try {
      const storage = getStorage();
      await storage.delete(file.key);
      if (file.publicKey) {
        await storage.delete(file.publicKey);
      }
    } catch (error) {
      logError("Media", "Failed to delete from storage:", error);
    }
  }

  await prisma.mediaFile.delete({ where: { id } });

  return c.json({ data: { success: true } });
});

// POST /api/media/:id/set-logo - set file as user's logo
mediaRouter.post("/:id/set-logo", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const file = await prisma.mediaFile.findFirst({
    where: { id, userId: user.id },
  });

  if (!file) {
    return c.json(
      { error: { message: "File not found", code: "NOT_FOUND" } },
      404,
    );
  }

  await prisma.mediaFile.updateMany({
    where: { userId: user.id, isLogo: true },
    data: { isLogo: false },
  });

  const updated = await prisma.mediaFile.update({
    where: { id },
    data: { isLogo: true },
  });

  return c.json({
    data: {
      brandColors: parseExtractedColors(updated.extractedColors),
    },
  });
});

// POST /api/media/:id/edit - apply image edits with Sharp
const ImageEditSchema = z.object({
  crop: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().min(1),
      height: z.number().min(1),
    })
    .optional(),
  rotate: z.number().optional(),
  saveAsNew: z.boolean().optional().default(false),
});

mediaRouter.post(
  "/:id/edit",
  requireAuth,
  zValidator("json", ImageEditSchema),
  async (c) => {
    if (!isStorageConfigured()) {
      return c.json(
        {
          error: {
            message: "Storage not configured",
            code: "STORAGE_NOT_CONFIGURED",
          },
        },
        503,
      );
    }

    const user = c.get("user")!;
    const id = c.req.param("id");
    const { crop, rotate, saveAsNew } = c.req.valid("json");

    const file = await prisma.mediaFile.findFirst({
      where: { id, userId: user.id },
    });

    if (!file) {
      return c.json(
        { error: { message: "File not found", code: "NOT_FOUND" } },
        404,
      );
    }

    // SVGs and GIFs can't be edited with Sharp
    if (file.mimeType === "image/svg+xml" || file.mimeType === "image/gif") {
      return c.json(
        {
          error: {
            message: "This file type cannot be edited",
            code: "UNSUPPORTED_TYPE",
          },
        },
        400,
      );
    }

    try {
      const storage = getStorage();

      // Download original file
      const originalBuffer = await storage.download(file.key);

      // Apply transformations with Sharp
      // First, auto-rotate based on EXIF orientation to normalize the image
      let image = sharp(originalBuffer).rotate(); // rotate() with no args = auto-orient from EXIF

      // Apply user-requested rotation (frontend sends crop coordinates for rotated image)
      if (rotate && rotate !== 0) {
        // Get the auto-rotated buffer first, then apply user rotation
        const autoRotatedBuffer = await image.toBuffer();
        image = sharp(autoRotatedBuffer).rotate(rotate);
      }

      // Get dimensions after rotation for crop validation
      const rotatedBuffer = await image.toBuffer();
      image = sharp(rotatedBuffer);
      const rotatedMeta = await image.metadata();
      const imgWidth = rotatedMeta.width || 0;
      const imgHeight = rotatedMeta.height || 0;

      // Apply crop to the rotated image
      if (crop) {
        const cropX = Math.max(0, Math.round(crop.x));
        const cropY = Math.max(0, Math.round(crop.y));
        const cropWidth = Math.min(Math.round(crop.width), imgWidth - cropX);
        const cropHeight = Math.min(Math.round(crop.height), imgHeight - cropY);

        if (cropWidth > 0 && cropHeight > 0) {
          image = image.extract({
            left: cropX,
            top: cropY,
            width: cropWidth,
            height: cropHeight,
          });
        }
      }

      // Get output buffer based on original format
      let outputBuffer: Buffer;
      switch (file.mimeType) {
        case "image/png":
          outputBuffer = await image.png().toBuffer();
          break;
        case "image/jpeg":
          outputBuffer = await image.jpeg({ quality: 90 }).toBuffer();
          break;
        case "image/webp":
          outputBuffer = await image.webp({ quality: 90 }).toBuffer();
          break;
        default:
          outputBuffer = await image.toBuffer();
      }

      // Get new dimensions
      const metadata = await sharp(outputBuffer).metadata();
      const newWidth = metadata.width ?? null;
      const newHeight = metadata.height ?? null;

      if (saveAsNew) {
        // Check storage quota for new file
        const quotaCheck = await checkStorageQuota(
          user.id,
          outputBuffer.length,
        );
        if (!quotaCheck.allowed) {
          return c.json(
            { error: { message: quotaCheck.message!, code: "QUOTA_EXCEEDED" } },
            400,
          );
        }

        // Create new file with new UUID
        const newUuid = randomUUID();
        const extension = MIME_TO_EXTENSION[file.mimeType] || "bin";
        const newKey = `users/${user.id}/media/${newUuid}.${extension}`;

        await storage.upload(newKey, outputBuffer, file.mimeType);

        const newFile = await prisma.mediaFile.create({
          data: {
            userId: user.id,
            filename: `${file.filename.replace(/\.[^.]+$/, "")}_edited.${extension}`,
            key: newKey,
            mimeType: file.mimeType,
            sizeBytes: outputBuffer.length,
            width: newWidth,
            height: newHeight,
            tags: file.tags,
            extractedColors: file.extractedColors,
          },
        });

        const url = await storage.getSignedUrl(newKey, SIGNED_URL_EXPIRY);

        return c.json({
          data: {
            ...transformMediaFile(newFile),
            url,
          },
        });
      } else {
        // Replace existing file
        await storage.upload(file.key, outputBuffer, file.mimeType);

        const updated = await prisma.mediaFile.update({
          where: { id },
          data: {
            sizeBytes: outputBuffer.length,
            width: newWidth,
            height: newHeight,
          },
        });

        const url = await storage.getSignedUrl(file.key, SIGNED_URL_EXPIRY);

        return c.json({
          data: {
            ...transformMediaFile(updated),
            url,
          },
        });
      }
    } catch (error) {
      logError("Media", "Image edit error:", error);
      return c.json(
        { error: { message: "Failed to edit image", code: "EDIT_FAILED" } },
        500,
      );
    }
  },
);

export { mediaRouter };
