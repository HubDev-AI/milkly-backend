import { getAIConfig, type AIProvider } from "../env";
import type { ContentItem, Category, TemplateCustomization } from "../types";
import {
  AI,
  NEWSLETTER,
  UI,
} from "../config";
import {
  getItemNotesPrompt,
  getNewsletterContentPrompt,
  getKeywordsPrompt,
} from "../config/prompts";
import {
  enrichItemsWithContent,
  type ExtractedContent,
} from "./content-extractor";
import { createDebugger, logError } from "../lib/debug";
import { AppError, getErrorMessage } from "../middleware/error-handler";
import {
  getAIModelTier,
  type AIOperationType,
  type AIModelTier,
} from "../config/tiers";

const debugAITemplate = createDebugger("AI-TEMPLATE");
const debugAIContent = createDebugger("AI-CONTENT");
const debugAIPrompt = createDebugger("AI-PROMPT");
const debugAIProvider = createDebugger("AI-PROVIDER");
const debugAIRequest = createDebugger("AI-REQUEST");
const debugAIResponse = createDebugger("AI-RESPONSE");

// AI-generated note for content item
export interface GeneratedNote {
  itemId: string;
  note: string;
}

// API endpoints per provider
const AI_ENDPOINTS: Record<AIProvider, string> = {
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

// Check if AI is configured for a specific tier (or any tier)
export function isAIConfigured(tier?: AIModelTier): boolean {
  if (tier) {
    return Boolean(getAIConfig(tier));
  }
  // Check if any tier is configured
  return Boolean(getAIConfig("high") || getAIConfig("low"));
}

// Google AI (Gemini) API response types
interface GoogleAIResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  }>;
  error?: {
    message: string;
  };
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  };
}

/**
 * Options for callAI function
 */
export interface CallAIOptions {
  modelTier?: AIModelTier;
  temperature?: number;
}

/**
 * Call AI API based on configured provider (exported for reuse in other modules)
 * Supports: Google (Gemini), OpenAI, Anthropic
 * @param prompt - The prompt to send to the AI
 * @param options - Optional configuration (modelTier, temperature)
 */
