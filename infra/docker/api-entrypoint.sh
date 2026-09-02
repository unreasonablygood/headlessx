#!/bin/sh
set -eu

cd /app/apps/api

# Build DATABASE_URL from the fixed root-owned file. The password is never read
# from a Coolify environment row and never appears in argv or output.
POSTGRES_PASSWORD_FILE=/run/secrets/headlessx-postgres-password
[ -r "${POSTGRES_PASSWORD_FILE}" ] || {
  echo "HeadlessX PostgreSQL credential file is unavailable." >&2
  exit 1
}
PGPW_URL=$(python3 -c "import pathlib,urllib.parse;print(urllib.parse.quote(pathlib.Path('/run/secrets/headlessx-postgres-password').read_text(),safe=''))")
export DATABASE_URL="postgresql://${POSTGRES_USER:-postgres}:${PGPW_URL}@postgres:5432/${POSTGRES_DB:-headlessx}?schema=public"
unset PGPW_URL

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
