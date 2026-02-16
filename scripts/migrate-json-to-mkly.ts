/**
 * Migration script: Convert JSON template structures to mkly source
 *
 * Finds all Template and LinkedStreamTemplate records where mklySource
 * contains JSON (legacy format) and converts them to mkly markup.
 *
 * Usage: bun run scripts/migrate-json-to-mkly.ts [--dry-run]
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

interface LegacySection {
  type: string;
  category?: string;
  heading?: string;
  maxItems?: number;
  style?: string;
}

interface LegacyTemplate {
  name: string;
  brandIdentity?: {
    newsletterName?: string;
    tagline?: string;
    voiceDescription?: string;
  };
  sections: LegacySection[];
  styling: {
    tone: string;
    headerStyle: string;
    colors: { primary: string; accent: string };
  };
}

function jsonToMkly(json: LegacyTemplate): string {
  const lines: string[] = [];

  // Meta block
  const title =
    json.brandIdentity?.newsletterName || json.name || "Newsletter";
  lines.push("--- meta");
  lines.push(`title: ${title}`);
  if (json.brandIdentity?.tagline) {
    lines.push(`tagline: ${json.brandIdentity.tagline}`);
  }
  lines.push("");

  // Use newsletter kit
  lines.push("--- use: newsletter");
  lines.push("");

  // Style block
  lines.push("--- style");
  if (json.styling?.colors?.accent) {
    lines.push(`accent: ${json.styling.colors.accent}`);
  }
  if (json.styling?.colors?.primary) {
    lines.push(`primary: ${json.styling.colors.primary}`);
  }
  if (json.styling?.tone) {
    lines.push(`tone: ${json.styling.tone}`);
  }
  lines.push("");

  // Section blocks
  for (const section of json.sections) {
    const blockType = section.type;
    lines.push(`--- newsletter/${blockType}`);

    if (section.heading) {
      lines.push(`heading: ${section.heading}`);
    }
    if (section.category) {
      lines.push(`category: ${section.category}`);
    }
    if (section.maxItems) {
      lines.push(`maxItems: ${section.maxItems}`);
    }
    if (section.style) {
      lines.push(`style: ${section.style}`);
    }

    // Add default body content for intro/outro
    if (blockType === "intro") {
      lines.push("");
      lines.push(`Welcome to ${title} — your curated roundup.`);
    } else if (blockType === "outro") {
      lines.push("");
      lines.push("Thanks for reading! Stay tuned for more updates.");
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

function isJsonTemplate(mklySource: string): boolean {
  const trimmed = mklySource.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

async function migrate() {
  console.log(dryRun ? "=== DRY RUN ===" : "=== MIGRATING ===");

  // Migrate Template records
  const templates = await prisma.template.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, mklySource: true },
  });

  let templateCount = 0;
  for (const t of templates) {
    if (!isJsonTemplate(t.mklySource)) continue;

    try {
      const json = JSON.parse(t.mklySource) as LegacyTemplate;
      const mkly = jsonToMkly(json);

      console.log(`Template "${t.name}" (${t.id}):`);
      console.log(`  JSON → mkly (${t.mklySource.length} → ${mkly.length} chars)`);

      if (!dryRun) {
        await prisma.template.update({
          where: { id: t.id },
          data: { mklySource: mkly },
        });
        console.log("  ✓ Updated");
      }
      templateCount++;
    } catch (err) {
      console.error(`  ✗ Failed to parse template ${t.id}:`, err);
    }
  }

  // Migrate LinkedStreamTemplate records
  const linkedTemplates = await prisma.linkedStreamTemplate.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, mklySource: true },
  });

  let linkedCount = 0;
  for (const t of linkedTemplates) {
    if (!isJsonTemplate(t.mklySource)) continue;

    try {
      const json = JSON.parse(t.mklySource) as LegacyTemplate;
      const mkly = jsonToMkly(json);

      console.log(`LinkedStreamTemplate "${t.name}" (${t.id}):`);
      console.log(`  JSON → mkly (${t.mklySource.length} → ${mkly.length} chars)`);

      if (!dryRun) {
        await prisma.linkedStreamTemplate.update({
          where: { id: t.id },
          data: { mklySource: mkly },
        });
        console.log("  ✓ Updated");
      }
      linkedCount++;
    } catch (err) {
      console.error(`  ✗ Failed to parse linked template ${t.id}:`, err);
    }
  }

  console.log(
    `\nDone. ${templateCount} templates + ${linkedCount} linked templates ${dryRun ? "would be" : ""} migrated.`,
  );

  await prisma.$disconnect();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  prisma.$disconnect();
  process.exit(1);
});