export async function callAI(
  prompt: string,
  options?: CallAIOptions | number,
): Promise<string> {
  // Handle backward compatibility - options can be just a temperature number
  const opts: CallAIOptions =
    typeof options === "number" ? { temperature: options } : (options ?? {});

  const tier = opts.modelTier ?? "high"; // Default to high for backward compatibility
  const config = getAIConfig(tier);

  if (!config) {
    logError("AI-PROVIDER", `AI configuration not available for tier: ${tier}`);
    throw new Error(`AI configuration not available for tier: ${tier}`);
  }

  const { provider, model, apiKey } = config;
  const temp = opts.temperature ?? AI.TEMPERATURE;
  const endpoint = AI_ENDPOINTS[provider];

  debugAIProvider(
    `Using provider: ${provider}, model: ${model}, tier: ${tier}, temperature: ${temp}`,
  );
  debugAIRequest(`--- PROMPT START (${prompt.length} chars) ---`);
  debugAIRequest(prompt);
  debugAIRequest(`--- PROMPT END ---`);

  // Google (Gemini) API
  if (provider === "google") {
    const fullEndpoint = `${endpoint}/${model}:generateContent`;
    debugAIProvider(`Calling Google/Gemini API: endpoint=${fullEndpoint}`);

    const response = await fetch(fullEndpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: temp },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError(
        "AI-PROVIDER",
        `Google API error: status=${response.status}, body=${errorText}`,
      );
      if (response.status === 429) {
        debugAIProvider("Google rate limit hit, throwing AI_RATE_LIMITED");
        throw new AppError(
          "AI_RATE_LIMITED",
          "AI service is busy. Please try again in a few moments.",
          429,
        );
      }
      throw new AppError(
        "AI_SERVICE_UNAVAILABLE",
        "AI service is temporarily unavailable. Please try again later.",
        503,
      );
    }

    const data = (await response.json()) as GoogleAIResponse;
    if (data.error) {
      logError("AI-PROVIDER", `Google response error: ${data.error.message}`);
      throw new Error(data.error.message);
    }

    // Check for prompt-level blocking
    if (data.promptFeedback?.blockReason) {
      logError(
        "AI-PROVIDER",
        "Google blocked prompt. Reason:",
        data.promptFeedback.blockReason,
        "Safety ratings:",
        data.promptFeedback.safetyRatings,
      );
      throw new Error(
        `AI blocked the prompt: ${data.promptFeedback.blockReason}`,
      );
    }

    // Check for blocked responses or empty candidates
    const candidate = data.candidates?.[0];
    if (!candidate) {
      logError(
        "AI-PROVIDER",
        "Google returned no candidates. Full response:",
        JSON.stringify(data, null, 2),
      );
      throw new Error(
        "AI returned no response - possibly blocked by safety filters",
      );
    }

    // Check for finish reason that indicates blocking
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      logError(
        "AI-PROVIDER",
        "Google response blocked. Reason:",
        candidate.finishReason,
        "Safety ratings:",
        candidate.safetyRatings,
      );
      throw new Error(`AI response blocked: ${candidate.finishReason}`);
    }

    const text = candidate.content?.parts?.[0]?.text ?? "";
    if (!text) {
      logError(
        "AI-PROVIDER",
        "Google returned empty text. Candidate:",
        JSON.stringify(candidate, null, 2),
      );
      throw new Error("AI returned empty response");
    }

    debugAIProvider(
      `Google response: status=${response.status}, length=${text.length}`,
    );
    debugAIResponse(`--- RESPONSE START (${text.length} chars) ---`);
    debugAIResponse(text);
    debugAIResponse(`--- RESPONSE END ---`);
    return text;
  }

  // OpenAI API
  if (provider === "openai") {
    const fullEndpoint = `${endpoint}/chat/completions`;
    debugAIProvider(`Calling OpenAI API: endpoint=${fullEndpoint}`);

    const response = await fetch(fullEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: temp,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError(
        "AI-PROVIDER",
        `OpenAI API error: status=${response.status}, body=${errorText}`,
      );
      if (response.status === 429) {
        debugAIProvider("OpenAI rate limit hit, throwing AI_RATE_LIMITED");
        throw new AppError(
          "AI_RATE_LIMITED",
          "AI service is busy. Please try again in a few moments.",
          429,
        );
      }
      throw new AppError(
        "AI_SERVICE_UNAVAILABLE",
        "AI service is temporarily unavailable. Please try again later.",
        503,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    debugAIProvider(
      `OpenAI response: status=${response.status}, length=${text.length}`,
    );
    debugAIResponse(`--- RESPONSE START (${text.length} chars) ---`);
    debugAIResponse(text);
    debugAIResponse(`--- RESPONSE END ---`);
    return text;
  }

  // Anthropic API
  if (provider === "anthropic") {
    const fullEndpoint = `${endpoint}/messages`;
    debugAIProvider(`Calling Anthropic API: endpoint=${fullEndpoint}`);

    const response = await fetch(fullEndpoint, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        temperature: temp,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError(
        "AI-PROVIDER",
        `Anthropic API error: status=${response.status}, body=${errorText}`,
      );
      if (response.status === 429) {
        debugAIProvider("Anthropic rate limit hit, throwing AI_RATE_LIMITED");
        throw new AppError(
          "AI_RATE_LIMITED",
          "AI service is busy. Please try again in a few moments.",
          429,
        );
      }
      throw new AppError(
        "AI_SERVICE_UNAVAILABLE",
        "AI service is temporarily unavailable. Please try again later.",
        503,
      );
    }

    const data = (await response.json()) as {
      content?: Array<{ text?: string }>;
    };
    const text = data.content?.[0]?.text ?? "";
    debugAIProvider(
      `Anthropic response: status=${response.status}, length=${text.length}`,
    );
    debugAIResponse(`--- RESPONSE START (${text.length} chars) ---`);
    debugAIResponse(text);
    debugAIResponse(`--- RESPONSE END ---`);
    return text;
  }

  // This should never happen due to TypeScript type checking, but just in case
  logError("AI-PROVIDER", `Unsupported AI provider: ${provider}`);
  throw new Error(`Unsupported AI provider: ${provider}`);
}

/**
 * Call AI for a specific operation type (automatically selects the appropriate model tier)
 * @param prompt - The prompt to send to the AI
 * @param operation - The type of AI operation being performed
 * @param options - Additional options (temperature)
 */
export async function callAIForOperation(
  prompt: string,
  operation: AIOperationType,
  options?: { temperature?: number },
): Promise<string> {
  const modelTier = getAIModelTier(operation);
  return callAI(prompt, { modelTier, temperature: options?.temperature });
}

/**
 * Clean markdown code blocks from AI response (exported for reuse)
 */
export function cleanMarkdownBlocks(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/```(?:json|html)?\n?/g, "")
      .replace(/```$/g, "")
      .trim();
  }
  return cleaned;
}

