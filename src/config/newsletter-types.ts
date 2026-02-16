/**
 * Newsletter Type Configuration
 *
 * Each type defines default settings, colors, and suggested sections.
 * Easy to extend by adding new entries.
 */

export interface NewsletterTypeConfig {
  id: string;
  name: string;
  description: string;
  icon: string; // emoji
  // Tones that work well for this type - AI chooses based on topic context
  typicalTones: Array<
    "professional" | "casual" | "playful" | "formal" | "friendly"
  >;
  defaultColors: {
    primary: string;
    accent: string;
  };
  colorPresets: Array<{
    name: string;
    primary: string;
    accent: string;
  }>;
  suggestedSections: string[];
  promptFocus: string; // Key aspects to emphasize in AI prompt
}

export interface ToneConfig {
  id: string;
  name: string;
  description: string;
  example: string; // Example phrase in this tone
}

export const TONES: Record<string, ToneConfig> = {
  professional: {
    id: "professional",
    name: "Professional",
    description:
      "Authoritative and polished. Best for B2B, finance, and industry content.",
    example:
      "We're excited to share key insights from this quarter's market analysis.",
  },
  casual: {
    id: "casual",
    name: "Casual",
    description:
      "Relaxed and conversational. Like chatting with a knowledgeable friend.",
    example: "Hey! Check out these cool finds we stumbled upon this week.",
  },
  playful: {
    id: "playful",
    name: "Playful",
    description:
      "Fun and energetic with humor. Great for creative and lifestyle content.",
    example:
      "Buckle up, buttercup! We've got some seriously awesome stuff to share. 🚀",
  },
  formal: {
    id: "formal",
    name: "Formal",
    description:
      "Traditional and respectful. Ideal for academic or executive audiences.",
    example:
      "We are pleased to present this week's curated selection of industry developments.",
  },
  friendly: {
    id: "friendly",
    name: "Friendly",
    description:
      "Warm and approachable. Builds connection while staying informative.",
    example:
      "Welcome back! We've gathered some great resources we think you'll love.",
  },
};

export function getToneConfig(toneId: string): ToneConfig | undefined {
  return TONES[toneId];
}

export function getAllTones(): ToneConfig[] {
  return Object.values(TONES);
}

