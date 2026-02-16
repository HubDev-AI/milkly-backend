import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { emailOTP } from "better-auth/plugins";
import { prisma } from "./prisma";
import { env } from "./env";
import { sendOTPEmail } from "./services/email";
import { logInfo } from "./lib/debug";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BACKEND_URL,
  basePath: "/api/v1/auth",
  trustedOrigins: [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "https://*.milkly.app",
    env.BACKEND_URL,
  ],
  plugins: [
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        logInfo(
          "Auth",
          `sendVerificationOTP called - type: ${type}, email: ${email}, DEV_MODE: ${env.DEV_MODE}`,
        );

        if (type !== "sign-in") return;

        // In dev mode, skip sending email and log the OTP
        if (env.DEV_MODE) {
          logInfo("DEV MODE", `OTP for ${email}: ${otp}`);
          return;
        }

        await sendOTPEmail(email, String(otp));
      },
    }),
  ],
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
    },
    // CSRF disabled in dev (cross-port requires it), enabled in production
    disableCSRFCheck: env.DEV_MODE === true,
    defaultCookieAttributes: {
      // "none" needed for cross-port dev, "lax" is more secure for same-origin prod
      sameSite: env.DEV_MODE ? "none" : "lax",
      secure: true,
      partitioned: env.DEV_MODE === true,
    },
  },
});
