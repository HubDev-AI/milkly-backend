import { z } from "zod";
import { prisma } from "../prisma";
import { STYLE_LEARNING } from "../config";
import {
  isStyleFeatureEnabled,
  WRITING_BASELINE_PUBLISH_INTERVAL,
  type TierName,
} from "../config/tiers";
import { getUserTier } from "../middleware/tier-limits";
import { callAIForOperation, cleanMarkdownBlocks } from "./ai";
import { createDebugger, logError } from "../lib/debug";

const debug = createDebugger("STYLE-LEARNING");

// ============ Zod Schemas for AI Output Validation ============

const VoiceSchema = z.object({
  formality: z.number().min(0).max(1),
  enthusiasm: z.number().min(0).max(1),
  technicalDepth: z.number().min(0).max(1),
  toneMarkers: z.array(z.string()),
  avgSentenceLength: z.number().min(1),
  emojiUsage: z.enum(["none", "rare", "moderate", "heavy"]),
});

const StructureSchema = z.object({
  avgIntroWords: z.number().min(0),
  sectionRetention: z.record(z.string(), z.number().min(0).max(1)),
});

const StyleProfileSchema = z.object({
  editionsAnalyzed: z.number(),
  voice: VoiceSchema,
  structure: StructureSchema,
  goldenExcerpts: z.array(z.string()),
  editPatterns: z.array(z.string()),
  lastUpdated: z.string(),
});

type TemplateStyleProfile = z.infer<typeof StyleProfileSchema>;

const WritingBaselineSchema = z.object({
  publishCount: z.number(),
  avgFormality: z.number(),
  avgEnthusiasm: z.number(),
  brevityPreference: z.enum(["concise", "moderate", "verbose"]),
  emojiUsage: z.enum(["none", "rare", "moderate"]),
  editIntensity: z.enum(["light", "moderate", "heavy"]),
  lastUpdated: z.string(),
});

type UserWritingBaseline = z.infer<typeof WritingBaselineSchema>;

const EditPatternSchema = z.array(z.string());

// ============ Main Entry Point ============

export interface StyleContext {
  fewShotExamples?: string;
  profileGuidance?: string;
  editPatternGuidance?: string;
  baselineGuidance?: string;
}

export async function getStyleContext(
  templateId: string,
  templateType: "stream" | "linkedStream",
  userId: string,
): Promise<StyleContext | null> {
  if (!STYLE_LEARNING.ENABLED) {
    debug("Style learning disabled via kill switch");
    return null;
  }

  let tier: TierName;
  try {
    tier = await getUserTier(userId);
  } catch {
    debug("Failed to get user tier, skipping style context");
    return null;
  }

  const context: StyleContext = {};

  // Phase 1: Few-shot from published editions
  if (isStyleFeatureEnabled("fewShotFromEditions", tier)) {
    try {
      context.fewShotExamples = await getFewShotExamples(
        templateId,
        templateType,
      );
    } catch (err) {
      logError("STYLE-LEARNING", "Few-shot extraction failed:", err);
    }
  }

  // Phase 2: Style profile from template
  if (isStyleFeatureEnabled("styleProfile", tier)) {
    try {
      context.profileGuidance = await getProfileGuidance(
        templateId,
        templateType,
      );
    } catch (err) {
      logError("STYLE-LEARNING", "Profile guidance failed:", err);
    }
  }

  // Phase 4: User writing baseline (fallback for new templates)
  if (
    isStyleFeatureEnabled("writingBaseline", tier) &&
    !context.fewShotExamples &&
    !context.profileGuidance
  ) {
    try {
      context.baselineGuidance = await getBaselineGuidance(userId);
    } catch (err) {
      logError("STYLE-LEARNING", "Baseline guidance failed:", err);
    }
  }

  const hasAny =
    context.fewShotExamples ||
    context.profileGuidance ||
    context.editPatternGuidance ||
    context.baselineGuidance;

  return hasAny ? context : null;
}

