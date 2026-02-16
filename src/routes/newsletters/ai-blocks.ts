import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../prisma";
import { isAIConfigured, callAI, cleanMarkdownBlocks } from "../../services/ai";
import { checkAICredits, deductAICredits } from "../../middleware/tier-limits";
import { requireAuth, type AuthVariables } from "../../middleware/auth";
import { validate } from "../../middleware/validation";
import { AI } from "../../config";
import { logError } from "../../lib/debug";

const aiBlocksRouter = new Hono<{ Variables: AuthVariables }>();

// Block types supported for regeneration
const BlockTypeSchema = z.enum([
  "contentItem",
  "sectionHeader",
  "newsletterHeader",
  "paragraph",
]);
export type BlockType = z.infer<typeof BlockTypeSchema>;

// Content structure for each block type
const ContentItemContentSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  note: z.string().optional(),
  url: z.string().optional(),
  source: z.string().optional(),
});

const SectionHeaderContentSchema = z.object({
  heading: z.string().optional(),
});

const NewsletterHeaderContentSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
});

const ParagraphContentSchema = z.object({
  text: z.string().optional(),
});

// Combined current content schema
const CurrentContentSchema = z.union([
  ContentItemContentSchema,
  SectionHeaderContentSchema,
  NewsletterHeaderContentSchema,
  ParagraphContentSchema,
]);

// Request schema for block regeneration
export const RegenerateBlockSchema = z.object({
  blockId: z.string().min(1, "Block ID is required"),
  blockType: BlockTypeSchema,
  currentContent: CurrentContentSchema,
  context: z.string().optional(),
});
export type RegenerateBlockInput = z.infer<typeof RegenerateBlockSchema>;

// Response schema for regenerated content
export const RegeneratedBlockSchema = z.object({
  blockId: z.string(),
  regeneratedContent: z.record(z.string(), z.unknown()),
});
export type RegeneratedBlock = z.infer<typeof RegeneratedBlockSchema>;

// Generate prompt based on block type
function getBlockRegenerationPrompt(
  blockType: BlockType,
  currentContent: z.infer<typeof CurrentContentSchema>,
  context?: string,
): string {
  const contextSection = context ? `\n\nSURROUNDING CONTEXT:\n${context}` : "";

  switch (blockType) {
    case "contentItem": {
      const content = currentContent as z.infer<
        typeof ContentItemContentSchema
      >;
      return `You are a newsletter content writer. Regenerate the following content item with fresh, engaging copy while maintaining the same meaning and intent.

CURRENT CONTENT:
${content.title ? `Title: ${content.title}` : ""}
${content.description ? `Description: ${content.description}` : ""}
${content.note ? `Note: ${content.note}` : ""}
${content.source ? `Source: ${content.source}` : ""}
${contextSection}

INSTRUCTIONS:
- Rewrite the content to be more engaging and compelling
- Maintain the same core information and meaning
- Keep the same approximate length
- Use a professional but approachable tone
- Return ONLY a valid JSON object with the regenerated fields

Return a JSON object with ONLY the fields that were provided (title, description, note):
{
  "title": "regenerated title if title was provided",
  "description": "regenerated description if description was provided",
  "note": "regenerated note if note was provided"
}`;
    }

    case "sectionHeader": {
      const content = currentContent as z.infer<
        typeof SectionHeaderContentSchema
      >;
      return `You are a newsletter content writer. Regenerate this section heading with a fresh, engaging alternative.

CURRENT HEADING: ${content.heading || "Untitled Section"}
${contextSection}

INSTRUCTIONS:
- Create an engaging, attention-grabbing heading
- Keep it concise (2-6 words typically)
- Maintain the same topic/theme
- Return ONLY a valid JSON object

Return a JSON object:
{
  "heading": "regenerated heading text"
}`;
    }

    case "newsletterHeader": {
      const content = currentContent as z.infer<
        typeof NewsletterHeaderContentSchema
      >;
      return `You are a newsletter content writer. Regenerate this newsletter header with fresh copy.

CURRENT HEADER:
${content.title ? `Title: ${content.title}` : ""}
${content.subtitle ? `Subtitle: ${content.subtitle}` : ""}
${contextSection}

INSTRUCTIONS:
- Create compelling header text that draws readers in
- Keep the title punchy and memorable
- The subtitle should provide context or intrigue
- Return ONLY a valid JSON object with the regenerated fields

Return a JSON object with ONLY the fields that were provided:
{
  "title": "regenerated title if title was provided",
  "subtitle": "regenerated subtitle if subtitle was provided"
}`;
    }

    case "paragraph": {
      const content = currentContent as z.infer<typeof ParagraphContentSchema>;
      return `You are a newsletter content writer. Regenerate this paragraph with fresh, engaging copy.

CURRENT TEXT:
${content.text || ""}
${contextSection}

INSTRUCTIONS:
- Rewrite the paragraph to be more engaging and readable
- Maintain the same core message and information
- Keep approximately the same length
- Use clear, compelling language
- Return ONLY a valid JSON object

Return a JSON object:
{
  "text": "regenerated paragraph text"
}`;
    }
  }
}

