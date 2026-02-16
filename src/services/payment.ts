/**
 * Payment Provider Service
 *
 * Provides payment/subscription functionality using a provider pattern.
 * Supports multiple payment providers with a unified interface.
 *
 * Current Provider: Stripe (web payments)
 *
 * Configuration:
 * - Set PAYMENT_PROVIDER env var to select provider (default: "stripe")
 * - Set provider-specific env vars (e.g., STRIPE_SECRET_KEY)
 *
 * Adding a new provider:
 * 1. Create a class implementing PaymentProvider interface
 * 2. Register it in PaymentProviderRegistry constructor
 * 3. Add provider name to PaymentProviderName type
 */

import Stripe from "stripe";
import type { TierName } from "../config/tiers";
import { env } from "../env";
import { logError, logWarn } from "../lib/debug";

// ============================================================================
// Types
// ============================================================================

/** Supported payment providers */
export type PaymentProviderName = "stripe";

/** Options for creating a checkout session */
export interface CheckoutOptions {
  userId: string;
  userEmail: string;
  userName: string;
  tier: Exclude<TierName, "essential">;
  interval: "monthly" | "yearly";
  successUrl: string;
  cancelUrl: string;
  existingCustomerId?: string;
}

/** Result from checkout creation */
export interface CheckoutResult {
  success: boolean;
  /** Checkout URL to redirect user to */
  url?: string;
  /** Provider customer ID (store this for future operations) */
  customerId?: string;
  /** Error message if success is false */
  error?: string;
}

/** Options for creating a billing portal session */
export interface PortalOptions {
  customerId: string;
  returnUrl: string;
}

/** Result from portal creation */
export interface PortalResult {
  success: boolean;
  /** Portal URL to redirect user to */
  url?: string;
  /** Error message if success is false */
  error?: string;
}

/** Subscription update data from webhook */
export interface SubscriptionUpdate {
  /** User ID from metadata */
  userId?: string;
  /** Tier from metadata or entitlement */
  tier?: TierName;
  /** Subscription status */
  status?: "active" | "canceled" | "past_due" | "trialing" | "paused";
  /** Provider's subscription ID */
  providerSubscriptionId?: string;
  /** Provider's price/product ID */
  providerPriceId?: string;
  /** Current billing period start */
  currentPeriodStart?: Date;
  /** Current billing period end */
  currentPeriodEnd?: Date;
  /** Whether subscription cancels at period end */
  cancelAtPeriodEnd?: boolean;
}

/** Result from webhook parsing */
export interface WebhookResult {
  success: boolean;
  /** Stripe event ID for deduplication */
  eventId?: string;
  /** Action to take based on webhook event */
  action?:
    | "subscription_created"
    | "subscription_updated"
    | "subscription_deleted"
    | "subscription_paused"
    | "subscription_resumed"
    | "payment_failed"
    | "none";
  /** Subscription data to update in database */
  subscriptionUpdate?: SubscriptionUpdate;
  /** Error message if success is false */
  error?: string;
}

/** Result from checkout session verification */
export interface CheckoutVerifyResult {
  success: boolean;
  paymentStatus?: string;
  subscriptionId?: string;
  customerId?: string;
  error?: string;
}

/** Customer/subscriber information */
export interface CustomerInfo {
  id: string;
  email?: string;
  subscriptions: Array<{
    id: string;
    status: string;
    tier: string;
    currentPeriodEnd?: Date;
  }>;
}

/** Price information fetched from the payment provider */
export interface PriceInfo {
  priceId: string;
  tier: string;
  interval: "monthly" | "yearly";
  amount: number;
  currency: string;
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Payment Provider Interface
 *
 * All payment providers must implement this interface.
 * This ensures consistent behavior across different payment platforms.
 */
export interface PaymentProvider {
  /** Provider identifier */
  name: PaymentProviderName;

  /** Check if provider has required configuration (API keys, etc.) */
  isConfigured(): boolean;