export function formatStyleContextForPrompt(ctx: StyleContext): string {
  const parts: string[] = [];

  if (ctx.fewShotExamples) {
    parts.push(ctx.fewShotExamples);
  }

  if (ctx.profileGuidance) {
    parts.push(ctx.profileGuidance);
  }

  if (ctx.editPatternGuidance) {
    parts.push(ctx.editPatternGuidance);
  }

  if (ctx.baselineGuidance) {
    parts.push(ctx.baselineGuidance);
  }

  return parts.join("\n\n");
}

// ============ Phase 1: Few-Shot from Published Editions ============

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExcerpts(html: string): {
  intro: string;
  body: string;
  outro: string;
} {
  const text = stripHtmlTags(html);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20);

  return {
    intro: sentences.slice(0, 2).join(" ").substring(0, 300),
    body: sentences.slice(2, 5).join(" ").substring(0, 400),
    outro: sentences.slice(-2).join(" ").substring(0, 200),
  };
}

async function getFewShotExamples(
  templateId: string,
  templateType: "stream" | "linkedStream",
): Promise<string | undefined> {
  const limit = STYLE_LEARNING.MAX_EDITIONS_FOR_FEW_SHOT;

  let editions: Array<{ content: string; publishedAt: Date | null }>;

  if (templateType === "stream") {
    editions = await prisma.newsletter.findMany({
      where: { templateId, status: "published" },
      orderBy: { publishedAt: "desc" },
      take: limit,
      select: { content: true, publishedAt: true },
    });
  } else {
    editions = await prisma.linkedNewsletter.findMany({
      where: { templateId, status: "published" },
      orderBy: { publishedAt: "desc" },
      take: limit,
      select: { content: true, publishedAt: true },
    });
  }

  if (editions.length === 0) return undefined;

  debug(
    `Found ${editions.length} published editions for template ${templateId}`,
  );

  const examples = editions.map((ed, i) => {
    const excerpts = extractExcerpts(ed.content);
    return `--- Edition ${i + 1} (${ed.publishedAt?.toISOString().split("T")[0] ?? "unknown"}) ---
INTRO: ${excerpts.intro}
BODY SAMPLE: ${excerpts.body}
OUTRO: ${excerpts.outro}`;
  });

  return `STYLE REFERENCE — Match this newsletter's established voice from past editions:
${examples.join("\n\n")}

Study the tone, sentence structure, and vocabulary above. Your output should feel like the next edition of this same newsletter.`;
}

// ============ Phase 2: Style Profile ============

async function getProfileGuidance(
  templateId: string,
  templateType: "stream" | "linkedStream",
): Promise<string | undefined> {
  let profileJson: string | null = null;

  if (templateType === "stream") {
    const template = await prisma.template.findUnique({
      where: { id: templateId },
      select: { styleProfile: true },
    });
    profileJson = template?.styleProfile ?? null;
  } else {
    const template = await prisma.linkedStreamTemplate.findUnique({
      where: { id: templateId },
      select: { styleProfile: true },
    });
    profileJson = template?.styleProfile ?? null;
  }

  if (!profileJson) return undefined;

  const parsed = StyleProfileSchema.safeParse(JSON.parse(profileJson));
  if (!parsed.success) {
    debug("Invalid style profile JSON, skipping");
    return undefined;
  }

  const profile = parsed.data;
  const tone = profile.voice;

  const lines: string[] = [
    "LEARNED STYLE PROFILE (from analyzing published editions):",
    `- Formality: ${tone.formality < 0.3 ? "casual" : tone.formality > 0.7 ? "formal" : "balanced"}`,
    `- Enthusiasm: ${tone.enthusiasm < 0.3 ? "measured/dry" : tone.enthusiasm > 0.7 ? "energetic" : "moderate"}`,
    `- Technical depth: ${tone.technicalDepth < 0.3 ? "accessible" : tone.technicalDepth > 0.7 ? "deep/technical" : "moderate"}`,
    `- Avg sentence length: ~${Math.round(tone.avgSentenceLength)} words`,
    `- Emoji usage: ${tone.emojiUsage}`,
  ];

  if (tone.toneMarkers.length > 0) {
    lines.push(`- Voice markers: ${tone.toneMarkers.join(", ")}`);
  }

  if (profile.goldenExcerpts.length > 0) {
    lines.push("");
    lines.push(
      "GOLDEN EXCERPTS (representative sentences from past editions):",
    );
    for (const excerpt of profile.goldenExcerpts.slice(
      0,
      STYLE_LEARNING.MAX_GOLDEN_EXCERPTS,
    )) {
      lines.push(`  "${excerpt}"`);
    }
  }

  if (profile.editPatterns.length > 0) {
    lines.push("");
    lines.push(
      "USER EDIT PATTERNS (apply these proactively so the user needs fewer edits):",
    );
    for (const pattern of profile.editPatterns.slice(
      0,
      STYLE_LEARNING.MAX_EDIT_PATTERNS,
    )) {
      lines.push(`  - ${pattern}`);
    }
  }

  return lines.join("\n");
}