/**
 * Generate a mkly template source using AI with customization options.
 * Returns raw mkly source code that uses newsletter kit blocks.
 */
export async function generateMklyTemplate(
  streamName: string,
  categories: Category[],
  customization?: TemplateCustomization,
  contentItems?: ContentItem[],
): Promise<string> {
  debugAITemplate("Starting mkly template generation");
  debugAITemplate("Stream name:", streamName);
  debugAITemplate("Categories:", categories.join(", "));

  // Import mkly AI utilities (runtime dynamic imports from monorepo sibling)
  // @ts-expect-error -- monorepo sibling import resolved by Bun at runtime
  const { buildMklySystemPrompt, validateMkly, cleanStyleSlop } = await import("../../milkly-mklyml/mkly/src/ai/index");
  // @ts-expect-error -- monorepo sibling import resolved by Bun at runtime
  const { NEWSLETTER_SCHEMAS, NEWSLETTER_THEMES, NEWSLETTER_PRESETS } = await import("../../milkly-mklyml/mkly-kits/newsletter/src/index");

  // Build mkly system prompt with newsletter kit schemas
  const mklySystemPrompt = buildMklySystemPrompt({
    extraSchemas: NEWSLETTER_SCHEMAS,
    includeExamples: true,
    includeAntiPatterns: true,
  });

  // Collect available theme and preset names for the AI prompt
  const themeNames = (NEWSLETTER_THEMES as Array<{ name: string }>).map((t: { name: string }) => `newsletter/${t.name}`);
  const presetNames = (NEWSLETTER_PRESETS as Array<{ name: string }>).map((p: { name: string }) => `newsletter/${p.name}`);

  // Build customization context
  const customParts: string[] = [];
  if (customization?.brandName) customParts.push(`Brand: "${customization.brandName}"`);
  if (customization?.tagline) customParts.push(`Tagline: "${customization.tagline}"`);
  if (customization?.description) customParts.push(`Description: "${customization.description}"`);
  if (customization?.audience) customParts.push(`Audience: ${customization.audience}`);
  if (customization?.tone) customParts.push(`Tone: ${customization.tone}`);
  if (customization?.primaryColor) customParts.push(`Primary color: ${customization.primaryColor}`);
  if (customization?.accentColor) customParts.push(`Accent color: ${customization.accentColor}`);
  if (customization?.includeFooterCTA !== undefined)
    customParts.push(`Footer CTA: ${customization.includeFooterCTA ? "yes" : "no"}`);
  if (customization?.footerCTAText) customParts.push(`CTA text: "${customization.footerCTAText}"`);

  const effectiveCategories = categories.length > 0
    ? categories
    : (["news", "videos", "custom"] as Category[]);

  const prompt = `${mklySystemPrompt}

---

Generate a newsletter template as a complete mkly document for "${streamName}".

REQUIREMENTS:
- Start with --- meta block (version: 1, title, subject)
- Include --- use: core to activate core blocks (heading, text, image, button, divider, spacer, footer, etc.)
- Include --- use: newsletter to activate newsletter kit blocks (intro, featured, category, item, quickHits, outro, etc.)
- Include --- preset: with one of these presets: ${presetNames.join(", ")} (presets provide typography and spacing)
- Include --- theme: with one of these themes: ${themeNames.join(", ")} (themes provide colors and visual identity)
- Include a --- style block AFTER the preset/theme to customize colors and override styles as needed
- Use newsletter kit blocks for structure (--- newsletter/intro, --- newsletter/featured, --- newsletter/category, --- newsletter/item, --- newsletter/quickHits, --- newsletter/outro)
- Use core blocks where appropriate (--- core/heading, --- core/text, --- core/divider, --- core/spacer, --- core/footer)
- IMPORTANT: Use --- core/header for the document header (NOT newsletter/header — that block does not exist)
- IMPORTANT: Do NOT use placeholder image URLs (no placekitten.com, via.placeholder.com, placehold.it, etc.). For image properties, use empty string "" or omit the image property entirely. The user will add real images later.
- Content categories available: ${effectiveCategories.join(", ")}
- The template should be a complete, compilable mkly document
- Use the REAL CONTENT provided below (if available) as sample data in the template. Use actual titles, descriptions, sources, and image URLs from the content items. If no content items are provided, use realistic placeholder text relevant to "${streamName}"

DOCUMENT STRUCTURE (in this order):
1. --- meta (version, title, subject)
2. --- use: core
3. --- use: newsletter
4. --- preset: newsletter/default (or another preset from the list)
5. --- theme: newsletter/default (or another theme from the list)
6. --- style (custom overrides — keep minimal, let the preset/theme do most styling)
7. Content blocks (--- core/header, --- newsletter/intro, --- newsletter/featured, etc.)
${customParts.length > 0 ? `\nCUSTOMIZATION:\n${customParts.join("\n")}` : ""}
${customization?.customPrompt ? `\nADDITIONAL INSTRUCTIONS:\n${customization.customPrompt}` : ""}
${contentItems && contentItems.length > 0 ? `\nREAL CONTENT ITEMS (use these as sample data in the template):\n${contentItems.map((item, i) => {
  const parts = [`${i + 1}. [${item.category.toUpperCase()}] "${item.title}" from ${item.source}`];
  if (item.description) parts.push(`   Description: ${item.description.substring(0, 200)}`);
  if (item.imageUrl) parts.push(`   Image: ${item.imageUrl}`);
  if (item.url) parts.push(`   URL: ${item.url}`);
  if (item.author) parts.push(`   Author: ${item.author}`);
  return parts.join("\n");
}).join("\n")}` : ""}

OUTPUT: Return ONLY the raw mkly source code. No markdown code fences, no explanation.`;

  debugAIPrompt("Mkly template prompt length:", prompt.length, "chars");

  try {
    let mklySource = await callAIForOperation(prompt, "templateGeneration", {
      temperature: AI.TEMPERATURES.TEMPLATE_GENERATION,
    });

    mklySource = cleanMarkdownBlocks(mklySource);

    // Basic validation: must contain at least one block
    if (!mklySource.includes("---")) {
      debugAITemplate("AI returned invalid mkly source (no blocks), using fallback");
      return createDefaultMklyTemplate(streamName, effectiveCategories, customization);
    }

    // Validate → retry loop: up to MAX_RETRIES attempts to fix issues
    let bestSource = mklySource;
    let bestErrorCount = Infinity;

    for (let attempt = 1; attempt <= AI.MAX_VALIDATION_RETRIES; attempt++) {
      const validation = validateMkly(bestSource, { extraSchemas: NEWSLETTER_SCHEMAS });

      // Clean pass — no issues at all
      if (validation.valid && !validation.feedback) {
        debugAITemplate(`Attempt ${attempt}: validation clean`);
        break;
      }

      const label = validation.valid ? 'warnings' : 'errors';
      debugAITemplate(`Attempt ${attempt}: ${label} (${validation.errors.length} issues), retrying`);
      debugAITemplate("Feedback:", validation.feedback);

      const retryPrompt = validation.valid
        ? `The mkly document you generated has warnings that should be fixed. Please fix them and return the corrected document.

WARNINGS:
${validation.feedback}

ORIGINAL DOCUMENT:
${bestSource}

Fix all the warnings above and return ONLY the corrected raw mkly source code. No markdown code fences, no explanation.`
        : `The mkly document you generated has validation errors. Please fix them and return the corrected document.

ERRORS:
${validation.feedback}

ORIGINAL DOCUMENT:
${bestSource}

Fix all the errors above and return ONLY the corrected raw mkly source code. No markdown code fences, no explanation.`;

      let retrySource = await callAIForOperation(retryPrompt, "templateGeneration", {
        temperature: AI.TEMPERATURES.TEMPLATE_GENERATION,
      });
      retrySource = cleanMarkdownBlocks(retrySource);

      const retryValidation = validateMkly(retrySource, { extraSchemas: NEWSLETTER_SCHEMAS });

      // Perfect fix — use it
      if (retryValidation.valid && !retryValidation.feedback) {
        debugAITemplate(`Retry ${attempt} succeeded: clean output`);
        bestSource = retrySource;
        bestErrorCount = 0;
        break;
      }

      // Use retry if it improved
      if (retryValidation.errors.length < validation.errors.length ||
          (retryValidation.valid && retrySource.includes("---"))) {
        debugAITemplate(`Retry ${attempt} improved: ${retryValidation.errors.length} → from ${validation.errors.length}`);
        bestSource = retrySource;
        bestErrorCount = retryValidation.errors.length;
      } else {
        debugAITemplate(`Retry ${attempt} didn't improve (${retryValidation.errors.length} issues)`);
        if (bestErrorCount === Infinity) bestErrorCount = validation.errors.length;
      }
    }

    // Final cleanup: strip any remaining style slop
    debugAITemplate(`Final output: ${bestSource.length} chars, ${bestErrorCount} remaining issues, cleaning slop`);
    return cleanStyleSlop(bestSource);
  } catch (error) {
    debugAITemplate("Mkly template generation failed, using fallback");
    logError("AI-TEMPLATE", "Error generating mkly template:", getErrorMessage(error));
    return createDefaultMklyTemplate(streamName, effectiveCategories, customization);
  }
}

