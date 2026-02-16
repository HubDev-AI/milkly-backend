/**
 * Email Service
 *
 * Provides email sending functionality using a provider pattern.
 * Supports multiple email providers (Resend, Loops.so, AWS SES, etc.)
 *
 * Set EMAIL_PROVIDER env var to select provider (default: "resend")
 * Set provider-specific env vars (e.g., RESEND_API_KEY, SES_ACCESS_KEY_ID)
 */

import { env } from "../env";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

// ============================================================================
// Types
// ============================================================================

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  success: boolean;
  id?: string;
  error?: string;
}

export interface BatchSendResult {
  successful: number;
  failed: number;
  errors: string[];
}

// ============================================================================
// Provider Interface
// ============================================================================

export interface EmailProvider {
  name: string;

  /** Check if this provider has required configuration */
  isConfigured(): boolean;

  /** Get the default "from" address for this provider */
  getFromAddress(): string;

  /** Send a single email */
  sendEmail(options: EmailOptions): Promise<SendResult>;

  /**
   * Send emails in batch. Optional - defaults to sequential sending.
   * Providers can override for more efficient batch APIs.
   */
  sendBatch?(emails: EmailOptions[]): Promise<SendResult[]>;
}

// ============================================================================
// Resend Provider
// ============================================================================

class ResendProvider implements EmailProvider {
  name = "resend";

  isConfigured(): boolean {
    return !!env.RESEND_API_KEY;
  }

  getFromAddress(): string {
    return env.RESEND_FROM_EMAIL;
  }

  async sendEmail(options: EmailOptions): Promise<SendResult> {
    const apiKey = env.RESEND_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: "Resend not configured. Set RESEND_API_KEY in your environment.",
      };
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: options.from || this.getFromAddress(),
          to: Array.isArray(options.to) ? options.to : [options.to],
          subject: options.subject,
          html: options.html,
          reply_to: options.replyTo,
          headers: options.headers,
        }),
      });

      const data = (await response.json()) as { id?: string; message?: string };

      if (!response.ok) {
        return {
          success: false,
          error: data.message || `Failed to send email (${response.status})`,
        };
      }

      return {
        success: true,
        id: data.id,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error sending email",
      };
    }
  }

  async sendBatch(emails: EmailOptions[]): Promise<SendResult[]> {
    const apiKey = env.RESEND_API_KEY;

    if (!apiKey) {
      return emails.map(() => ({
        success: false,
        error: "Resend not configured. Set RESEND_API_KEY in your environment.",
      }));
    }

    // Resend supports batch API - use it for efficiency
    try {
      const response = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          emails.map((email) => ({
            from: email.from || this.getFromAddress(),
            to: Array.isArray(email.to) ? email.to : [email.to],
            subject: email.subject,
            html: email.html,
            reply_to: email.replyTo,
            headers: email.headers,
          })),
        ),
      });

      const data = (await response.json()) as {
        message?: string;
        data?: Array<{ id?: string }>;
      };

      if (!response.ok) {
        return emails.map(() => ({
          success: false,
          error: data.message || `Batch send failed (${response.status})`,
        }));
      }

      // Resend returns { data: [{ id }, { id }, ...] } for batch
      if (Array.isArray(data.data)) {
        return data.data.map((item) => ({
          success: true,
          id: item.id,
        }));
      }

      // Fallback if response format is different
      return emails.map(() => ({ success: true }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error in batch send";
      return emails.map(() => ({
        success: false,
        error: errorMessage,
      }));
    }
  }
}

// ============================================================================
// Loops Provider (Stub)
// ============================================================================

class LoopsProvider implements EmailProvider {
  name = "loops";

  // TODO: Implement Loops.so integration
  // Docs: https://loops.so/docs/api

  isConfigured(): boolean {
    return !!env.LOOPS_API_KEY;
  }

  getFromAddress(): string {
    // Loops uses the from address configured in the dashboard
    return env.LOOPS_FROM_EMAIL;
  }

