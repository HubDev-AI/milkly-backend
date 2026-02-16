import { prisma } from "../prisma";
import { isStorageConfigured, makeMediaPublic } from "../lib/storage";
import { logError, logInfo } from "../lib/debug";

// Matches S3 media keys in URLs: users/{userId}/media/{filename}
const MEDIA_KEY_REGEX = /users\/[^/\s"']+\/media\/[^/\s"'?#]+/g;

/**
 * Extract unique private S3 media keys from HTML content.
 * Finds all occurrences of our media key pattern (users/.../media/...)
 * regardless of how the URL got into the HTML.
 */
function extractMediaKeysFromHtml(html: string): string[] {
  const matches = html.match(MEDIA_KEY_REGEX);
  if (!matches) return [];
  return [...new Set(matches)];
}

/**
 * For each S3 key found in the HTML, look up the MediaFile by key,
 * copy it to public storage, and build a replacement map.
 */
async function buildPublicUrlMapFromKeys(
  keys: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  await Promise.all(
    keys.map(async (key) => {
      try {
        const mediaFile = await prisma.mediaFile.findUnique({
          where: { key },
          select: { id: true },
        });
        if (!mediaFile) return;

        const publicUrl = await makeMediaPublic(mediaFile.id);
        if (publicUrl) {
          map.set(key, publicUrl);
        }
      } catch (error) {
        logError("buildPublicUrlMapFromKeys", "Error processing key:", error);
      }
    }),
  );

  return map;
}

/**
 * Replace signed S3 URLs in HTML using known S3 keys.
 * For each key, matches any URL containing that key path and replaces
 * the full URL (including query params) with the permanent public URL.
 */
function replaceKeyUrls(
  html: string,
  keyToPublicUrl: Map<string, string>,
): string {
  let result = html;

  for (const [key, publicUrl] of keyToPublicUrl) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const urlRegex = new RegExp(
      `https?://[^"'\\s)]*?${escapedKey}[^"'\\s)]*`,
      "g",
    );
    result = result.replace(urlRegex, publicUrl);
  }

  return result;
}

/**
 * Scan HTML for private S3 media URLs, copy them to public storage,
 * and replace all signed URLs with permanent public URLs.
 *
 * Works for both regular and linked newsletters — only processes
 * images that are actually present in the published HTML.
 */
async function makeHtmlMediaPublic(html: string): Promise<string> {
  if (!isStorageConfigured()) return html;

  const keys = extractMediaKeysFromHtml(html);
  if (keys.length === 0) return html;

  logInfo("publishContent", `Found ${keys.length} media key(s) in HTML`);
  const keyMap = await buildPublicUrlMapFromKeys(keys);
  return replaceKeyUrls(html, keyMap);
}

/**
 * Replace signed S3 URLs with permanent public URLs in a regular newsletter.
 */
export async function publishNewsletterContent(
  html: string,
  _newsletterId: string,
  _templateId: string | null,
): Promise<string> {
  return makeHtmlMediaPublic(html);
}

/**
 * Replace signed S3 URLs with permanent public URLs in a linked newsletter.
 */
export async function publishLinkedNewsletterContent(
  html: string,
  _newsletterId: string,
  _templateId: string | null,
): Promise<string> {
  return makeHtmlMediaPublic(html);
}