/**
 * Create a default mkly template when AI generation fails
 */
function createDefaultMklyTemplate(
  streamName: string,
  categories: Category[],
  customization?: TemplateCustomization,
): string {
  const primary = customization?.primaryColor || "#1a1a2e";
  const accent = customization?.accentColor || "#e2725b";
  const tone = customization?.tone || "professional";
  const brandName = customization?.brandName || streamName;

  const categoryBlocks = categories
    .map((cat) => `--- newsletter/category\ncategory: ${cat}\nheading: ${cat.charAt(0).toUpperCase() + cat.slice(1)}`)
    .join("\n\n");

  return `--- meta
title: ${brandName} Newsletter

--- use: core

--- use: newsletter

--- style
accent: ${accent}
primary: ${primary}

--- newsletter/intro

Welcome to ${brandName} — your curated roundup of the latest content.

--- newsletter/featured
heading: Featured

${categoryBlocks}

--- newsletter/outro

Thanks for reading! Stay tuned for more updates.`;
}

/**
 * Build rich context string for a single item, including extracted article content
 */
function buildItemContext(
  item: ContentItem,
  idx: number,
  extractedContent?: ExtractedContent | null,
): string {
  const parts: string[] = [];
  parts.push(
    `${idx + 1}. [ID: ${item.id}] "${item.title}" from ${item.source} (${item.category})`,
  );
  parts.push(`   URL: ${item.url}`);

  if (item.author) {
    parts.push(`   Author: ${item.author}`);
  } else if (extractedContent?.byline) {
    parts.push(`   Author: ${extractedContent.byline}`);
  }

  if (item.publishedAt) {
    parts.push(
      `   Published: ${new Date(item.publishedAt).toLocaleDateString()}`,
    );
  } else if (extractedContent?.publishedTime) {
    parts.push(
      `   Published: ${new Date(extractedContent.publishedTime).toLocaleDateString()}`,
    );
  }

  if (item.description) {
    parts.push(`   Summary: ${item.description.substring(0, 300)}`);
  } else if (extractedContent?.excerpt) {
    parts.push(`   Summary: ${extractedContent.excerpt.substring(0, 300)}`);
  }

  if (extractedContent?.textContent) {
    parts.push(`   FULL ARTICLE TEXT:\n   ${extractedContent.textContent}`);
  }

  return parts.join("\n");
}