// ============ Phase 2: Post-Publish Style Analysis ============

export async function analyzeAndUpdateStyleProfile(
  content: string,
  templateId: string,
  templateType: "stream" | "linkedStream",
  userId: string,
): Promise<void> {
  debug(`Analyzing style profile for template ${templateId}`);

  const text = stripHtmlTags(content);
  if (text.length < 100) {
    debug("Content too short for style analysis, skipping");
    return;
  }

  const prompt = `Analyze the writing style of this newsletter content and return a JSON object.

CONTENT:
${text.substring(0, 5000)}

Return ONLY valid JSON matching this exact schema:
{
  "voice": {
    "formality": <number 0-1, 0=casual, 1=formal>,
    "enthusiasm": <number 0-1, 0=dry, 1=enthusiastic>,
    "technicalDepth": <number 0-1, 0=accessible, 1=deep>,
    "toneMarkers": [<3-5 strings describing the voice, e.g. "conversational", "dry-humor", "first-person">],
    "avgSentenceLength": <number, average words per sentence>,
    "emojiUsage": "none" | "rare" | "moderate" | "heavy"
  },
  "structure": {
    "avgIntroWords": <number>,
    "sectionRetention": {}
  },
  "goldenExcerpts": [<3-5 representative sentences that capture the newsletter's voice>]
}

No markdown, no code blocks, no explanations. ONLY the JSON.`;

  let aiResponse: string;
  try {
    aiResponse = await callAIForOperation(prompt, "styleAnalysis", {
      temperature: STYLE_LEARNING.TEMPERATURE,
    });
  } catch (err) {
    logError("STYLE-LEARNING", "AI call failed for style analysis:", err);
    return;
  }

  const cleaned = cleanMarkdownBlocks(aiResponse);

  const AnalysisSchema = z.object({
    voice: VoiceSchema,
    structure: StructureSchema,
    goldenExcerpts: z.array(z.string()),
  });

  const parsed = AnalysisSchema.safeParse(safeJsonParse(cleaned));
  if (!parsed.success) {
    logError(
      "STYLE-LEARNING",
      "Invalid AI response for style analysis, bailing out:",
      parsed.error.message,
    );
    return;
  }

  const analysis = parsed.data;

  // Load existing profile if any
  let existingProfile: TemplateStyleProfile | null = null;
  if (templateType === "stream") {
    const template = await prisma.template.findUnique({
      where: { id: templateId },
      select: { styleProfile: true },
    });
    if (template?.styleProfile) {
      const ep = StyleProfileSchema.safeParse(
        safeJsonParse(template.styleProfile),
      );
      if (ep.success) existingProfile = ep.data;
    }
  } else {
    const template = await prisma.linkedStreamTemplate.findUnique({
      where: { id: templateId },
      select: { styleProfile: true },
    });
    if (template?.styleProfile) {
      const ep = StyleProfileSchema.safeParse(
        safeJsonParse(template.styleProfile),
      );
      if (ep.success) existingProfile = ep.data;
    }
  }

  // Merge with existing profile using weighted average
  const w = STYLE_LEARNING.RECENCY_WEIGHT;
  const merged: TemplateStyleProfile = existingProfile
    ? {
        editionsAnalyzed: existingProfile.editionsAnalyzed + 1,
        voice: {
          formality:
            w * analysis.voice.formality +
            (1 - w) * existingProfile.voice.formality,
          enthusiasm:
            w * analysis.voice.enthusiasm +
            (1 - w) * existingProfile.voice.enthusiasm,
          technicalDepth:
            w * analysis.voice.technicalDepth +
            (1 - w) * existingProfile.voice.technicalDepth,
          toneMarkers: deduplicateStrings([
            ...analysis.voice.toneMarkers,
            ...existingProfile.voice.toneMarkers,
          ]).slice(0, 8),
          avgSentenceLength:
            w * analysis.voice.avgSentenceLength +
            (1 - w) * existingProfile.voice.avgSentenceLength,
          emojiUsage: analysis.voice.emojiUsage,
        },
        structure: {
          avgIntroWords:
            w * analysis.structure.avgIntroWords +
            (1 - w) * existingProfile.structure.avgIntroWords,
          sectionRetention: {
            ...existingProfile.structure.sectionRetention,
            ...analysis.structure.sectionRetention,
          },
        },
        goldenExcerpts: [
          ...analysis.goldenExcerpts,
          ...existingProfile.goldenExcerpts,
        ].slice(0, STYLE_LEARNING.MAX_GOLDEN_EXCERPTS),
        editPatterns: existingProfile.editPatterns,
        lastUpdated: new Date().toISOString(),
      }
    : {
        editionsAnalyzed: 1,
        voice: analysis.voice,
        structure: analysis.structure,
        goldenExcerpts: analysis.goldenExcerpts.slice(
          0,
          STYLE_LEARNING.MAX_GOLDEN_EXCERPTS,
        ),
        editPatterns: [],
        lastUpdated: new Date().toISOString(),
      };

  const profileJson = JSON.stringify(merged);

  if (templateType === "stream") {
    await prisma.template.update({
      where: { id: templateId },
      data: { styleProfile: profileJson },
    });
  } else {
    await prisma.linkedStreamTemplate.update({
      where: { id: templateId },
      data: { styleProfile: profileJson },
    });
  }

  debug(
    `Style profile updated for template ${templateId} (editions analyzed: ${merged.editionsAnalyzed})`,
  );
}

