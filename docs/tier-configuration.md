# Tier Configuration Guide

## Overview

Milkly uses a credit-based tier system with three tiers: essential, professional, and mastery.

## Tier Limits

### Usage Limits (Reset Weekly)

| Limit | Essential | Professional | Mastery |
|-------|-----------|--------------|---------|
| AI Credits | 30 | 300 | Unlimited |
| Refreshes | 30 | 100 | Unlimited |

### Static Limits

| Limit | Essential | Professional | Mastery |
|-------|-----------|--------------|---------|
| Max Streams | 3 | 10 | Unlimited |
| Email Subscribers | 50 | 1,000 | Unlimited |
| Storage (MB) | 10 | 100 | 500 |

### Feature Flags

| Feature | Essential | Professional | Mastery |
|---------|-----------|--------------|---------|
| Linked Streams | No | Yes | Yes |
| Custom Items | Yes | Yes | Yes |
| Categories | news, videos | all | all |

## AI Credit Costs

| Operation | Credits | Model Tier | Endpoint |
|-----------|---------|------------|----------|
| Full AI Generate | 15 | high | POST /api/ai/generate |
| Preview Generation | 10 | high | POST /newsletters/preview |
| Template Generation | 8 | high | POST /templates |
| Content Regeneration | 8 | high | POST /newsletters/:id/regenerate |
| Template Preview | 6 | high | POST /templates/preview |
| Notes Generation | 3 | low | POST /newsletters/:id/generate-notes |
| Block Regeneration | 3 | low | POST /newsletters/:id/regenerate-block |
| Keyword Generation | 2 | low | POST /streams/generate-keywords |

## Configuration Files

- **Tier limits:** `src/config/tiers.ts` → `TIER_LIMITS`
- **AI costs:** `src/config/tiers.ts` → `AI_CREDIT_COSTS`
- **Model tiers:** `src/config/tiers.ts` → `AI_OPERATION_MODEL_TIER`
- **Display features:** Database `TierConfig` table (editable via admin API)

## Dual AI Model Setup

Configure in `.env`:

```env
# High-end model (complex tasks)
AI_HIGH_PROVIDER=anthropic
AI_HIGH_MODEL=claude-sonnet-4-20250514
AI_HIGH_API_KEY=sk-...

# Low-end model (simple tasks)
AI_LOW_PROVIDER=anthropic
AI_LOW_MODEL=claude-3-haiku-20240307
AI_LOW_API_KEY=sk-...
```

Supported providers: `anthropic`, `openai`, `google`

## Adding a New AI Operation

1. Add to `AI_OPERATIONS` in `src/config/tiers.ts`:
   ```typescript
   MY_NEW_OPERATION: 'myNewOperation',
   ```

2. Set credit cost in `AI_CREDIT_COSTS`:
   ```typescript
   myNewOperation: 5,
   ```

3. Set model tier in `AI_OPERATION_MODEL_TIER`:
   ```typescript
   myNewOperation: 'low', // or 'high'
   ```

4. Add middleware to route:
   ```typescript
   router.post("/my-endpoint",
     requireAuth,
     requireAICredits("myNewOperation"),
     async (c) => {
       // ... your logic ...
       await deductCreditsFromContext(c);
       return c.json({ data: result });
     }
   );
   ```

## Changing Tier Limits

Edit `TIER_LIMITS` in `src/config/tiers.ts`:

```typescript
export const TIER_LIMITS: Record<TierName, TierLimits> = {
  essential: {
    aiCredits: 30,           // Change this
    aiCreditsPeriodHours: 168, // 168 = weekly
    // ...
  },
  // ...
};
```

## Updating Display Features (No Deploy)

Use admin API to update features shown on pricing page:

```bash
# Get current config
curl -H "Cookie: $AUTH_COOKIE" $BACKEND_URL/api/admin/tier-config

# Update features
curl -X PUT -H "Content-Type: application/json" \
  -H "Cookie: $AUTH_COOKIE" \
  -d '{"features": ["New feature 1", "New feature 2"]}' \
  $BACKEND_URL/api/admin/tier-config/professional
```

## Period Reset Mechanism

- Fixed period with lazy reset (default: 168 hours = weekly)
- When user makes request, system checks if period expired
- If expired, creates new usage record with fresh limits
- Period is configurable per limit type via `*PeriodHours` fields