/**
 * Generate AI notes for each content item
 * Fetches and extracts content from URLs to give AI full article context
 */
export async function generateItemNotes(
  items: ContentItem[],
  streamName: string,
): Promise<GeneratedNote[]> {
  if (items.length === 0) return [];

  // Enrich items with extracted URL content
  const enrichedItems = await enrichItemsWithContent(items);

  const itemsContext = enrichedItems
    .map((item, idx) =>
      buildItemContext(items[idx]!, idx, item.extractedContent),
    )
    .join("\n\n");

  const prompt = getItemNotesPrompt({
    streamName,
    itemsContext,
  });

  try {
    const text = await callAIForOperation(prompt, "notesGeneration", {
      temperature: AI.TEMPERATURES.ITEM_NOTES,
    });
    const jsonText = cleanMarkdownBlocks(text);
    const notes = JSON.parse(jsonText) as GeneratedNote[];
    return notes;
  } catch (error) {
    debugAIContent("Item notes generation failed, falling back to empty notes");
    logError(
      "AI-CONTENT",
      "Error generating item notes:",
      getErrorMessage(error),
    );
    return items.map((item) => ({
      itemId: item.id,
      note: "",
    }));
  }
}

/**
 * Generate polished newsletter content using AI
 * Content is grouped by category with different styling
 */