// ============ Phase 3: Edit-Diff Tracking ============

export async function analyzeEditDiff(
  generatedContent: string,
  publishedContent: string,
  templateId: string,
  templateType: "stream" | "linkedStream",
): Promise<void> {
  debug(`Analyzing edit diff for template ${templateId}`);

  const generatedText = stripHtmlTags(generatedContent);
  const publishedText = stripHtmlTags(publishedContent);

  // Skip if texts are nearly identical
  if (levenshteinSimilarity(generatedText, publishedText) > 0.95) {
    debug("Content nearly identical, skipping edit diff analysis");
    return;
  }

  const prompt = `Compare the AI-generated newsletter text with the user's published version. Identify 3-5 specific edit patterns the user applied.

AI-GENERATED VERSION (excerpt):
${generatedText.substring(0, 3000)}

USER-PUBLISHED VERSION (excerpt):
${publishedText.substring(0, 3000)}

Return ONLY a JSON array of 3-5 strings, each describing one edit pattern. Be specific and actionable.
Examples of good patterns:
- "shortens intros by ~40%, cutting from 3 sentences to 1-2"
- "removes superlative adjectives like 'groundbreaking' and 'revolutionary'"
- "adds personal anecdotes and first-person commentary to outros"
- "replaces generic CTAs with specific action items"

Return ONLY the JSON array. No markdown, no code blocks, no explanations.`;

  let aiResponse: string;
  try {
    aiResponse = await callAIForOperation(prompt, "styleAnalysis", {
      temperature: STYLE_LEARNING.TEMPERATURE,
    });
  } catch (err) {
    logError("STYLE-LEARNING", "AI call failed for edit diff analysis:", err);
    return;
  }

  const cleaned = cleanMarkdownBlocks(aiResponse);
  const parsed = EditPatternSchema.safeParse(safeJsonParse(cleaned));
  if (!parsed.success) {
    logError(
      "STYLE-LEARNING",
      "Invalid AI response for edit diff, bailing out:",
      parsed.error.message,
    );
    return;
  }

  const newPatterns = parsed.data;
  if (newPatterns.length === 0) return;

  // Load existing profile and merge edit patterns
  let profileJson: string | null = null;
  if (templateType === "stream") {
    const template = await prisma.template.findUnique({
      where: { id: templateId },
      select: { styleProfile: true },
    });
    profileJson = template?.styleProfile ?? null;
  } else {
    const template = await prisma.linkedStreamTemplate.findUnique({
      where: { id: templateId },
      select: { styleProfile: true },
    });
    profileJson = template?.styleProfile ?? null;
  }

  if (!profileJson) {
    debug("No style profile exists yet, skipping edit pattern merge");
    return;
  }

  const existingParsed = StyleProfileSchema.safeParse(
    safeJsonParse(profileJson),
  );
  if (!existingParsed.success) return;

  const profile = existingParsed.data;
  profile.editPatterns = deduplicateStrings([
    ...newPatterns,
    ...profile.editPatterns,
  ]).slice(0, STYLE_LEARNING.MAX_EDIT_PATTERNS);
  profile.lastUpdated = new Date().toISOString();

  const updatedJson = JSON.stringify(profile);

  if (templateType === "stream") {
    await prisma.template.update({
      where: { id: templateId },
      data: { styleProfile: updatedJson },
    });
  } else {
    await prisma.linkedStreamTemplate.update({
      where: { id: templateId },
      data: { styleProfile: updatedJson },
    });
  }

  debug(
    `Edit patterns updated for template ${templateId} (${profile.editPatterns.length} patterns)`,
  );
}

