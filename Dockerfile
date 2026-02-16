# Backend Dockerfile - Multi-stage build for production
# NOTE: Build context must be the workspace root (not ./backend) for consistency
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY milkly-backend/package.json milkly-backend/bun.lock* ./
RUN bun install --frozen-lockfile

# Generate Prisma Client
FROM deps AS prisma
COPY milkly-backend/prisma ./prisma
RUN bunx prisma generate

# Production stage
FROM base AS runner
WORKDIR /app

# Copy dependencies and generated Prisma client
COPY --from=deps /app/node_modules ./node_modules
COPY --from=prisma /app/node_modules/.prisma ./node_modules/.prisma

# Copy application code
COPY milkly-backend/ .

# Make entrypoint executable
RUN chmod +x docker-entrypoint.sh

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun run -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Use entrypoint to run migrations before starting
ENTRYPOINT ["./docker-entrypoint.sh"]

# Start the application
CMD ["bun", "run", "src/index.ts"]