export interface GenerateContentOptions {
  templateId?: string;
  templateType?: "stream" | "linkedStream";
  userId?: string;
}

export async function generateNewsletterContent(
  mklySource: string,
  items: ContentItem[],
  streamName: string,
  newsletterTitle?: string,
  itemNotes?: Record<string, string>,
  options?: GenerateContentOptions,
): Promise<string> {
  const { extractMklyStyleVars, extractMklyMeta, extractMklySections } =
    await import("./mkly-utils");

  const styleVars = extractMklyStyleVars(mklySource);
  const meta = extractMklyMeta(mklySource);
  const sections = extractMklySections(mklySource);

  const primaryColor = styleVars.primary || "#4A3728";
  const accentColor = styleVars.accent || "#D4A574";
  const tone = styleVars.tone || "professional";

  debugAIContent("Starting newsletter content generation");
  debugAIContent("Template: mkly source", mklySource.length, "chars");
  debugAIContent("- Sections:", sections.length);
  debugAIContent("- Tone:", tone);
  debugAIContent("- Colors:", primaryColor, accentColor);
  debugAIContent("Items count:", items.length);

  // Log item categories
  const categoriesPresent = [...new Set(items.map((item) => item.category))];
  debugAIContent("Categories present:", categoriesPresent.join(", "));

  // Build content context as a flat ordered list preserving curator's selection order
  const contentContext = items
    .map((item, idx) => {
      const note = itemNotes?.[item.id] || "";
      const imageInfo = item.imageUrl ? `\n   IMAGE: ${item.imageUrl}` : "";
      const authorInfo = item.author ? ` by ${item.author}` : "";
      const publishedInfo = item.publishedAt
        ? `\n   Published: ${new Date(item.publishedAt).toLocaleDateString()}`
        : "";
      return `${idx + 1}. [${item.category.toUpperCase()}] "${item.title}"${authorInfo} from ${item.source} (${item.url})${item.description ? ` - ${item.description.substring(0, AI.MAX_DESCRIPTION_LENGTH)}` : ""}${imageInfo}${publishedInfo}${note ? `\n   CURATOR NOTE: ${note}` : ""}`;
    })
    .join("\n");

  // Build style context from learned preferences
  let styleContextStr: string | undefined;
  if (options?.templateId && options?.templateType && options?.userId) {
    try {
      const { getStyleContext, formatStyleContextForPrompt } =
        await import("./style-learning");
      const styleCtx = await getStyleContext(
        options.templateId,
        options.templateType,
        options.userId,
      );
      if (styleCtx) {
        styleContextStr = formatStyleContextForPrompt(styleCtx);
        debugAIContent(
          "Style context injected:",
          styleContextStr.length,
          "chars",
        );
      }
    } catch (err) {
      logError(
        "AI-CONTENT",
        "Style context lookup failed, continuing without:",
        err,
      );
    }
  }

  const title =
    newsletterTitle ||
    meta.title ||
    `${streamName} Newsletter`;

  const outroSection = sections.find(
    (s) => s.type === "outro" && s.style === "cta",
  );

  const prompt = getNewsletterContentPrompt({
    title,
    streamName,
    mklyTemplate: mklySource,
    contentContext,
    primaryColor,
    accentColor,
    tone,
    logoUrl: undefined,
    tagline: meta.tagline,
    voiceDescription: undefined,
    footerCTAText: outroSection ? "Share With a Friend" : undefined,
    sections: sections.map((s) => ({
      type: s.type,
      heading: s.heading,
      maxItems: s.maxItems,
      style: s.style,
    })),
    styleContext: styleContextStr,
  });

  debugAIPrompt("Content prompt length:", prompt.length, "chars");

  try {
    let html = await callAIForOperation(prompt, "previewGeneration", {
      temperature: AI.TEMPERATURES.NEWSLETTER_CONTENT,
    });

    html = cleanMarkdownBlocks(html);
    return html;
  } catch (error) {
    debugAIContent(
      "Newsletter content generation failed, falling back to default content",
    );
    logError("AI-CONTENT", "Error generating content:", getErrorMessage(error));
    return generateFallbackContent(
      mklySource,
      items,
      streamName,
      newsletterTitle,
      itemNotes,
    );
  }
}