  async sendEmail(_options: EmailOptions): Promise<SendResult> {
    // TODO: Implement Loops.so transactional email
    // Loops uses transactional email endpoint: POST https://app.loops.so/api/v1/transactional
    return {
      success: false,
      error: "Loops provider not yet implemented",
    };
  }
}

// ============================================================================
// AWS SES Provider
// ============================================================================

class SESProvider implements EmailProvider {
  name = "ses";
  private client: SESv2Client | null = null;

  private getClient(): SESv2Client {
    if (!this.client) {
      this.client = new SESv2Client({
        region: env.SES_REGION,
        ...(env.SES_ACCESS_KEY_ID &&
          env.SES_SECRET_ACCESS_KEY && {
            credentials: {
              accessKeyId: env.SES_ACCESS_KEY_ID,
              secretAccessKey: env.SES_SECRET_ACCESS_KEY,
            },
          }),
      });
    }
    return this.client;
  }

  isConfigured(): boolean {
    // SES needs either explicit credentials or IAM role (when running on AWS)
    const hasExplicitCreds =
      !!env.SES_ACCESS_KEY_ID && !!env.SES_SECRET_ACCESS_KEY;
    // If running on AWS (ECS/EC2), IAM role provides creds automatically
    const hasIAMRole = !env.SES_ACCESS_KEY_ID && !env.SES_SECRET_ACCESS_KEY;
    return hasExplicitCreds || hasIAMRole;
  }

  getFromAddress(): string {
    return env.SES_FROM_EMAIL;
  }

  async sendEmail(options: EmailOptions): Promise<SendResult> {
    try {
      const client = this.getClient();
      const toAddresses = Array.isArray(options.to)
        ? options.to
        : [options.to];
      const from = options.from || this.getFromAddress();

      // Build SES headers from custom headers (e.g., List-Unsubscribe)
      const sesHeaders: Array<{ Name: string; Value: string }> = [];
      if (options.headers) {
        for (const [name, value] of Object.entries(options.headers)) {
          sesHeaders.push({ Name: name, Value: value });
        }
      }

      const command = new SendEmailCommand({
        FromEmailAddress: from,
        Destination: {
          ToAddresses: toAddresses,
        },
        Content: {
          Simple: {
            Subject: { Data: options.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: options.html, Charset: "UTF-8" },
            },
            ...(sesHeaders.length > 0 && { Headers: sesHeaders }),
          },
        },
        ...(options.replyTo && { ReplyToAddresses: [options.replyTo] }),
        ...(env.SES_CONFIGURATION_SET && {
          ConfigurationSetName: env.SES_CONFIGURATION_SET,
        }),
      });

      const response = await client.send(command);

      return {
        success: true,
        id: response.MessageId,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error sending email via SES",
      };
    }
  }

  async sendBatch(emails: EmailOptions[]): Promise<SendResult[]> {
    // SES SendBulkEmail requires templates — since each newsletter email
    // has unique HTML (per-subscriber unsubscribe links), we use sequential
    // SendEmail calls. SES handles up to 14 emails/sec by default.
    const results: SendResult[] = [];

    for (const email of emails) {
      const result = await this.sendEmail(email);
      results.push(result);
    }

    return results;
  }
}

// ============================================================================
// Provider Registry
// ============================================================================

class EmailProviderRegistry {
  private providers = new Map<string, EmailProvider>();
  private defaultProviderName: string;

  constructor() {
    // Register built-in providers
    this.register(new ResendProvider());
    this.register(new LoopsProvider());
    this.register(new SESProvider());

    // Set default from env or fall back to resend
    this.defaultProviderName = env.EMAIL_PROVIDER;
  }

  register(provider: EmailProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): EmailProvider | undefined {
    return this.providers.get(name);
  }

