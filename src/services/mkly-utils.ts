import type { Category } from "../types";

/**
 * Extract top-level style variables from --- style blocks in mkly source.
 * Returns key-value pairs like { accent: "#e2725b", primary: "#1a1a2e", tone: "professional" }.
 * Skips block selectors (lines containing "/") and indented properties.
 */
export function extractMklyStyleVars(
  mklySource: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  // Match all --- style block contents (up to next --- or end)
  const styleBlockRegex = /^--- style\s*\n([\s\S]*?)(?=\n---|\s*$)/gm;
  let match: RegExpExecArray | null;

  while ((match = styleBlockRegex.exec(mklySource)) !== null) {
    const blockContent = match[1];
    if (!blockContent) continue;
    for (const line of blockContent.split("\n")) {
      // Only top-level key: value lines (not indented, not block selectors with "/")
      const kvMatch = line.match(/^([a-zA-Z]\w*)\s*:\s*(.+)$/);
      if (kvMatch?.[1] && kvMatch[2] && !kvMatch[1].includes("/")) {
        vars[kvMatch[1]] = kvMatch[2].trim();
      }
    }
  }

  return vars;
}

/**
 * Extract meta values from --- meta block in mkly source.
 * Returns key-value pairs like { title: "My Newsletter", subject: "Weekly Update" }.
 */
export function extractMklyMeta(
  mklySource: string,
): Record<string, string> {
  const meta: Record<string, string> = {};

  const metaBlockRegex = /^--- meta\s*\n([\s\S]*?)(?=\n---|\s*$)/gm;
  const match = metaBlockRegex.exec(mklySource);
  if (!match?.[1]) return meta;

  for (const line of match[1].split("\n")) {
    const kvMatch = line.match(/^([a-zA-Z]\w*)\s*:\s*(.+)$/);
    if (kvMatch?.[1] && kvMatch[2]) {
      meta[kvMatch[1]] = kvMatch[2].trim();
    }
  }

  return meta;
}

interface MklySection {
  type: string;
  heading?: string;
  category?: string;
  maxItems?: number;
  style?: string;
}

/**
 * Extract newsletter sections from --- newsletter/* blocks in mkly source.
 * Returns an array of section descriptors with their properties.
 */
export function extractMklySections(mklySource: string): MklySection[] {
  const sections: MklySection[] = [];

  // Match --- newsletter/TYPE lines and capture properties that follow
  const blockRegex =
    /^--- newsletter\/(\w+)\s*\n((?:[a-zA-Z]\w*:\s*.+\n)*)/gm;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(mklySource)) !== null) {
    const blockType = match[1];
    const propsText = match[2];

    const section: MklySection = { type: blockType! };

    // Parse properties
    if (propsText) {
      for (const line of propsText.split("\n")) {
        const kvMatch = line.match(/^([a-zA-Z]\w*)\s*:\s*(.+)$/);
        if (!kvMatch) continue;
        const [, key, value] = kvMatch;
        if (!key || !value) continue;
        const trimmed = value.trim();

        switch (key) {
          case "heading":
            section.heading = trimmed;
            break;
          case "category":
            section.category = trimmed as Category;
            break;
          case "maxItems":
            section.maxItems = parseInt(trimmed, 10) || undefined;
            break;
          case "style":
            section.style = trimmed;
            break;
        }
      }
    }

    sections.push(section);
  }

  return sections;
}

/**
 * Build a default mkly source string for templates created without AI.
 * Takes categories and optional customization params.
 */
export function buildDefaultMklySource(
  name: string,
  categories: Category[],
  options?: {
    primaryColor?: string;
    accentColor?: string;
    tone?: string;
  },
): string {
  const primary = options?.primaryColor || "#4A3728";
  const accent = options?.accentColor || "#D4A574";

  const categoryBlocks = categories
    .map((cat) => {
      const heading =
        cat === "news"
          ? "Top Stories"
          : cat === "videos"
            ? "Watch This"
            : cat === "social"
              ? "Buzz & Chatter"
              : "Featured";
      return `--- newsletter/category\ncategory: ${cat}\nheading: ${heading}`;
    })
    .join("\n\n");

  return `--- meta
title: ${name} Newsletter

--- use: newsletter

--- style
accent: ${accent}
primary: ${primary}

--- newsletter/intro

Welcome to ${name} — your curated roundup of the latest content.

--- newsletter/featured
heading: Featured

${categoryBlocks}

--- newsletter/outro

Thanks for reading! Stay tuned for more updates.`;
}