/**
 * Generate basic HTML content when AI generation fails or is not available
 * This is exported so it can be used directly when AI is not configured
 */
export function generateFallbackContent(
  mklySource: string,
  items: ContentItem[],
  streamName: string,
  newsletterTitle?: string,
  itemNotes?: Record<string, string>,
): string {
  // Inline extraction to avoid async import in sync function
  const styleVars: Record<string, string> = {};
  const styleMatch = mklySource.match(/^--- style\s*\n([\s\S]*?)(?=\n---|\s*$)/m);
  if (styleMatch?.[1]) {
    for (const line of styleMatch[1].split("\n")) {
      const kv = line.match(/^([a-zA-Z]\w*)\s*:\s*(.+)$/);
      if (kv?.[1] && kv[2] && !kv[1].includes("/")) styleVars[kv[1]] = kv[2].trim();
    }
  }
  const metaVars: Record<string, string> = {};
  const metaMatch = mklySource.match(/^--- meta\s*\n([\s\S]*?)(?=\n---|\s*$)/m);
  if (metaMatch?.[1]) {
    for (const line of metaMatch[1].split("\n")) {
      const kv = line.match(/^([a-zA-Z]\w*)\s*:\s*(.+)$/);
      if (kv?.[1] && kv[2]) metaVars[kv[1]] = kv[2].trim();
    }
  }

  const primary = styleVars.primary || "#4A3728";
  const accent = styleVars.accent || "#D4A574";
  const title = newsletterTitle || metaVars.title || `${streamName} Newsletter`;

  // Extract sections from newsletter blocks
  const sectionRegex = /^--- newsletter\/(\w+)\s*\n((?:[a-zA-Z]\w*:\s*.+\n)*)/gm;
  const sections: Array<{ type: string; heading?: string; category?: string; maxItems?: number; style?: string }> = [];
  let sMatch: RegExpExecArray | null;
  while ((sMatch = sectionRegex.exec(mklySource)) !== null) {
    const sec: (typeof sections)[0] = { type: sMatch[1]! };
    for (const line of sMatch[2]!.split("\n")) {
      const kv = line.match(/^([a-zA-Z]\w*)\s*:\s*(.+)$/);
      if (!kv) continue;
      const [, k, v] = kv;
      if (k && v) {
        if (k === "heading") sec.heading = v.trim();
        if (k === "category") sec.category = v.trim();
        if (k === "maxItems") sec.maxItems = parseInt(v.trim(), 10) || undefined;
        if (k === "style") sec.style = v.trim();
      }
    }
    sections.push(sec);
  }

  // Group items by category
  const itemsByCategory = items.reduce<Record<string, ContentItem[]>>(
    (acc, item) => {
      if (!acc[item.category]) acc[item.category] = [];
      acc[item.category]!.push(item);
      return acc;
    },
    {},
  );

  let html = `<div style="max-width:600px;margin:0 auto;padding:0 24px;">\n`;
  html += `<h1 style="color: ${primary}; font-size: 2em; margin-bottom: 8px;">${title}</h1>\n`;

  for (const section of sections) {
    const heading = section.heading || section.type;

    switch (section.type) {
      case "intro":
        html += `<p style="color: #666; margin-bottom: 24px;">Your curated roundup of the best content from ${streamName}.</p>\n`;
        break;

      case "featured": {
        const featuredItem = items[0];
        if (featuredItem) {
          html += `<h2 style="color: ${accent};">${heading}</h2>\n`;
          if (featuredItem.imageUrl) {
            html += `<img src="${featuredItem.imageUrl}" alt="" style="width:100%;border-radius:12px;margin:16px 0;" />\n`;
          }
          html += `<a href="${featuredItem.url}" style="color: ${primary}; font-weight: bold; font-size: 1.2em;">${featuredItem.title}</a>\n`;
          if (featuredItem.description) {
            html += `<p style="margin-top: 8px;">${featuredItem.description.substring(0, UI.TRUNCATE_DESCRIPTION_LENGTH)}</p>\n`;
          }
        }
        break;
      }

      case "category": {
        if (!section.category) break;
        const sectionItems = itemsByCategory[section.category] || [];
        const maxItems = section.maxItems || NEWSLETTER.TEMPLATE.DEFAULT_MAX_ITEMS;
        const displayItems = sectionItems.slice(0, maxItems);

        if (displayItems.length > 0) {
          html += `<h2 style="color: ${accent};">${heading}</h2>\n`;
          for (const item of displayItems) {
            const note = itemNotes?.[item.id];
            html += `<article style="margin-bottom: 16px; padding: 12px; border-left: 3px solid ${accent};">\n`;
            html += `  <a href="${item.url}" style="color: ${primary}; font-weight: bold; font-size: 1.1em;">${item.title}</a>\n`;
            html += `  <div style="color: #666; font-size: 0.85em; margin-top: 4px;">${item.source}</div>\n`;
            if (item.description) {
              html += `  <p style="margin-top: 8px;">${item.description.substring(0, UI.TRUNCATE_DESCRIPTION_LENGTH)}</p>\n`;
            }
            if (note) {
              html += `  <p style="font-style: italic; color: ${accent}; margin-top: 8px;">${note}</p>\n`;
            }
            html += `</article>\n`;
          }
        }
        break;
      }

      case "quickHits": {
        const maxItems = section.maxItems || 5;
        const quickItems = items.slice(0, maxItems);
        if (quickItems.length > 0) {
          html += `<h2 style="color: ${accent};">${heading}</h2>\n`;
          html += `<ul style="padding-left: 16px;">\n`;
          for (const item of quickItems) {
            html += `  <li style="margin-bottom: 8px;"><a href="${item.url}" style="color: ${primary}; font-weight: bold;">${item.title}</a> <span style="color: #666;">- ${item.source}</span></li>\n`;
          }
          html += `</ul>\n`;
        }
        break;
      }

      case "outro":
        html += `<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 32px 0;" />\n`;
        html += `<p style="color: ${accent};">Stay tuned for more updates!</p>\n`;
        break;

      default:
        html += `<h2 style="color: ${accent};">${heading}</h2>\n`;
        break;
    }
  }

  html += `</div>\n`;
  return html;
}