  getDefault(): EmailProvider {
    const provider = this.providers.get(this.defaultProviderName);
    if (!provider) {
      // Fall back to resend if configured provider doesn't exist
      return this.providers.get("resend")!;
    }
    return provider;
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  listConfiguredProviders(): string[] {
    return Array.from(this.providers.entries())
      .filter(([_, provider]) => provider.isConfigured())
      .map(([name]) => name);
  }
}

// Singleton registry
const registry = new EmailProviderRegistry();

// ============================================================================
// Public API (maintains backward compatibility)
// ============================================================================

/** Get the provider registry for advanced use cases */
export function getEmailProviderRegistry(): EmailProviderRegistry {
  return registry;
}

/** Get a specific provider by name */
export function getEmailProvider(name?: string): EmailProvider {
  if (name) {
    const provider = registry.get(name);
    if (!provider) {
      throw new Error(
        `Email provider "${name}" not found. Available: ${registry.listProviders().join(", ")}`,
      );
    }
    return provider;
  }
  return registry.getDefault();
}

/** Check if the default email provider is configured */
export function isEmailConfigured(): boolean {
  return registry.getDefault().isConfigured();
}

/** Get the "from" address from the default provider */
export function getFromAddress(): string {
  return registry.getDefault().getFromAddress();
}

/** Send a single email using the default provider */
export async function sendEmail(options: EmailOptions): Promise<SendResult> {
  return registry.getDefault().sendEmail(options);
}

/** Send OTP verification email */
export async function sendOTPEmail(
  email: string,
  otp: string,
): Promise<SendResult> {
  return sendEmail({
    to: email,
    subject: "Your Milkly verification code",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">Your verification code</h2>
        <p>Use the following code to sign in to Milkly:</p>
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #333;">${otp}</span>
        </div>
        <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. If you didn't request this code, you can safely ignore this email.</p>
      </body>
      </html>
    `,
  });
}

/** Send newsletter to multiple subscribers */
export async function sendNewsletterToSubscribers(
  newsletter: {
    title: string;
    content: string;
  },
  subscribers: Array<{
    email: string;
    unsubscribeToken: string;
  }>,
  options: {
    subject?: string;
    baseUrl: string;
  },
): Promise<BatchSendResult> {
  const result: BatchSendResult = {
    successful: 0,
    failed: 0,
    errors: [],
  };

  const provider = registry.getDefault();

  if (!provider.isConfigured()) {
    return {
      successful: 0,
      failed: subscribers.length,
      errors: [
        `Email service not configured. Set up ${provider.name.toUpperCase()} in your environment.`,
      ],
    };
  }

  const subject = options.subject || newsletter.title;

  // Prepare emails with unsubscribe links and RFC 8058 headers
  const emails: EmailOptions[] = subscribers.map((subscriber) => {
    const unsubscribeUrl = `${options.baseUrl}/unsubscribe/${subscriber.unsubscribeToken}`;
    const emailContent = `
      ${newsletter.content}
      <hr style="margin: 32px 0; border: none; border-top: 1px solid #eee;">
      <p style="font-size: 12px; color: #666; text-align: center;">
        <a href="${unsubscribeUrl}" style="color: #666;">Unsubscribe</a> from this newsletter
      </p>
    `;

    return {
      to: subscriber.email,
      subject,
      html: emailContent,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  });

  // Use batch API if provider supports it
  if (provider.sendBatch) {
    // Send in batches of 10 to avoid rate limits
    const batchSize = 10;
    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize);
      const batchResults = await provider.sendBatch(batch);

      batchResults.forEach((sendResult, index) => {
        if (sendResult.success) {
          result.successful++;
        } else {
          result.failed++;
          if (sendResult.error) {
            const subscriberEmail = subscribers[i + index]?.email || "unknown";
            result.errors.push(`${subscriberEmail}: ${sendResult.error}`);
          }
        }
      });

      // Small delay between batches
      if (i + batchSize < emails.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } else {
    // Fall back to sequential sending
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const subscriber = subscribers[i];
      if (!email || !subscriber) continue;

      const sendResult = await provider.sendEmail(email);

      if (sendResult.success) {
        result.successful++;
      } else {
        result.failed++;
        if (sendResult.error) {
          result.errors.push(`${subscriber.email}: ${sendResult.error}`);
        }
      }
    }
  }

  return result;
}

/** Wrap newsletter content with email-safe styles */
export function wrapNewsletterContent(content: string, title: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${title}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${content}
    </body>
    </html>
  `;
}
