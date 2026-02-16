/**
 * Social Mock Connector
 *
 * Generates mock social media content since free APIs for Twitter/Reddit
 * are not available. In production, this would be replaced with real APIs.
 */

import { SOCIAL_MOCK_CONFIG, type SocialMockConfig } from "../config";
import {
  BaseConnector,
  type FetchOptions,
  type FetchResult,
  type FetchedContentItem,
} from "./types";

// ============ Post Templates ============

const POST_TEMPLATES = [
  (topic: string) =>
    `🔥 Just discovered something amazing about ${topic}! Here's what you need to know...`,
  (topic: string) =>
    `Hot take: ${topic} is going to change everything in 2025. Here's why... 🧵`,
  (topic: string) =>
    `The ${topic} community is buzzing today! Check out these updates...`,
  (topic: string) => `Unpopular opinion about ${topic}: Thread 👇`,
  (topic: string) => `${topic} tip of the day that saved me hours of work ⚡`,
  (topic: string) => `Breaking: Major ${topic} news just dropped! 📢`,
  (topic: string) =>
    `Why everyone in ${topic} is talking about this right now...`,
  (topic: string) =>
    `${topic} deep dive: What I learned after 100 hours of research 🔍`,
  (topic: string) => `This ${topic} hack is absolutely game-changing 🚀`,
  (topic: string) =>
    `Controversial ${topic} opinion: Am I wrong? Let's discuss...`,
  (topic: string) => `${topic} trends to watch in 2025 📈`,
  (topic: string) => `Just published my thoughts on ${topic} - link in bio`,
  (topic: string) => `The future of ${topic} is here. Are you ready? 🌟`,
  (topic: string) =>
    `${topic} beginners: This is the mistake everyone makes (and how to avoid it)`,
  (topic: string) => `My ${topic} workflow that 10x'd my productivity 💪`,
  (topic: string) => `${topic} experts don't want you to know this...`,
  (topic: string) =>
    `Spent 6 months studying ${topic}. Here are my top insights:`,
  (topic: string) => `${topic} is officially having its moment. Here's proof:`,
  (topic: string) => `The ${topic} landscape just shifted dramatically 🌊`,
  (topic: string) => `If you're into ${topic}, you NEED to see this`,
];

// ============ Connector Implementation ============

export class SocialMockConnector extends BaseConnector {
  readonly id = SOCIAL_MOCK_CONFIG.id;
  readonly name = SOCIAL_MOCK_CONFIG.name;
  readonly category = SOCIAL_MOCK_CONFIG.category;

  private config: SocialMockConfig = SOCIAL_MOCK_CONFIG;

  getConfig(): SocialMockConfig {
    return this.config;
  }

  isConfigured(): boolean {
    // Mock connector is always configured
    return true;
  }

  async fetch(options: FetchOptions): Promise<FetchResult> {
    const count = options.count ?? this.config.defaults.pageSize;
    // For mock connector, use first keyword or fallback query as topic
    const topic =
      options.keywords.length > 0
        ? options.keywords[0]!
        : (options.fallbackQuery ?? "trending");
    this.logInfo(`Generating ${count} mock posts for: ${topic}`);

    const items = this.generatePosts(topic, count);

    return this.successResult(items);
  }

  // ============ Private Methods ============

  private generatePosts(topic: string, count: number): FetchedContentItem[] {
    const { mock } = this.config;
    const now = Date.now();

    return Array.from({ length: count }, (_, i) => {
      const platform = mock.platforms[i % mock.platforms.length]!;
      const template = POST_TEMPLATES[i % POST_TEMPLATES.length]!;
      const handle = mock.handles[i % mock.handles.length]!;
      const hoursAgo = Math.floor(Math.random() * mock.maxHoursAgo) + 1;
      const showImage = i % mock.imageFrequency === 0;

      return {
        title: template(topic),
        url: this.generatePostUrl(platform.id, topic, i),
        description: null,
        imageUrl: showImage ? this.generateImageUrl(topic, i) : null,
        source: platform.id,
        category: this.category,
        author: handle,
        publishedAt: new Date(now - hoursAgo * 60 * 60 * 1000),
        metadata: {
          likes: this.randomEngagement(50, 15000),
          reposts: this.randomEngagement(10, 2000),
          comments: this.randomEngagement(5, 800),
          platform: platform.name,
        },
      };
    });
  }

  private generatePostUrl(
    platformId: string,
    topic: string,
    index: number,
  ): string {
    const slug = topic.toLowerCase().replace(/\s+/g, "-");
    const timestamp = Date.now();
    const domain = platformId === "reddit" ? "reddit" : platformId;
    return `https://${domain}.com/post/${slug}-${timestamp}-${index}`;
  }

  private generateImageUrl(topic: string, index: number): string {
    const seed = `${topic}-social-${index}`;
    return `https://picsum.photos/seed/${seed}/600/400`;
  }

  private randomEngagement(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min)) + min;
  }
}

// ============ Singleton Export ============

export const socialMockConnector = new SocialMockConnector();