/**
 * Generate search keywords for a stream using AI
 */
export async function generateStreamKeywords(
  streamName: string,
  description?: string,
): Promise<string[]> {
  const prompt = getKeywordsPrompt({ streamName, description });

  try {
    const response = await callAIForOperation(prompt, "keywordGeneration", {
      temperature: AI.TEMPERATURES.KEYWORDS,
    });
    const cleaned = cleanMarkdownBlocks(response);

    // Try to extract JSON array from response
    const jsonMatch = cleaned.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      throw new Error("No JSON array found in response");
    }

    const keywords = JSON.parse(jsonMatch[0]);

    if (
      Array.isArray(keywords) &&
      keywords.every((k) => typeof k === "string")
    ) {
      // Clean and filter keywords
      const validKeywords = keywords
        .map((k) => k.trim())
        .filter((k) => {
          // Filter out empty, too long, or matches stream name
          if (k.length === 0 || k.length > 30) return false;
          if (k.toLowerCase() === streamName.toLowerCase()) return false;
          return true;
        })
        .slice(0, 8);

      if (validKeywords.length >= 3) {
        return validKeywords;
      }
    }

    throw new Error("Invalid response format or not enough valid keywords");
  } catch (error) {
    logError(
      "AI-CONTENT",
      "Error generating keywords:",
      getErrorMessage(error),
    );
    // Re-throw the error so the API returns an error to the user
    // instead of silently returning bad keywords
    throw error;
  }
}
