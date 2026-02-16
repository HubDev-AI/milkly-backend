import { prisma } from "../prisma";

export const SYSTEM_SETTINGS = {
  FREE_TIER_RENEWAL_ENABLED: "FREE_TIER_RENEWAL_ENABLED",
} as const;

const CACHE_TTL_MS = 300000; // 5 minutes

interface CacheEntry {
  value: string;
  cachedAt: number;
}

const settingsCache = new Map<string, CacheEntry>();

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

export async function getSystemSetting(key: string): Promise<string | null> {
  const cached = settingsCache.get(key);
  if (cached && isCacheValid(cached)) {
    return cached.value;
  }

  const setting = await prisma.systemSettings.findUnique({
    where: { key },
    select: { value: true },
  });

  if (setting) {
    settingsCache.set(key, {
      value: setting.value,
      cachedAt: Date.now(),
    });
    return setting.value;
  }

  return null;
}

export async function setSystemSetting(
  key: string,
  value: string,
  description?: string,
): Promise<void> {
  await prisma.systemSettings.upsert({
    where: { key },
    update: { value, ...(description !== undefined && { description }) },
    create: { key, value, description: description ?? null },
  });

  settingsCache.set(key, {
    value,
    cachedAt: Date.now(),
  });
}

export async function isFreeTierRenewalEnabled(): Promise<boolean> {
  const value = await getSystemSetting(
    SYSTEM_SETTINGS.FREE_TIER_RENEWAL_ENABLED,
  );
  return value === null || value === "true";
}

export function clearSettingsCache(): void {
  settingsCache.clear();
}
