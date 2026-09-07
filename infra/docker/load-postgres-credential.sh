#!/bin/sh

POSTGRES_PASSWORD_FILE=/run/secrets/headlessx-postgres-password
[ -r "${POSTGRES_PASSWORD_FILE}" ] || {
  echo "HeadlessX PostgreSQL credential file is unavailable." >&2
  exit 1
}

PGPW_URL=$(python3 -c 'import pathlib,sys,urllib.parse;print(urllib.parse.quote(pathlib.Path(sys.argv[1]).read_text(), safe=""), end="")' "${POSTGRES_PASSWORD_FILE}")
export DATABASE_URL="postgresql://${POSTGRES_USER:-postgres}:${PGPW_URL}@postgres:5432/${POSTGRES_DB:-headlessx}?schema=public"
unset PGPW_URL POSTGRES_PASSWORD_FILE