// ============ Phase 4: User Writing Baseline ============

export async function maybeUpdateWritingBaseline(
  userId: string,
): Promise<void> {
  // Count total published newsletters
  const [streamCount, linkedCount] = await Promise.all([
    prisma.newsletter.count({ where: { userId, status: "published" } }),
    prisma.linkedNewsletter.count({
      where: { linkedStream: { userId }, status: "published" },
    }),
  ]);

  const totalCount = streamCount + linkedCount;

  if (totalCount % WRITING_BASELINE_PUBLISH_INTERVAL !== 0) {
    debug(
      `Skipping baseline update (publish count: ${totalCount}, interval: ${WRITING_BASELINE_PUBLISH_INTERVAL})`,
    );
    return;
  }

  debug(
    `Updating writing baseline for user ${userId} (publish count: ${totalCount})`,
  );

  // Gather all template style profiles for this user
  const [streamTemplates, linkedTemplates] = await Promise.all([
    prisma.template.findMany({
      where: { userId, styleProfile: { not: null } },
      select: { styleProfile: true },
    }),
    prisma.linkedStreamTemplate.findMany({
      where: { linkedStream: { userId }, styleProfile: { not: null } },
      select: { styleProfile: true },
    }),
  ]);

  const allProfiles: TemplateStyleProfile[] = [];
  for (const t of [...streamTemplates, ...linkedTemplates]) {
    if (!t.styleProfile) continue;
    const parsed = StyleProfileSchema.safeParse(safeJsonParse(t.styleProfile));
    if (parsed.success) allProfiles.push(parsed.data);
  }

  if (allProfiles.length === 0) {
    debug("No valid template profiles found, skipping baseline update");
    return;
  }

  // Aggregate numeric signals
  const avgFormality = avg(allProfiles.map((p) => p.voice.formality));
  const avgEnthusiasm = avg(allProfiles.map((p) => p.voice.enthusiasm));
  const avgSentenceLen = avg(allProfiles.map((p) => p.voice.avgSentenceLength));

  // Determine brevity preference from avg sentence length
  const brevityPreference: UserWritingBaseline["brevityPreference"] =
    avgSentenceLen < 12
      ? "concise"
      : avgSentenceLen > 20
        ? "verbose"
        : "moderate";

  // Determine emoji usage mode
  const emojiCounts = { none: 0, rare: 0, moderate: 0, heavy: 0 };
  for (const p of allProfiles) {
    emojiCounts[p.voice.emojiUsage]++;
  }
  const emojiMode = (["none", "rare", "moderate"] as const).reduce((a, b) =>
    emojiCounts[a] >= emojiCounts[b] ? a : b,
  );

  // Determine edit intensity from edit patterns count
  const avgEditPatterns = avg(allProfiles.map((p) => p.editPatterns.length));
  const editIntensity: UserWritingBaseline["editIntensity"] =
    avgEditPatterns < 2 ? "light" : avgEditPatterns > 5 ? "heavy" : "moderate";

  const baseline: UserWritingBaseline = {
    publishCount: totalCount,
    avgFormality,
    avgEnthusiasm,
    brevityPreference,
    emojiUsage: emojiMode,
    editIntensity,
    lastUpdated: new Date().toISOString(),
  };

  await prisma.user.update({
    where: { id: userId },
    data: { writingBaseline: JSON.stringify(baseline) },
  });

  debug(`Writing baseline updated for user ${userId}`);
}

