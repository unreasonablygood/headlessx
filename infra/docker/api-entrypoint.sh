#!/bin/sh
set -eu

cd /app/apps/api

# Both supported production Compose paths mount the database credential at the
# same fixed location. The loader never accepts an environment-value fallback.
. /usr/local/bin/headlessx-load-postgres-credential

MAX_ATTEMPTS="${PRISMA_MIGRATE_MAX_ATTEMPTS:-10}"
ATTEMPT=1

echo "🗄️ Applying Prisma migrations..."

until pnpm exec prisma migrate deploy; do
    if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
        echo "❌ Prisma migration failed after ${MAX_ATTEMPTS} attempts."
        exit 1
    fi

    echo "⚠️ Prisma migration attempt ${ATTEMPT} failed. Retrying in 3 seconds..."
    ATTEMPT=$((ATTEMPT + 1))
    sleep 3
done

echo "✅ Prisma migrations applied."
exec pnpm exec tsx src/server_entry.ts