  /**
   * Create a checkout session for new subscription
   * Returns a URL to redirect the user to complete payment
   */
  createCheckout(options: CheckoutOptions): Promise<CheckoutResult>;

  /**
   * Create a billing portal session for subscription management
   * Allows users to update payment method, cancel subscription, etc.
   */
  createPortal(options: PortalOptions): Promise<PortalResult>;

  /**
   * Parse and verify incoming webhook
   * Validates signature and extracts subscription update data
   */
  parseWebhook(body: string, signature?: string): Promise<WebhookResult>;

  /**
   * Get customer information by ID
   * Optional - not all providers support this
   */
  getCustomerInfo?(customerId: string): Promise<CustomerInfo | null>;

  /**
   * Verify a checkout session by ID
   * Used after redirect to confirm payment went through
   */
  verifyCheckoutSession?(sessionId: string): Promise<CheckoutVerifyResult>;

  /**
   * Fetch current prices from the payment provider
   * Returns dollar amounts for each tier/interval combo
   */
  getPrices?(): Promise<PriceInfo[]>;
}

// ============================================================================
// Stripe Provider
// ============================================================================

/**
 * Stripe Payment Provider
 *
 * Handles web-based subscription payments through Stripe.
 *
 * Features:
 * - Checkout Sessions for new subscriptions
 * - Billing Portal for subscription management
 * - Webhook handling for subscription lifecycle events
 *
 * Required Environment Variables:
 * - STRIPE_SECRET_KEY: Your Stripe secret key
 * - STRIPE_WEBHOOK_SECRET: Webhook endpoint signing secret
 * - STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID: Price ID for professional monthly plan
 * - STRIPE_PROFESSIONAL_YEARLY_PRICE_ID: Price ID for professional yearly plan
 * - STRIPE_MASTERY_MONTHLY_PRICE_ID: Price ID for mastery monthly plan
 * - STRIPE_MASTERY_YEARLY_PRICE_ID: Price ID for mastery yearly plan
 *
 * Setup:
 * 1. Create products and prices in Stripe Dashboard
 * 2. Configure webhook endpoint in Stripe Dashboard
 * 3. Set environment variables with your keys and price IDs
 */
class StripeProvider implements PaymentProvider {
  name: PaymentProviderName = "stripe";
  private stripe: Stripe | null = null;
  private priceCache: { data: PriceInfo[]; fetchedAt: number } | null = null;
  private readonly PRICE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  // Price configuration
  private prices = {
    professional: {
      monthly: env.STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID,
      yearly: env.STRIPE_PROFESSIONAL_YEARLY_PRICE_ID,
    },
    mastery: {
      monthly: env.STRIPE_MASTERY_MONTHLY_PRICE_ID,
      yearly: env.STRIPE_MASTERY_YEARLY_PRICE_ID,
    },
  };

