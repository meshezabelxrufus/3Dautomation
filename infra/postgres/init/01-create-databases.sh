#!/bin/sh
# Runs once, on the first start of an EMPTY pg_data volume (official postgres image behaviour).
# Creates one database + login role for the web app and one for n8n.
# Each role owns only its own database; PUBLIC cannot connect to either,
# so app_user cannot reach the n8n database and vice versa.
set -eu

: "${APP_DB_NAME:?APP_DB_NAME is required}"
: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
: "${N8N_DB_NAME:?N8N_DB_NAME is required}"
: "${N8N_DB_USER:?N8N_DB_USER is required}"
: "${N8N_DB_PASSWORD:?N8N_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "${POSTGRES_DB:-postgres}" \
  -v app_db="$APP_DB_NAME" -v app_user="$APP_DB_USER" -v app_pw="$APP_DB_PASSWORD" \
  -v n8n_db="$N8N_DB_NAME" -v n8n_user="$N8N_DB_USER" -v n8n_pw="$N8N_DB_PASSWORD" <<'EOSQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pw';
CREATE DATABASE :"app_db" OWNER :"app_user";
REVOKE ALL ON DATABASE :"app_db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"app_db" TO :"app_user";

CREATE ROLE :"n8n_user" LOGIN PASSWORD :'n8n_pw';
CREATE DATABASE :"n8n_db" OWNER :"n8n_user";
REVOKE ALL ON DATABASE :"n8n_db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"n8n_db" TO :"n8n_user";
EOSQL

echo "init: created databases '$APP_DB_NAME' and '$N8N_DB_NAME'"