async function getBaselineGuidance(
  userId: string,
): Promise<string | undefined> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { writingBaseline: true },
  });

  if (!user?.writingBaseline) return undefined;

  const parsed = WritingBaselineSchema.safeParse(
    safeJsonParse(user.writingBaseline),
  );
  if (!parsed.success) return undefined;

  const b = parsed.data;
  return `USER WRITING PREFERENCES (learned from ${b.publishCount} published editions across all newsletters):
- Writing style: ${b.avgFormality < 0.3 ? "casual" : b.avgFormality > 0.7 ? "formal" : "balanced"}
- Energy level: ${b.avgEnthusiasm < 0.3 ? "measured and restrained" : b.avgEnthusiasm > 0.7 ? "enthusiastic and energetic" : "moderately engaged"}
- Brevity: ${b.brevityPreference}
- Emoji: ${b.emojiUsage}
- Edit intensity: ${b.editIntensity} (${b.editIntensity === "heavy" ? "generate conservatively, this user makes many edits" : "user generally accepts AI output with minor tweaks"})`;
}

// ============ Utility Functions ============

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function deduplicateStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((s) => {
    const normalized = s.toLowerCase().trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function levenshteinSimilarity(a: string, b: string): number {
  // Quick length-based similarity check (avoids expensive computation)
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  // Sample-based comparison for long strings
  const sampleSize = Math.min(500, maxLen);
  const sampleA = a.substring(0, sampleSize);
  const sampleB = b.substring(0, sampleSize);

  let matches = 0;
  for (
    let i = 0;
    i < sampleSize && i < sampleA.length && i < sampleB.length;
    i++
  ) {
    if (sampleA[i] === sampleB[i]) matches++;
  }

  return matches / sampleSize;
}