// POST /newsletters/:id/regenerate-block - regenerate a single block's content with AI
aiBlocksRouter.post(
  "/newsletters/:id/regenerate-block",
  requireAuth,
  validate("json", RegenerateBlockSchema),
  async (c) => {
    const user = c.get("user")!;
    const newsletterId = c.req.param("id");
    const input = c.req.valid("json");

    // Check if AI is configured
    if (!isAIConfigured()) {
      return c.json(
        {
          error: {
            message:
              "AI content generation is not configured. Please set your Google API key in the ENV tab.",
            code: "AI_NOT_CONFIGURED",
          },
        },
        400,
      );
    }

    // Check AI credits for block regeneration (5 credits)
    const creditCheck = await checkAICredits(user.id, "blockRegeneration");
    if (!creditCheck.allowed) {
      return c.json(
        {
          error: {
            code: "LIMIT_EXCEEDED",
            message: `Insufficient AI credits. This operation requires ${creditCheck.cost} credits.`,
            limit: "aiCredits",
            current: creditCheck.current,
            max: creditCheck.limit,
            cost: creditCheck.cost,
            resetAt: creditCheck.resetAt.toISOString(),
            upgradeUrl: "/pricing",
          },
        },
        403,
      );
    }

    // Verify newsletter ownership
    const newsletter = await prisma.newsletter.findFirst({
      where: {
        id: newsletterId,
        userId: user.id,
      },
      select: {
        id: true,
        title: true,
      },
    });

    if (!newsletter) {
      return c.json(
        { error: { message: "Newsletter not found", code: "NOT_FOUND" } },
        404,
      );
    }

    try {
      // Generate the prompt based on block type
      const prompt = getBlockRegenerationPrompt(
        input.blockType,
        input.currentContent,
        input.context,
      );

      // Call AI with block regeneration temperature
      const response = await callAI(prompt, AI.TEMPERATURES.BLOCK_REGENERATION);
      const cleanedResponse = cleanMarkdownBlocks(response);

      // Parse the JSON response
      let regeneratedContent: Record<string, unknown>;
      try {
        regeneratedContent = JSON.parse(cleanedResponse);
      } catch {
        logError("AI-Blocks", "Failed to parse AI response:", cleanedResponse);
        return c.json(
          {
            error: {
              message: "Failed to parse AI response",
              code: "AI_PARSE_ERROR",
            },
          },
          500,
        );
      }

      // Deduct AI credits for block regeneration
      await deductAICredits(user.id, "blockRegeneration");

      return c.json({
        data: {
          blockId: input.blockId,
          regeneratedContent,
        },
      });
    } catch (error) {
      logError("AI-Blocks", "Error regenerating block content:", error);

      const errorMessage =
        error instanceof Error && error.message === "AI_SERVICE_UNAVAILABLE"
          ? "AI service is temporarily unavailable"
          : "Failed to regenerate block content";

      return c.json(
        {
          error: {
            message: errorMessage,
            code: "AI_GENERATION_FAILED",
          },
        },
        500,
      );
    }
  },
);

export { aiBlocksRouter };
