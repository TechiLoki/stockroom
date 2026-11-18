#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE stockroom_app NOLOGIN;
SELECT format('CREATE ROLE stockroom_auth NOINHERIT LOGIN PASSWORD %L', :'password') \gexec
GRANT stockroom_app TO stockroom_auth;
SQL
