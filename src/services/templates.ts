import { prisma } from "../prisma";
import { generateMklyTemplate } from "./ai";
import {
  parseCategories,
  type Category,
  type TemplateCustomization,
  type ContentItem,
} from "../types";
import { checkAICredits, deductAICredits } from "../middleware/tier-limits";
import crypto from "crypto";
import { createDebugger, logError } from "../lib/debug";

const debug = createDebugger("TEMPLATES-SERVICE");

// Common template type that works for both Stream templates and LinkedStream templates
export interface TemplateInfo {
  id: string;
  name: string;
  mklySource: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Parent reference (one will be set, can be null for global templates)
  streamId?: string | null;
  linkedStreamId?: string;
}

interface GenerateTemplateParams {
  userId: string;
  name: string;
  description?: string | null;
  categories: Category[];
  customization?: TemplateCustomization;
  setActive?: boolean; // If true, deactivate others and set this as active
  // One of these must be provided
  streamId?: string;
  linkedStreamId?: string;
}

/**
 * Generate and create a new template using AI
 */
export async function generateAndCreateTemplate(
  params: GenerateTemplateParams,
): Promise<TemplateInfo> {
  const {
    userId,
    name,
    description,
    categories,
    customization,
    setActive = false,
    streamId,
    linkedStreamId,
  } = params;

  debug(
    `generateAndCreateTemplate: userId=${userId}, name="${name}", streamId=${streamId}, linkedStreamId=${linkedStreamId}, setActive=${setActive}`,
  );
  debug(`generateAndCreateTemplate: categories=${JSON.stringify(categories)}`);

  if (!streamId && !linkedStreamId) {
    logError(
      "TEMPLATES-SERVICE",
      "generateAndCreateTemplate: Neither streamId nor linkedStreamId provided",
    );
    throw new Error("Either streamId or linkedStreamId is required");
  }

  // Check AI credits for template generation
  const creditCheck = await checkAICredits(userId, "templateGeneration");
  if (!creditCheck.allowed) {
    debug(
      `generateAndCreateTemplate: Insufficient AI credits for userId=${userId}`,
    );
    throw new Error(
      `Insufficient AI credits. Requires ${creditCheck.cost} credits.`,
    );
  }

  // Fetch recent content items from the stream for realistic template content
  let contentItems: ContentItem[] = [];
  const parentId = streamId || linkedStreamId;
  if (parentId) {
    try {
      const rawItems = await prisma.contentItem.findMany({
        where: { streamId: parentId },
        orderBy: { publishedAt: "desc" },
        take: 8,
      });
      contentItems = rawItems as unknown as ContentItem[];
      debug(`generateAndCreateTemplate: Fetched ${contentItems.length} content items for template`);
    } catch (err) {
      debug(`generateAndCreateTemplate: Could not fetch content items: ${err}`);
    }
  }

  // Generate template mkly source using AI
  debug(`generateAndCreateTemplate: Calling AI to generate mkly template`);
  const mklySource = await generateMklyTemplate(
    name,
    categories,
    customization,
    contentItems.length > 0 ? contentItems : undefined,
  );
  debug(
    `generateAndCreateTemplate: AI generated mkly source (${mklySource.length} chars)`,
  );

  const templateName = `${name} Template`;

  let createdTemplate: TemplateInfo;

  if (streamId) {
    createdTemplate = await prisma.$transaction(async (tx) => {
      // Only deactivate others if setActive is true
      if (setActive) {
        const deactivateResult = await tx.template.updateMany({
          where: { streamId, isActive: true },
          data: { isActive: false },
        });
        debug(
          `generateAndCreateTemplate: Deactivated ${deactivateResult.count} existing templates for streamId=${streamId}`,
        );
      }

      // Create the new template (inactive by default, active only if setActive is true)
      const dbTemplate = await tx.template.create({
        data: {
          name: templateName,
          mklySource,
          streamId,
          isActive: setActive,
        },
      });
      debug(
        `generateAndCreateTemplate: Created stream template id=${dbTemplate.id}, isActive=${dbTemplate.isActive}`,
      );

      return {
        id: dbTemplate.id,
        name: dbTemplate.name,
        mklySource: dbTemplate.mklySource,
        isActive: dbTemplate.isActive,
        createdAt: dbTemplate.createdAt,
        updatedAt: dbTemplate.updatedAt,
        streamId: dbTemplate.streamId,
      };
    });
  } else {
    createdTemplate = await prisma.$transaction(async (tx) => {
      // Only deactivate others if setActive is true
      if (setActive) {
        const deactivateResult = await tx.linkedStreamTemplate.updateMany({
          where: { linkedStreamId: linkedStreamId!, isActive: true },
          data: { isActive: false },
        });
        debug(
          `generateAndCreateTemplate: Deactivated ${deactivateResult.count} existing templates for linkedStreamId=${linkedStreamId}`,
        );
      }

      // Create the new template (inactive by default, active only if setActive is true)
      const dbTemplate = await tx.linkedStreamTemplate.create({
        data: {
          name: templateName,
          mklySource,
          linkedStreamId: linkedStreamId!,
          isActive: setActive,
        },
      });
      debug(
        `generateAndCreateTemplate: Created linkedStream template id=${dbTemplate.id}, isActive=${dbTemplate.isActive}`,
      );

      return {
        id: dbTemplate.id,
        name: dbTemplate.name,
        mklySource: dbTemplate.mklySource,
        isActive: dbTemplate.isActive,
        createdAt: dbTemplate.createdAt,
        updatedAt: dbTemplate.updatedAt,
        linkedStreamId: dbTemplate.linkedStreamId,
      };
    });
  }

  // Deduct AI credits after successful generation
  await deductAICredits(userId, "templateGeneration");
  debug(
    `generateAndCreateTemplate: Completed, returning template id=${createdTemplate.id}`,
  );

  return createdTemplate;
}

