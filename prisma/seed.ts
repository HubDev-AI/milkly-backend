import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // Seed Categories
  const categories = [
    {
      slug: "news",
      label: "News",
      description: "News articles and current events",
      icon: "newspaper",
      color: "#3b82f6",
      isSystem: true,
      order: 1,
    },
    {
      slug: "videos",
      label: "Videos",
      description: "Video content from various platforms",
      icon: "video",
      color: "#ef4444",
      isSystem: true,
      order: 2,
    },
    {
      slug: "social",
      label: "Social Media",
      description: "Social media posts and updates",
      icon: "message-circle",
      color: "#8b5cf6",
      isSystem: true,
      order: 3,
    },
    {
      slug: "custom",
      label: "Custom",
      description: "Manually added custom items",
      icon: "edit",
      color: "#f59e0b",
      isSystem: true,
      order: 4,
    },
  ];

  for (const category of categories) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: category,
      create: category,
    });
  }

  console.log("✓ Categories seeded");

  // Seed Sort Options
  const sortOptions = [
    {
      slug: "date",
      label: "Most Recent",
      description: "Sort by publication date (newest first)",
      isSystem: true,
      order: 1,
    },
    {
      slug: "relevancy",
      label: "Most Relevant",
      description: "Sort by relevance to keywords",
      isSystem: true,
      order: 2,
    },
    {
      slug: "popularity",
      label: "Most Popular",
      description: "Sort by popularity (views, engagement, etc.)",
      isSystem: true,
      order: 3,
    },
  ];

  for (const sortOption of sortOptions) {
    await prisma.sortOption.upsert({
      where: { slug: sortOption.slug },
      update: sortOption,
      create: sortOption,
    });
  }

  console.log("✓ Sort options seeded");

  // Seed Subscription Tiers
  const tiers = [
    {
      slug: "essential",
      label: "Essential",
      description: "Perfect for getting started",
      features: JSON.stringify({
        milkLimit: 10,
        generateLimit: 5,
        publishLimit: 2,
        emailLimit: 10,
        streamsLimit: 3,
        allowCustomItems: true,
        allowTemplates: false,
        allowNewsletters: true,
        allowLinkedStreams: false,
      }),
      price: JSON.stringify({
        amount: 0,
        currency: "USD",
        interval: "month",
      }),
      isSystem: true,
      isActive: true,
      order: 1,
    },
    {
      slug: "professional",
      label: "Professional",
      description: "For power users who need more",
      features: JSON.stringify({
        milkLimit: 100,
        generateLimit: 50,
        publishLimit: 20,
        emailLimit: 1000,
        streamsLimit: 20,
        allowCustomItems: true,
        allowTemplates: true,
        allowNewsletters: true,
        allowLinkedStreams: true,
      }),
      price: JSON.stringify({
        amount: 999,
        currency: "USD",
        interval: "month",
      }),
      isSystem: true,
      isActive: true,
      order: 2,
    },
    {
      slug: "mastery",
      label: "Mastery",
      description: "For teams and organizations",
      features: JSON.stringify({
        milkLimit: -1, // Unlimited
        generateLimit: -1,
        publishLimit: -1,
        emailLimit: -1,
        streamsLimit: -1,
        allowCustomItems: true,
        allowTemplates: true,
        allowNewsletters: true,
        allowLinkedStreams: true,
      }),
      price: JSON.stringify({
        amount: 4999,
        currency: "USD",
        interval: "month",
      }),
      isSystem: true,
      isActive: true,
      order: 3,
    },
  ];

  for (const tier of tiers) {
    await prisma.subscriptionTier.upsert({
      where: { slug: tier.slug },
      update: tier,
      create: tier,
    });
  }

  console.log("✓ Subscription tiers seeded");

  // Seed TierConfig (simplified features for pricing display)
  const tierFeatures = {
    essential: [
      "3 streams",
      "30 AI credits / week",
      "50 email subscribers",
      "News & Videos categories",
      "10 MB storage",
    ],
    professional: [
      "10 streams",
      "300 AI credits / week",
      "1,000 email subscribers",
      "All categories + custom items",
      "Linked streams",
      "100 MB storage",
    ],
    mastery: [
      "Unlimited streams",
      "Unlimited AI credits",
      "Unlimited subscribers",
      "All features",
      "500 MB storage",
      "Priority support",
    ],
  };

  for (const [tier, features] of Object.entries(tierFeatures)) {
    await prisma.tierConfig.upsert({
      where: { tier },
      update: { features },
      create: { tier, features },
    });
  }

  console.log("✓ Tier configs seeded");

  console.log("✅ Database seeding complete!");
}

main()
  .catch((e) => {
    console.error("❌ Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
