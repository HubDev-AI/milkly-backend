/**
 * Section Types Configuration
 *
 * Metadata for each newsletter section type including
 * display info, default props, and placeholder content.
 */

export interface SectionTypeConfig {
  id: string;
  name: string;
  description: string;
  icon: string; // emoji
  category: "content" | "engagement" | "monetization" | "structure";
  defaultProps: Record<string, unknown>;
  placeholderContent: string;
}

export const SECTION_TYPES: Record<string, SectionTypeConfig> = {
  intro: {
    id: "intro",
    name: "Introduction",
    description: "Opening section to greet readers and set the tone",
    icon: "👋",
    category: "structure",
    defaultProps: { style: "brief" },
    placeholderContent:
      "[Welcome your readers and introduce this edition's theme]",
  },
  quickHits: {
    id: "quickHits",
    name: "Quick Hits",
    description: "Bullet list of 3-5 brief news items or updates",
    icon: "⚡",
    category: "content",
    defaultProps: { maxItems: 5 },
    placeholderContent:
      "• [Brief news item #1]\n• [Brief news item #2]\n• [Brief news item #3]",
  },
  featured: {
    id: "featured",
    name: "Featured Story",
    description: "Single deep-dive article with image and detailed coverage",
    icon: "⭐",
    category: "content",
    defaultProps: {},
    placeholderContent:
      "[Featured Article Title]\n[2-3 paragraph deep dive on the main story]",
  },
  category: {
    id: "category",
    name: "Category Section",
    description: "Content grouped by category (news, videos, social, etc.)",
    icon: "📂",
    category: "content",
    defaultProps: { maxItems: 3 },
    placeholderContent:
      "[Category items will appear here based on your content]",
  },
  tools: {
    id: "tools",
    name: "Tools & Resources",
    description: "Curated tool and resource recommendations",
    icon: "🛠️",
    category: "content",
    defaultProps: { maxItems: 3 },
    placeholderContent:
      "• [Tool Name] - [Brief description of what it does]\n• [Resource Name] - [Why it's useful]",
  },
  tipOfTheDay: {
    id: "tipOfTheDay",
    name: "Tip of the Day",
    description: "Single actionable tip, prompt, or piece of advice",
    icon: "💡",
    category: "content",
    defaultProps: {},
    placeholderContent: "[Your actionable tip or insight here]",
  },
  community: {
    id: "community",
    name: "Community Spotlight",
    description: "Highlights from community discussions or social content",
    icon: "👥",
    category: "engagement",
    defaultProps: { maxItems: 3 },
    placeholderContent: "[Community highlight or discussion topic]",
  },
  sponsor: {
    id: "sponsor",
    name: "Sponsor Message",
    description: "Clearly marked sponsored content section",
    icon: "💼",
    category: "monetization",
    defaultProps: {},
    placeholderContent:
      "[Sponsor Name]\n[Sponsor message - clearly marked as sponsored]",
  },
  personalNote: {
    id: "personalNote",
    name: "Personal Note",
    description: "Direct message from the creator to readers",
    icon: "✍️",
    category: "engagement",
    defaultProps: {},
    placeholderContent:
      "[Share a personal thought, behind-the-scenes insight, or message to your readers]",
  },
  poll: {
    id: "poll",
    name: "Poll / Question",
    description: "Interactive poll or question to engage readers",
    icon: "📊",
    category: "engagement",
    defaultProps: {},
    placeholderContent:
      "[Your question here]\n[] Option A\n[] Option B\n[] Option C",
  },
  recommendations: {
    id: "recommendations",
    name: "Recommendations",
    description: "What you're reading, watching, or using lately",
    icon: "📚",
    category: "content",
    defaultProps: { maxItems: 3 },
    placeholderContent:
      "Reading: [Book/Article title]\nWatching: [Show/Video]\nListening: [Podcast/Music]",
  },
  outro: {
    id: "outro",
    name: "Closing",
    description: "Sign-off with optional call-to-action",
    icon: "👋",
    category: "structure",
    defaultProps: { style: "cta" },
    placeholderContent: "[Thank readers and include any final call-to-action]",
  },
  custom: {
    id: "custom",
    name: "Custom Section",
    description: "Flexible section for any content type",
    icon: "✏️",
    category: "content",
    defaultProps: {},
    placeholderContent: "[Your custom content here]",
  },
};

export function getSectionTypeConfig(
  typeId: string,
): SectionTypeConfig | undefined {
  return SECTION_TYPES[typeId];
}

export function getAllSectionTypes(): SectionTypeConfig[] {
  return Object.values(SECTION_TYPES);
}

export function getSectionTypesByCategory(
  category: string,
): SectionTypeConfig[] {
  return Object.values(SECTION_TYPES).filter((s) => s.category === category);
}