/**
 * Get all templates for a stream
 */
export async function getStreamTemplates(
  streamId: string,
): Promise<TemplateInfo[]> {
  debug(`getStreamTemplates: streamId=${streamId}`);

  const templates = await prisma.template.findMany({
    where: { streamId },
    orderBy: { createdAt: "desc" },
  });

  debug(
    `getStreamTemplates: Found ${templates.length} templates for streamId=${streamId}`,
  );

  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    mklySource: t.mklySource,
    isActive: t.isActive,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    streamId: t.streamId,
  }));
}

/**
 * Get all templates for a linked stream
 */
export async function getLinkedStreamTemplates(
  linkedStreamId: string,
): Promise<TemplateInfo[]> {
  debug(`getLinkedStreamTemplates: linkedStreamId=${linkedStreamId}`);

  // Get linked stream with members
  const linkedStream = await prisma.linkedStream.findUnique({
    where: { id: linkedStreamId },
    include: {
      members: {
        select: { streamId: true },
      },
    },
  });

  if (!linkedStream) {
    debug(
      `getLinkedStreamTemplates: LinkedStream not found for id=${linkedStreamId}`,
    );
    return [];
  }

  const streamIds = linkedStream.members.map((m) => m.streamId);
  debug(`getLinkedStreamTemplates: Found ${streamIds.length} member streams`);

  // Fetch templates from both sources
  const [streamTemplates, linkedStreamTemplates] = await Promise.all([
    // Templates from linked single streams
    prisma.template.findMany({
      where: { streamId: { in: streamIds } },
      orderBy: { createdAt: "desc" },
    }),
    // Custom templates for this linked stream
    prisma.linkedStreamTemplate.findMany({
      where: { linkedStreamId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  debug(
    `getLinkedStreamTemplates: Found ${streamTemplates.length} stream templates, ${linkedStreamTemplates.length} linkedStream templates`,
  );

  // Transform stream templates
  const streamTemplateInfos: TemplateInfo[] = streamTemplates.map((t) => ({
    id: t.id,
    name: t.name,
    mklySource: t.mklySource,
    isActive: t.isActive,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    streamId: t.streamId,
  }));

  // Transform linked stream templates
  const linkedStreamTemplateInfos: TemplateInfo[] = linkedStreamTemplates.map(
    (t) => ({
      id: t.id,
      name: t.name,
      mklySource: t.mklySource,
      isActive: t.isActive,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      linkedStreamId: t.linkedStreamId,
    }),
  );

  // Merge and sort by createdAt (newest first)
  const merged = [...linkedStreamTemplateInfos, ...streamTemplateInfos].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  debug(`getLinkedStreamTemplates: Returning ${merged.length} total templates`);
  return merged;
}

export type TemplateType = "stream" | "linkedStream";

interface StreamTemplateWithParent {
  id: string;
  name: string;
  mklySource: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  isGlobal: boolean;
  streamId: string | null;
  newsletterType: string | null;
  userId: string | null;
  stream: { id: string; name: string; userId: string } | null;
}

interface LinkedStreamTemplateWithParent {
  id: string;
  name: string;
  mklySource: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  linkedStreamId: string;
  linkedStream: { id: string; name: string; userId: string };
}

type TemplateWithParent =
  | StreamTemplateWithParent
  | LinkedStreamTemplateWithParent;

interface TemplateOwnershipResult {
  template: TemplateWithParent;
  parentId: string;
  parentName: string;
}

async function verifyTemplateOwnership(
  templateId: string,
  userId: string,
  type: TemplateType,
): Promise<TemplateOwnershipResult> {
  debug(
    `verifyTemplateOwnership: templateId=${templateId}, userId=${userId}, type=${type}`,
  );

  if (type === "stream") {
    const template = await prisma.template.findFirst({
      where: { id: templateId },
      include: { stream: true },
    });

    if (!template) {
      debug(`verifyTemplateOwnership: Template not found for id=${templateId}`);
      throw new Error("Template not found");
    }

    const isOwnedByUser = template.isGlobal
      ? template.userId === userId
      : template.stream?.userId === userId;

    if (!isOwnedByUser) {
      debug(
        `verifyTemplateOwnership: Unauthorized access attempt by userId=${userId} for templateId=${templateId}`,
      );
      throw new Error("Unauthorized");
    }

    debug(
      `verifyTemplateOwnership: Verified ownership for stream template id=${templateId}, isGlobal=${template.isGlobal}`,
    );
    return {
      template: template as StreamTemplateWithParent,
      parentId: template.isGlobal ? "" : template.stream!.id,
      parentName: template.isGlobal ? "Global" : template.stream!.name,
    };
  } else {
    const template = await prisma.linkedStreamTemplate.findFirst({
      where: { id: templateId },
      include: { linkedStream: true },
    });

    if (!template) {
      debug(
        `verifyTemplateOwnership: LinkedStreamTemplate not found for id=${templateId}`,
      );
      throw new Error("Template not found");
    }

    if (template.linkedStream.userId !== userId) {
      debug(
        `verifyTemplateOwnership: Unauthorized access attempt by userId=${userId} for linkedStreamTemplate id=${templateId}`,
      );
      throw new Error("Unauthorized");
    }

    debug(
      `verifyTemplateOwnership: Verified ownership for linkedStream template id=${templateId}`,
    );
    return {
      template: template as LinkedStreamTemplateWithParent,
      parentId: template.linkedStream.id,
      parentName: template.linkedStream.name,
    };
  }
}

/**
 * Activate a template (deactivates others for same stream/linked stream)
 */
export async function activateTemplate(
  templateId: string,
  userId: string,
  type: TemplateType,
): Promise<{
  templateInfo: TemplateInfo;
  parentId: string;
  parentName: string;
}> {
  debug(
    `activateTemplate: templateId=${templateId}, userId=${userId}, type=${type}`,
  );

  const { template, parentId, parentName } = await verifyTemplateOwnership(
    templateId,
    userId,
    type,
  );

  if (type === "stream") {
    const streamTemplate = template as StreamTemplateWithParent;

    // For stream templates, deactivate all other templates for this stream
    // For global templates, we just activate without deactivating others
    if (!streamTemplate.isGlobal && streamTemplate.streamId) {
      const deactivateResult = await prisma.template.updateMany({
        where: {
          streamId: streamTemplate.streamId,
          id: { not: templateId },
        },
        data: { isActive: false },
      });
      debug(
        `activateTemplate: Deactivated ${deactivateResult.count} other templates for streamId=${streamTemplate.streamId}`,
      );
    } else {
      debug(
        `activateTemplate: Skipping deactivation for global template id=${templateId}`,
      );
    }

    const updated = await prisma.template.update({
      where: { id: templateId },
      data: { isActive: true },
    });

    debug(`activateTemplate: Activated stream template id=${updated.id}`);

    return {
      templateInfo: {
        id: updated.id,
        name: updated.name,
        mklySource: updated.mklySource,
        isActive: updated.isActive,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        streamId: updated.streamId,
      },
      parentId,
      parentName,
    };
  } else {
    const linkedStreamTemplate = template as LinkedStreamTemplateWithParent;

    // Deactivate all other templates for this linked stream
    const deactivateResult = await prisma.linkedStreamTemplate.updateMany({
      where: {
        linkedStreamId: linkedStreamTemplate.linkedStreamId,
        id: { not: templateId },
      },
      data: { isActive: false },
    });
    debug(
      `activateTemplate: Deactivated ${deactivateResult.count} other templates for linkedStreamId=${linkedStreamTemplate.linkedStreamId}`,
    );

    const updated = await prisma.linkedStreamTemplate.update({
      where: { id: templateId },
      data: { isActive: true },
    });

    debug(`activateTemplate: Activated linkedStream template id=${updated.id}`);

    return {
      templateInfo: {
        id: updated.id,
        name: updated.name,
        mklySource: updated.mklySource,
        isActive: updated.isActive,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        linkedStreamId: updated.linkedStreamId,
      },
      parentId,
      parentName,
    };
  }
}

/**
 * Deactivate a template
 */
export async function deactivateTemplate(
  templateId: string,
  userId: string,
  type: TemplateType,
): Promise<{
  templateInfo: TemplateInfo;
  parentId: string;
  parentName: string;
}> {
  debug(
    `deactivateTemplate: templateId=${templateId}, userId=${userId}, type=${type}`,
  );

  const { parentId, parentName } = await verifyTemplateOwnership(
    templateId,
    userId,
    type,
  );

  if (type === "stream") {
    const updated = await prisma.template.update({
      where: { id: templateId },
      data: { isActive: false },
    });

    debug(`deactivateTemplate: Deactivated stream template id=${updated.id}`);

    return {
      templateInfo: {
        id: updated.id,
        name: updated.name,
        mklySource: updated.mklySource,
        isActive: updated.isActive,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        streamId: updated.streamId,
      },
      parentId,
      parentName,
    };
  } else {
    const updated = await prisma.linkedStreamTemplate.update({
      where: { id: templateId },
      data: { isActive: false },
    });

    debug(
      `deactivateTemplate: Deactivated linkedStream template id=${updated.id}`,
    );

    return {
      templateInfo: {
        id: updated.id,
        name: updated.name,
        mklySource: updated.mklySource,
        isActive: updated.isActive,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        linkedStreamId: updated.linkedStreamId,
      },
      parentId,
      parentName,
    };
  }
}

/**
 * Delete a template
 */
export async function deleteTemplate(
  templateId: string,
  userId: string,
  type: TemplateType,
): Promise<void> {
  debug(
    `deleteTemplate: templateId=${templateId}, userId=${userId}, type=${type}`,
  );

  const { template } = await verifyTemplateOwnership(templateId, userId, type);

  if (type === "stream") {
    // Preserve template name in newsletters before deleting
    await prisma.newsletter.updateMany({
      where: { templateId },
      data: { templateName: template.name },
    });
    debug(
      `deleteTemplate: Preserved template name "${template.name}" in newsletters`,
    );

    await prisma.template.softDelete({ id: templateId });
    debug(`deleteTemplate: Soft deleted stream template id=${templateId}`);
  } else {
    // Preserve template name in linked newsletters before deleting
    await prisma.linkedNewsletter.updateMany({
      where: { templateId },
      data: { templateName: template.name },
    });
    debug(
      `deleteTemplate: Preserved template name "${template.name}" in linked newsletters`,
    );

    await prisma.linkedStreamTemplate.softDelete({ id: templateId });
    debug(
      `deleteTemplate: Soft deleted linkedStream template id=${templateId}`,
    );
  }
}

/**
 * Duplicate a template
 */
export async function duplicateTemplate(
  templateId: string,
  userId: string,
  type: TemplateType,
  newName?: string,
): Promise<{
  templateInfo: TemplateInfo;
  parentId: string;
  parentName: string;
}> {
  debug(
    `duplicateTemplate: templateId=${templateId}, userId=${userId}, type=${type}, newName=${newName ?? "(auto)"}`,
  );

  const { template, parentId, parentName } = await verifyTemplateOwnership(
    templateId,
    userId,
    type,
  );

  if (type === "stream") {
    const streamTemplate = template as StreamTemplateWithParent;
    const duplicateName = newName || `Copy of ${streamTemplate.name}`;

    debug(
      `duplicateTemplate: Duplicating stream template "${streamTemplate.name}" -> "${duplicateName}"`,
    );

    const duplicated = await prisma.template.create({
      data: {
        name: duplicateName,
        mklySource: streamTemplate.mklySource,
        newsletterType: streamTemplate.newsletterType,
        streamId: streamTemplate.streamId,
        userId: streamTemplate.userId,
        isGlobal: streamTemplate.isGlobal,
        isActive: false,
      },
    });

    debug(
      `duplicateTemplate: Created duplicate stream template id=${duplicated.id} from source id=${templateId}`,
    );

    return {
      templateInfo: {
        id: duplicated.id,
        name: duplicated.name,
        mklySource: duplicated.mklySource,
        isActive: duplicated.isActive,
        createdAt: duplicated.createdAt,
        updatedAt: duplicated.updatedAt,
        streamId: duplicated.streamId,
      },
      parentId,
      parentName,
    };
  } else {
    const linkedStreamTemplate = template as LinkedStreamTemplateWithParent;
    const duplicateName = newName || `Copy of ${linkedStreamTemplate.name}`;

    debug(
      `duplicateTemplate: Duplicating linkedStream template "${linkedStreamTemplate.name}" -> "${duplicateName}"`,
    );

    const duplicated = await prisma.linkedStreamTemplate.create({
      data: {
        name: duplicateName,
        mklySource: linkedStreamTemplate.mklySource,
        linkedStreamId: linkedStreamTemplate.linkedStreamId,
        isActive: false,
      },
    });

    debug(
      `duplicateTemplate: Created duplicate linkedStream template id=${duplicated.id} from source id=${templateId}`,
    );

    return {
      templateInfo: {
        id: duplicated.id,
        name: duplicated.name,
        mklySource: duplicated.mklySource,
        isActive: duplicated.isActive,
        createdAt: duplicated.createdAt,
        updatedAt: duplicated.updatedAt,
        linkedStreamId: duplicated.linkedStreamId,
      },
      parentId,
      parentName,
    };
  }
}

/**
 * Get active template for a stream
 */
export async function getActiveStreamTemplate(
  streamId: string,
): Promise<TemplateInfo | null> {
  debug(`getActiveStreamTemplate: streamId=${streamId}`);

  const template = await prisma.template.findFirst({
    where: { streamId, isActive: true },
  });

  if (!template) {
    debug(
      `getActiveStreamTemplate: No active template found for streamId=${streamId}`,
    );
    return null;
  }

  debug(
    `getActiveStreamTemplate: Found active template id=${template.id} for streamId=${streamId}`,
  );

  return {
    id: template.id,
    name: template.name,
    mklySource: template.mklySource,
    isActive: template.isActive,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    streamId: template.streamId,
  };
}

/**
 * Get active template for a linked stream
 */
export async function getActiveLinkedStreamTemplate(
  linkedStreamId: string,
): Promise<TemplateInfo | null> {
  debug(`getActiveLinkedStreamTemplate: linkedStreamId=${linkedStreamId}`);

  const template = await prisma.linkedStreamTemplate.findFirst({
    where: { linkedStreamId, isActive: true },
  });

  if (!template) {
    debug(
      `getActiveLinkedStreamTemplate: No active template found for linkedStreamId=${linkedStreamId}`,
    );
    return null;
  }

  debug(
    `getActiveLinkedStreamTemplate: Found active template id=${template.id} for linkedStreamId=${linkedStreamId}`,
  );

  return {
    id: template.id,
    name: template.name,
    mklySource: template.mklySource,
    isActive: template.isActive,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    linkedStreamId: template.linkedStreamId,
  };
}

/**
 * Returns realistic sample content items for template preview generation.
 * Includes 2-3 items per category (news, videos, social) with placeholder data.
 */
export function getSampleContentItems(): ContentItem[] {
  debug(
    `getSampleContentItems: Generating sample content items for all categories`,
  );

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const sampleStreamId = "sample-stream-id";

  const newsItems: ContentItem[] = [
    {
      id: "sample-news-1",
      title: "Sample Tech Company Announces Revolutionary AI-Powered Product",
      url: "https://example.com/tech-news/ai-product-launch",
      description:
        "A leading technology company has unveiled their latest innovation that promises to transform how businesses leverage artificial intelligence. The new platform integrates seamlessly with existing workflows.",
      imageUrl:
        "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800",
      rawImageUrl: null,
      source: "TechCrunch",
      category: "news",
      author: "Jane Smith",
      publishedAt: yesterday,
      metadata: null,
      streamId: sampleStreamId,
      createdAt: yesterday,
      batchId: "sample-batch-1",
      fetchedAt: yesterday,
      isCustomItem: false,
    },
    {
      id: "sample-news-2",
      title: "Global Markets Show Strong Recovery Amid Economic Optimism",
      url: "https://example.com/business-news/market-recovery",
      description:
        "Stock indices across major economies posted significant gains as investors responded positively to recent economic indicators and policy announcements from central banks.",
      imageUrl:
        "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800",
      rawImageUrl: null,
      source: "Bloomberg",
      category: "news",
      author: "Michael Chen",
      publishedAt: twoDaysAgo,
      metadata: null,
      streamId: sampleStreamId,
      createdAt: twoDaysAgo,
      batchId: "sample-batch-1",
      fetchedAt: twoDaysAgo,
      isCustomItem: false,
    },
    {
      id: "sample-news-3",
      title:
        "Startup Raises $50M Series B to Expand Sustainable Energy Solutions",
      url: "https://example.com/startup-news/energy-funding",
      description:
        "The clean energy startup secured major funding to accelerate development of their innovative solar storage technology and expand into new markets across Europe and Asia.",
      imageUrl:
        "https://images.unsplash.com/photo-1509391366360-2e959784a276?w=800",
      rawImageUrl: null,
      source: "VentureBeat",
      category: "news",
      author: "Sarah Johnson",
      publishedAt: now,
      metadata: null,
      streamId: sampleStreamId,
      createdAt: now,
      batchId: "sample-batch-1",
      fetchedAt: now,
      isCustomItem: false,
    },
  ];

  const videoItems: ContentItem[] = [
    {
      id: "sample-video-1",
      title: "How to Build a Successful SaaS Product in 2024 - Complete Guide",
      url: "https://youtube.com/watch?v=sample-video-1",
      description:
        "In this comprehensive tutorial, we walk through the essential steps to launch and scale a successful SaaS business, from ideation to product-market fit.",
      imageUrl:
        "https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=800",
      rawImageUrl: null,
      source: "YouTube",
      category: "videos",
      author: "Tech Entrepreneur Academy",
      publishedAt: yesterday,
      metadata: { duration: "24:15", views: 125000 },
      streamId: sampleStreamId,
      createdAt: yesterday,
      batchId: "sample-batch-1",
      fetchedAt: yesterday,
      isCustomItem: false,
    },
    {
      id: "sample-video-2",
      title: "The Future of Remote Work: Expert Panel Discussion",
      url: "https://youtube.com/watch?v=sample-video-2",
      description:
        "Industry leaders share their insights on how remote and hybrid work models are reshaping company culture, productivity, and the future of office spaces.",
      imageUrl:
        "https://images.unsplash.com/photo-1587825140708-dfaf72ae4b04?w=800",
      rawImageUrl: null,
      source: "YouTube",
      category: "videos",
      author: "Future of Work Channel",
      publishedAt: twoDaysAgo,
      metadata: { duration: "45:30", views: 89000 },
      streamId: sampleStreamId,
      createdAt: twoDaysAgo,
      batchId: "sample-batch-1",
      fetchedAt: twoDaysAgo,
      isCustomItem: false,
    },
  ];

  const socialItems: ContentItem[] = [
    {
      id: "sample-social-1",
      title:
        "Just shipped our biggest update yet! New AI features that will change how you work.",
      url: "https://twitter.com/sampleuser/status/sample-1",
      description:
        "Been working on this for 6 months with the team. So excited to finally share it with the world. Thread on what's new below.",
      imageUrl: null,
      rawImageUrl: null,
      source: "Twitter",
      category: "social",
      author: "@tech_founder",
      publishedAt: now,
      metadata: { likes: 2500, retweets: 450, replies: 120 },
      streamId: sampleStreamId,
      createdAt: now,
      batchId: "sample-batch-1",
      fetchedAt: now,
      isCustomItem: false,
    },
    {
      id: "sample-social-2",
      title:
        "Hot take: The best marketing strategy is building something people actually want to use.",
      url: "https://twitter.com/sampleuser/status/sample-2",
      description:
        "Stop spending 80% on marketing and 20% on product. Flip it. Word of mouth from happy users beats any ad campaign.",
      imageUrl: null,
      rawImageUrl: null,
      source: "Twitter",
      category: "social",
      author: "@startup_wisdom",
      publishedAt: yesterday,
      metadata: { likes: 8900, retweets: 1200, replies: 340 },
      streamId: sampleStreamId,
      createdAt: yesterday,
      batchId: "sample-batch-1",
      fetchedAt: yesterday,
      isCustomItem: false,
    },
    {
      id: "sample-social-3",
      title: "5 lessons from scaling our startup from $0 to $10M ARR",
      url: "https://linkedin.com/posts/sample-post-3",
      description:
        "1. Focus on retention before acquisition. 2. Hire slow, fire fast. 3. Customer feedback is gold. 4. Cash flow > revenue. 5. Build a strong culture early.",
      imageUrl: null,
      rawImageUrl: null,
      source: "LinkedIn",
      category: "social",
      author: "Alex Rodriguez",
      publishedAt: twoDaysAgo,
      metadata: { likes: 15000, comments: 890, shares: 2100 },
      streamId: sampleStreamId,
      createdAt: twoDaysAgo,
      batchId: "sample-batch-1",
      fetchedAt: twoDaysAgo,
      isCustomItem: false,
    },
  ];

  const allItems = [...newsItems, ...videoItems, ...socialItems];
  debug(
    `getSampleContentItems: Generated ${allItems.length} items (${newsItems.length} news, ${videoItems.length} videos, ${socialItems.length} social)`,
  );

  return allItems;
}
