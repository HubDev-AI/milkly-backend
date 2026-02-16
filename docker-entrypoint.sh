#!/bin/sh
set -e

echo "🔄 Running database migrations..."

# Wait for database to be ready (with timeout)
MAX_RETRIES=30
RETRY_COUNT=0

until bunx prisma db push --skip-generate 2>/dev/null; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "❌ Database not ready after $MAX_RETRIES attempts, exiting..."
    exit 1
  fi
  echo "⏳ Waiting for database... (attempt $RETRY_COUNT/$MAX_RETRIES)"
  sleep 2
done

echo "✅ Database schema synchronized"

# Execute the main command
exec "$@"
