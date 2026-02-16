import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import {
  requireAICredits,
  deductCreditsFromContext,
} from "../middleware/tier-limits";
import { connectorRegistry } from "../connectors";
import {
  generateNewsletterContent,
  generateFallbackContent,
  isAIConfigured,
} from "../services/ai";
import { buildDefaultMklySource } from "../services/mkly-utils";
import { type Category, type ContentItem } from "../types";
import { logError } from "../lib/debug";

export const aiGenerateRouter = new Hono<{ Variables: AuthVariables }>();

// Schema for AI generation request
const AIGenerateSchema = z.object({
  prompt: z.string().min(5).max(500),
  categories: z
    .array(z.enum(["news", "videos", "social"]))
    .min(1)
    .default(["news"]),
  autoPublish: z.boolean().default(false),
});

// Transform DB content item to API content item
function transformContentItem(dbItem: {
  id: string;
  title: string;
  url: string;
  description: string | null;
  imageUrl: string | null;
  source: string;
  category: string;
  author: string | null;
  publishedAt: Date | null;
  metadata: string | null;
  streamId: string;
  createdAt: Date;
  batchId?: string | null;
  fetchedAt?: Date;
  isCustomItem?: boolean;
}): ContentItem {
  return {
    id: dbItem.id,
    title: dbItem.title,
    url: dbItem.url,
    description: dbItem.description,
    imageUrl: dbItem.imageUrl,
    rawImageUrl: dbItem.imageUrl, // Keep original for editing (media:// refs)
    source: dbItem.source,
    category: dbItem.category as Category,
    author: dbItem.author,
    publishedAt: dbItem.publishedAt,
    metadata: dbItem.metadata ? JSON.parse(dbItem.metadata) : null,
    streamId: dbItem.streamId,
    createdAt: dbItem.createdAt,
    batchId: dbItem.batchId ?? null,
    fetchedAt: dbItem.fetchedAt ?? dbItem.createdAt,
    isCustomItem: dbItem.isCustomItem ?? false,
  };
}

// POST /api/ai/generate - Generate newsletter from a prompt
aiGenerateRouter.post(
  "/generate",
  requireAuth,
  requireAICredits("aiGenerateFull"),
  zValidator("json", AIGenerateSchema),
  async (c) => {
    const user = c.get("user")!;
    const { prompt, categories, autoPublish } = c.req.valid("json");

    try {
      // Step 1: Create a new stream based on the prompt
      const stream = await prisma.stream.create({
        data: {
          name: prompt.slice(0, 100),
          description: `AI-generated stream for: ${prompt}`,
          categories: JSON.stringify(categories),
          sortPreference: "relevancy",
          userId: user.id,
        },
      });

      // Step 2: Milk it - fetch content from all selected categories using registry
      const batchId = `ai-${Date.now()}`;
      const allItems: ContentItem[] = [];

      // Fetch content from each category
      for (const category of categories) {
        try {
          const result = await connectorRegistry.fetchCategory(category, {
            keywords: [prompt],
            fallbackQuery: prompt,
            count: 10,
            sortBy: "relevancy",
          });

          if (result.items && result.items.length > 0) {
            // Save content items to DB
            for (const item of result.items) {
              const saved = await prisma.contentItem.create({
                data: {
                  title: item.title,
                  url: item.url,
                  description: item.description ?? null,
                  imageUrl: item.imageUrl ?? null,
                  source: item.source,
                  category: item.category,
                  author: item.author ?? null,
                  publishedAt: item.publishedAt ?? null,
                  metadata: item.metadata
                    ? JSON.stringify(item.metadata)
                    : null,
                  streamId: stream.id,
                  batchId,
                  fetchedAt: new Date(),
                },
              });
              allItems.push(transformContentItem(saved));
            }
          }
        } catch (err) {
          logError("AI-Generate", `Error fetching ${category}:`, err);
        }
      }

      if (allItems.length === 0) {
        // Clean up the empty stream
        await prisma.stream.delete({ where: { id: stream.id } });
        return c.json(
          {
            error: {
              message:
                "No content found for this prompt. Try a different stream.",
              code: "NO_CONTENT",
            },
          },
          400,
        );
      }

      // Step 3: Create a template
      const mklySource = buildDefaultMklySource(
        `AI Template for ${prompt.slice(0, 50)}`,
        categories as Category[],
      );

      const template = await prisma.template.create({
        data: {
          name: `AI Template for ${prompt.slice(0, 50)}`,
          mklySource,
          streamId: stream.id,
          isActive: true,
        },
      });

      // Step 4: Pick best items (top 3-5 per category)
      const selectedItems = allItems.slice(0, 15);

      // Step 5: Generate newsletter title and content
      const newsletterTitle = `${prompt} - ${new Date().toLocaleDateString()}`;
      let newsletterContent: string;

      if (isAIConfigured()) {
        try {
          newsletterContent = await generateNewsletterContent(
            mklySource,
            selectedItems,
            prompt,
            newsletterTitle,
          );
          await deductCreditsFromContext(c);
        } catch (err) {
          logError("AI-Generate", "AI generation failed, using fallback:", err);
          newsletterContent = generateFallbackContent(
            mklySource,
            selectedItems,
            prompt,
            newsletterTitle,
          );
        }
      } else {
        newsletterContent = generateFallbackContent(
          mklySource,
          selectedItems,
          prompt,
          newsletterTitle,
        );
      }

      // Step 6: Create the newsletter
      const newsletter = await prisma.newsletter.create({
        data: {
          title: newsletterTitle,
          content: newsletterContent,
          status: autoPublish ? "published" : "draft",
          publishedAt: autoPublish ? new Date() : null,
          userId: user.id,
          streamId: stream.id,
          streamName: stream.name,
          templateId: template.id,
          items: {
            create: selectedItems.map((item, index) => ({
              contentItemId: item.id,
              order: index,
            })),
          },
        },
        include: {
          items: {
            include: {
              contentItem: true,
            },
            orderBy: { order: "asc" },
          },
        },
      });

      return c.json({
        data: {
          stream: {
            id: stream.id,
            name: stream.name,
          },
          template: {
            id: template.id,
            name: template.name,
          },
          newsletter: {
            id: newsletter.id,
            title: newsletter.title,
            content: newsletter.content,
            status: newsletter.status,
            publishedAt: newsletter.publishedAt,
          },
          itemsCount: selectedItems.length,
          message: autoPublish
            ? "Newsletter generated and published!"
            : "Newsletter generated as draft. You can edit it in milkly.app",
        },
      });
    } catch (err) {
      logError("AI-Generate", "AI generation error:", err);
      return c.json(
        {
          error: {
            message: "Failed to generate newsletter",
            code: "GENERATION_FAILED",
          },
        },
        500,
      );
    }
  },
);

// GET /api/ai/status - Check if AI generation is available
aiGenerateRouter.get("/status", async (c) => {
  return c.json({
    data: {
      aiConfigured: isAIConfigured(),
      availableSources: ["news", "videos", "social"],
    },
  });
});
