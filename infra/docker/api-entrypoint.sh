#!/bin/sh
set -eu

cd /app/apps/api

# Rebuild DATABASE_URL with a URL-encoded password. secret-bootstrap mints tokens as
# base64, which can contain + / = and break the postgres URL parsing (prisma P1013
# 'invalid port number'). python3 is in the image; this is robust for any token value.
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  PGPW_URL=$(python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['POSTGRES_PASSWORD'],safe=''))")
  export DATABASE_URL="postgresql://${POSTGRES_USER:-postgres}:${PGPW_URL}@postgres:5432/${POSTGRES_DB:-headlessx}?schema=public"
fi

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