  constructor() {
    if (env.STRIPE_SECRET_KEY) {
      this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
        apiVersion: "2025-12-15.clover",
      });
    }
  }

  isConfigured(): boolean {
    return !!this.stripe;
  }

  async createCheckout(options: CheckoutOptions): Promise<CheckoutResult> {
    if (!this.stripe) {
      return {
        success: false,
        error:
          "Stripe is not configured. Set STRIPE_SECRET_KEY in environment variables.",
      };
    }

    try {
      let customerId = options.existingCustomerId;

      // Create Stripe customer if not exists
      if (!customerId) {
        const customer = await this.stripe.customers.create({
          email: options.userEmail,
          name: options.userName,
          metadata: { userId: options.userId },
        });
        customerId = customer.id;
      }

      // Get price ID for selected tier and interval
      const priceId =
        options.interval === "monthly"
          ? this.prices[options.tier].monthly
          : this.prices[options.tier].yearly;

      if (!priceId) {
        return {
          success: false,
          error: `Price ID not configured for ${options.tier} ${options.interval}. Set STRIPE_${options.tier.toUpperCase()}_${options.interval.toUpperCase()}_PRICE_ID.`,
        };
      }

      // Create checkout session
      const session = await this.stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${options.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: options.cancelUrl,
        allow_promotion_codes: true,
        ...(options.existingCustomerId && {
          customer_update: {
            address: "auto",
            name: "auto",
          },
        }),
        metadata: {
          userId: options.userId,
          tier: options.tier,
        },
        subscription_data: {
          metadata: {
            userId: options.userId,
            tier: options.tier,
          },
        },
      });

      return {
        success: true,
        url: session.url || undefined,
        customerId,
      };
    } catch (error) {
      logError("Stripe", "Checkout error:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create checkout",
      };
    }
  }

  async createPortal(options: PortalOptions): Promise<PortalResult> {
    if (!this.stripe) {
      return {
        success: false,
        error: "Stripe is not configured",
      };
    }

    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: options.customerId,
        return_url: options.returnUrl,
      });

      return {
        success: true,
        url: session.url,
      };
    } catch (error) {
      logError("Stripe", "Portal error:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create portal",
      };
    }
  }

  async parseWebhook(body: string, signature?: string): Promise<WebhookResult> {
    if (!this.stripe) {
      return { success: false, error: "Stripe is not configured" };
    }

    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !webhookSecret) {
      return { success: false, error: "Missing webhook signature or secret" };
    }

    // Verify webhook signature
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        body,
        signature,
        webhookSecret,
      );
    } catch (err) {
      logError("Stripe", "Webhook signature verification failed:", err);
      return { success: false, error: "Invalid webhook signature" };
    }

    // Handle different event types
    let result: WebhookResult;
    switch (event.type) {
      case "checkout.session.completed":
        result = await this.handleCheckoutCompleted(event);
        break;

      case "customer.subscription.updated":
        result = this.handleSubscriptionUpdated(event);
        break;

      case "customer.subscription.deleted":
        result = this.handleSubscriptionDeleted(event);
        break;

      case "invoice.payment_failed":
        result = this.handlePaymentFailed(event);
        break;

      case "customer.subscription.paused":
        result = this.handleSubscriptionPaused(event);
        break;

      case "customer.subscription.resumed":
        result = this.handleSubscriptionResumed(event);
        break;

      case "customer.subscription.trial_will_end":
        result = { success: true, action: "none" };
        break;

      default:
        result = { success: true, action: "none" };
    }

    result.eventId = event.id;
    return result;
  }

  async getCustomerInfo(customerId: string): Promise<CustomerInfo | null> {
    if (!this.stripe) return null;

    try {
      const customer = await this.stripe.customers.retrieve(customerId, {
        expand: ["subscriptions"],
      });

      if (customer.deleted) return null;

      const subscriptions = customer.subscriptions?.data || [];

      return {
        id: customer.id,
        email: customer.email || undefined,
        subscriptions: subscriptions.map((sub) => ({
          id: sub.id,
          status: sub.status,
          tier: (sub.metadata?.tier as string) || "unknown",
          currentPeriodEnd: sub.items.data[0]?.current_period_end
            ? new Date(sub.items.data[0].current_period_end * 1000)
            : undefined,
        })),
      };
    } catch (error) {
      logError("Stripe", "Error fetching customer:", error);
      return null;
    }
  }

  // ============ Private Webhook Handlers ============

  private async handleCheckoutCompleted(
    event: Stripe.Event,
  ): Promise<WebhookResult> {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    const tier = session.metadata?.tier as TierName;

    if (!userId || !tier || !session.subscription) {
      logWarn("Stripe", "Checkout completed but missing required metadata");
      return { success: true, action: "none" };
    }

    // Fetch full subscription details
    const subscription = await this.stripe!.subscriptions.retrieve(
      session.subscription as string,
    );

    const firstItem = subscription.items.data[0];
    const currentPeriodStart = firstItem?.current_period_start
      ? new Date(firstItem.current_period_start * 1000)
      : new Date();
    const currentPeriodEnd = firstItem?.current_period_end
      ? new Date(firstItem.current_period_end * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    return {
      success: true,
      action: "subscription_created",
      subscriptionUpdate: {
        userId,
        tier,
        status: "active",
        providerSubscriptionId: subscription.id,
        providerPriceId: firstItem?.price.id,
        currentPeriodStart,
        currentPeriodEnd,
      },
    };
  }

  private handleSubscriptionUpdated(event: Stripe.Event): WebhookResult {
    const subscription = event.data.object as Stripe.Subscription;
    const firstItem = subscription.items.data[0];

    // Map Stripe status to our status
    let status: "active" | "canceled" | "past_due" | "trialing" | "paused" =
      "active";
    if (subscription.status === "canceled") status = "canceled";
    else if (subscription.status === "past_due") status = "past_due";
    else if (subscription.status === "trialing") status = "trialing";
    else if (subscription.status === "paused") status = "paused";

    return {
      success: true,
      action: "subscription_updated",
      subscriptionUpdate: {
        providerSubscriptionId: subscription.id,
        status,
        currentPeriodStart: firstItem?.current_period_start
          ? new Date(firstItem.current_period_start * 1000)
          : undefined,
        currentPeriodEnd: firstItem?.current_period_end
          ? new Date(firstItem.current_period_end * 1000)
          : undefined,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    };
  }

  private handleSubscriptionDeleted(event: Stripe.Event): WebhookResult {
    const subscription = event.data.object as Stripe.Subscription;

    return {
      success: true,
      action: "subscription_deleted",
      subscriptionUpdate: {
        providerSubscriptionId: subscription.id,
      },
    };
  }

  private handlePaymentFailed(event: Stripe.Event): WebhookResult {
    const invoice = event.data.object as Stripe.Invoice;

    // Extract subscription ID from invoice
    const subscriptionDetails = invoice.parent?.subscription_details;
    const subscriptionId =
      typeof subscriptionDetails?.subscription === "string"
        ? subscriptionDetails.subscription
        : subscriptionDetails?.subscription?.id;

    if (!subscriptionId) {
      return { success: true, action: "none" };
    }

    return {
      success: true,
      action: "payment_failed",
      subscriptionUpdate: {
        providerSubscriptionId: subscriptionId,
        status: "past_due",
      },
    };
  }

  private handleSubscriptionPaused(event: Stripe.Event): WebhookResult {
    const subscription = event.data.object as Stripe.Subscription;

    return {
      success: true,
      action: "subscription_paused",
      subscriptionUpdate: {
        providerSubscriptionId: subscription.id,
        status: "paused",
      },
    };
  }

  private handleSubscriptionResumed(event: Stripe.Event): WebhookResult {
    const subscription = event.data.object as Stripe.Subscription;
    const firstItem = subscription.items.data[0];

    return {
      success: true,
      action: "subscription_resumed",
      subscriptionUpdate: {
        providerSubscriptionId: subscription.id,
        status: "active",
        currentPeriodStart: firstItem?.current_period_start
          ? new Date(firstItem.current_period_start * 1000)
          : undefined,
        currentPeriodEnd: firstItem?.current_period_end
          ? new Date(firstItem.current_period_end * 1000)
          : undefined,
      },
    };
  }

  async verifyCheckoutSession(
    sessionId: string,
  ): Promise<CheckoutVerifyResult> {
    if (!this.stripe) {
      return { success: false, error: "Stripe is not configured" };
    }

    try {
      const session = await this.stripe.checkout.sessions.retrieve(sessionId);
      return {
        success: true,
        paymentStatus: session.payment_status ?? undefined,
        subscriptionId:
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id,
        customerId:
          typeof session.customer === "string"
            ? session.customer
            : session.customer?.id,
      };
    } catch (error) {
      logError("Stripe", "Verify checkout error:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to verify session",
      };
    }
  }

  async getPrices(): Promise<PriceInfo[]> {
    if (!this.stripe) return [];

    if (
      this.priceCache &&
      Date.now() - this.priceCache.fetchedAt < this.PRICE_CACHE_TTL
    ) {
      return this.priceCache.data;
    }

    const priceEntries = [
      {
        tier: "professional",
        interval: "monthly" as const,
        id: this.prices.professional.monthly,
      },
      {
        tier: "professional",
        interval: "yearly" as const,
        id: this.prices.professional.yearly,
      },
      {
        tier: "mastery",
        interval: "monthly" as const,
        id: this.prices.mastery.monthly,
      },
      {
        tier: "mastery",
        interval: "yearly" as const,
        id: this.prices.mastery.yearly,
      },
    ].filter((p): p is typeof p & { id: string } => !!p.id);

    try {
      const results = await Promise.all(
        priceEntries.map(async ({ tier, interval, id }) => {
          const price = await this.stripe!.prices.retrieve(id);
          return {
            priceId: price.id,
            tier,
            interval,
            amount: (price.unit_amount ?? 0) / 100,
            currency: price.currency,
          };
        }),
      );

      this.priceCache = { data: results, fetchedAt: Date.now() };
      return results;
    } catch (error) {
      logError("Stripe", "Error fetching prices:", error);
      return this.priceCache?.data ?? [];
    }
  }
}

// ============================================================================
// Provider Registry
// ============================================================================

/**
 * Payment Provider Registry
 *
 * Manages registration and retrieval of payment providers.
 * Supports multiple providers with a configurable default.
 */
class PaymentProviderRegistry {
  private providers = new Map<PaymentProviderName, PaymentProvider>();
  private defaultProviderName: PaymentProviderName;

  constructor() {
    // Register Stripe provider
    this.register(new StripeProvider());

    // Set default from environment or fallback to stripe
    const envProvider = process.env.PAYMENT_PROVIDER as PaymentProviderName;
    this.defaultProviderName =
      envProvider === "stripe" ? envProvider : "stripe";
  }

  register(provider: PaymentProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: PaymentProviderName): PaymentProvider | undefined {
    return this.providers.get(name);
  }

  getDefault(): PaymentProvider {
    const provider = this.providers.get(this.defaultProviderName);
    if (!provider) {
      throw new Error(
        `Default payment provider "${this.defaultProviderName}" not found`,
      );
    }
    return provider;
  }

  listProviders(): PaymentProviderName[] {
    return Array.from(this.providers.keys());
  }

  listConfiguredProviders(): PaymentProviderName[] {
    return Array.from(this.providers.entries())
      .filter(([_, provider]) => provider.isConfigured())
      .map(([name]) => name);
  }
}

// Singleton registry instance
const registry = new PaymentProviderRegistry();

// ============================================================================
// Public API
// ============================================================================

/** Get the provider registry for advanced use cases */
export function getPaymentProviderRegistry(): PaymentProviderRegistry {
  return registry;
}

/** Get a specific provider by name, or the default provider */
export function getPaymentProvider(
  name?: PaymentProviderName,
): PaymentProvider {
  if (name) {
    const provider = registry.get(name);
    if (!provider) {
      throw new Error(
        `Payment provider "${name}" not found. Available: ${registry.listProviders().join(", ")}`,
      );
    }
    return provider;
  }
  return registry.getDefault();
}

/** Check if the default payment provider is configured */
export function isPaymentConfigured(): boolean {
  return registry.getDefault().isConfigured();
}

/** Get the default provider name */
export function getDefaultProviderName(): PaymentProviderName {
  return registry.getDefault().name;
}

/** List all configured payment providers */
export function getConfiguredProviders(): PaymentProviderName[] {
  return registry.listConfiguredProviders();
}

/** Get customer info from the default provider */
export async function getCustomerSubscriptionInfo(
  customerId: string,
): Promise<CustomerInfo | null> {
  const provider = registry.getDefault();
  return provider.getCustomerInfo?.(customerId) ?? null;
}