export const NEWSLETTER_TYPES: Record<string, NewsletterTypeConfig> = {
  tech: {
    id: "tech",
    name: "Tech/Developer",
    description: "Technical content, tools, tutorials, developer news",
    icon: "💻",
    typicalTones: ["professional", "casual", "friendly"], // AI picks based on topic
    defaultColors: { primary: "#0066FF", accent: "#00D4FF" },
    colorPresets: [
      { name: "Electric Blue", primary: "#0066FF", accent: "#00D4FF" },
      { name: "GitHub Dark", primary: "#238636", accent: "#58A6FF" },
      { name: "Terminal Green", primary: "#00FF00", accent: "#00CC00" },
      { name: "VS Code", primary: "#007ACC", accent: "#9CDCFE" },
    ],
    suggestedSections: [
      "intro",
      "quickHits",
      "featured",
      "tools",
      "category",
      "tipOfTheDay",
      "outro",
    ],
    promptFocus:
      "code snippets, tool recommendations, technical depth, developer community voice",
  },
  digest: {
    id: "digest",
    name: "Curated Digest",
    description: "News roundups, link collections, quick reads",
    icon: "📰",
    typicalTones: ["casual", "friendly", "professional"],
    defaultColors: { primary: "#FF6B35", accent: "#FFB347" },
    colorPresets: [
      { name: "Morning Brew", primary: "#FF6B35", accent: "#FFB347" },
      { name: "TLDR", primary: "#6366F1", accent: "#A5B4FC" },
      { name: "News Classic", primary: "#1A1A1A", accent: "#DC2626" },
      { name: "Daily Scoop", primary: "#0891B2", accent: "#22D3EE" },
    ],
    suggestedSections: [
      "intro",
      "quickHits",
      "category",
      "sponsor",
      "category",
      "outro",
    ],
    promptFocus:
      "scannable format, punchy headlines, brief descriptions, quick value delivery",
  },
  brand: {
    id: "brand",
    name: "Brand/Product",
    description: "Product launches, company stories, brand updates",
    icon: "✨",
    typicalTones: ["friendly", "playful", "casual", "professional"],
    defaultColors: { primary: "#8B5CF6", accent: "#EC4899" },
    colorPresets: [
      { name: "Modern Purple", primary: "#8B5CF6", accent: "#EC4899" },
      { name: "Luxury Gold", primary: "#1F2937", accent: "#D4AF37" },
      { name: "Fresh Coral", primary: "#F97316", accent: "#FB923C" },
      { name: "Elegant Teal", primary: "#0D9488", accent: "#5EEAD4" },
    ],
    suggestedSections: [
      "intro",
      "featured",
      "category",
      "personalNote",
      "outro",
    ],
    promptFocus:
      "storytelling, emotional connection, product showcase, brand personality",
  },
  b2b: {
    id: "b2b",
    name: "B2B/Industry",
    description: "Industry analysis, case studies, professional insights",
    icon: "📊",
    typicalTones: ["professional", "formal", "friendly"],
    defaultColors: { primary: "#1E3A5F", accent: "#3B82F6" },
    colorPresets: [
      { name: "Corporate Blue", primary: "#1E3A5F", accent: "#3B82F6" },
      { name: "Executive Gray", primary: "#374151", accent: "#6B7280" },
      { name: "Finance Green", primary: "#064E3B", accent: "#10B981" },
      { name: "Consulting Navy", primary: "#1E3A8A", accent: "#60A5FA" },
    ],
    suggestedSections: ["intro", "featured", "quickHits", "category", "outro"],
    promptFocus:
      "data-driven insights, industry expertise, actionable takeaways, professional credibility",
  },
  personal: {
    id: "personal",
    name: "Personal/Creator",
    description: "Personal essays, creator updates, recommendations",
    icon: "✍️",
    typicalTones: ["casual", "friendly", "playful"],
    defaultColors: { primary: "#059669", accent: "#34D399" },
    colorPresets: [
      { name: "Creator Green", primary: "#059669", accent: "#34D399" },
      { name: "Substack Orange", primary: "#FF6719", accent: "#FFB088" },
      { name: "Writer's Ink", primary: "#1F2937", accent: "#9CA3AF" },
      { name: "Warm Earth", primary: "#92400E", accent: "#FCD34D" },
    ],
    suggestedSections: [
      "personalNote",
      "featured",
      "recommendations",
      "category",
      "outro",
    ],
    promptFocus:
      "authentic voice, personal stories, genuine recommendations, reader connection",
  },
  educational: {
    id: "educational",
    name: "Educational/Tutorial",
    description: "Lessons, tutorials, how-tos, learning content",
    icon: "🎓",
    typicalTones: ["friendly", "professional", "casual"],
    defaultColors: { primary: "#7C3AED", accent: "#A78BFA" },
    colorPresets: [
      { name: "Learning Purple", primary: "#7C3AED", accent: "#A78BFA" },
      { name: "Academy Blue", primary: "#2563EB", accent: "#93C5FD" },
      { name: "Knowledge Gold", primary: "#B45309", accent: "#FCD34D" },
      { name: "Study Teal", primary: "#0F766E", accent: "#5EEAD4" },
    ],
    suggestedSections: [
      "intro",
      "featured",
      "tipOfTheDay",
      "category",
      "poll",
      "outro",
    ],
    promptFocus:
      "clear explanations, step-by-step guidance, practical examples, encouraging tone",
  },
};

export function getNewsletterTypeConfig(
  typeId: string,
): NewsletterTypeConfig | undefined {
  return NEWSLETTER_TYPES[typeId];
}

export function getAllNewsletterTypes(): NewsletterTypeConfig[] {
  return Object.values(NEWSLETTER_TYPES);
}
