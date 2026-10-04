#!/bin/sh
# Verify the local Docker stack: compose config, container health, HTTP health,
# database connectivity + isolation, n8n availability, secret hygiene.
#
#   sh scripts/verify-stack.sh               # checks against the running stack
#   sh scripts/verify-stack.sh --persistence # also runs `down` + `up -d` and proves data survived
set -eu
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "verify: .env missing. Run: sh scripts/init-env.sh" >&2; exit 1; }
set -a; . ./.env; set +a

WEB_URL="http://localhost:${WEB_HOST_PORT:-3100}"
N8N_URL="http://localhost:${N8N_HOST_PORT:-5680}"
N8N_ENABLED=0
case ",${COMPOSE_PROFILES:-}," in *,n8n,*) N8N_ENABLED=1 ;; esac

FAILED=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
check() { desc="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi; }

psql_as() { # psql_as <user> <password> <db> <sql>
  docker compose exec -T -e PGPASSWORD="$2" postgres \
    psql -h 127.0.0.1 -U "$1" -d "$3" -tAc "$4"
}

wait_healthy() { # wait_healthy <service> <timeout-seconds>
  i=0
  while [ "$i" -lt "$2" ]; do
    cid=$(docker compose ps -q "$1" 2>/dev/null || true)
    if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = "healthy" ]; then
      return 0
    fi
    i=$((i + 2)); sleep 2
  done
  return 1
}

services="postgres web"
[ "$N8N_ENABLED" = 1 ] && services="postgres n8n web"

run_checks() {
  echo "== Compose"
  check "docker compose config is valid" docker compose config --quiet

  echo "== Containers"
  for s in $services; do check "$s is healthy" wait_healthy "$s" 120; done

  echo "== Web app"
  body=$(curl -fsS "$WEB_URL/api/health" 2>/dev/null || true)
  if printf '%s' "$body" | grep -q '"status":"ok"'; then pass "GET $WEB_URL/api/health -> ok"; else fail "GET $WEB_URL/api/health -> $body"; fi
  if printf '%s' "$body" | grep -q '"database":{"status":"ok"'; then pass "web -> postgres connectivity"; else fail "web -> postgres connectivity"; fi
  if [ "$N8N_ENABLED" = 1 ]; then
    if printf '%s' "$body" | grep -q '"n8n":{"status":"ok"'; then pass "web -> n8n connectivity"; else fail "web -> n8n connectivity"; fi
  fi
  check "GET $WEB_URL/ (frontend) returns 200" curl -fsS -o /dev/null "$WEB_URL/"

  echo "== Database"
  check "app_user can query '$APP_DB_NAME'" psql_as "$APP_DB_USER" "$APP_DB_PASSWORD" "$APP_DB_NAME" "select 1"
  check "n8n_user can query '$N8N_DB_NAME'" psql_as "$N8N_DB_USER" "$N8N_DB_PASSWORD" "$N8N_DB_NAME" "select 1"
  if psql_as "$APP_DB_USER" "$APP_DB_PASSWORD" "$N8N_DB_NAME" "select 1" >/dev/null 2>&1; then
    fail "app_user is denied access to '$N8N_DB_NAME'"
  else
    pass "app_user is denied access to '$N8N_DB_NAME'"
  fi
  check "postgres reachable from host on 127.0.0.1:${POSTGRES_HOST_PORT:-5434}" nc -z 127.0.0.1 "${POSTGRES_HOST_PORT:-5434}"

  echo "== Schema"
  mid=$(docker compose ps -a -q migrate 2>/dev/null || true)
  if [ -n "$mid" ] && [ "$(docker inspect -f '{{.State.ExitCode}}' "$mid" 2>/dev/null)" = "0" ]; then pass "migrate service completed (exit 0)"; else fail "migrate service completed (exit 0)"; fi
  tables=$(psql_as "$APP_DB_USER" "$APP_DB_PASSWORD" "$APP_DB_NAME" "select count(*) from information_schema.tables where table_schema='public' and table_name in ('projects','concepts','revisions','final_designs','final_views','project_events','workflow_status_transitions')" 2>/dev/null || echo 0)
  if [ "$tables" = 7 ]; then pass "workflow tables present (7/7)"; else fail "workflow tables present ($tables/7)"; fi
  transitions=$(psql_as "$APP_DB_USER" "$APP_DB_PASSWORD" "$APP_DB_NAME" "select count(*) from workflow_status_transitions" 2>/dev/null || echo 0)
  if [ "${transitions:-0}" -gt 0 ]; then pass "state transitions seeded ($transitions)"; else fail "state transitions seeded"; fi

  if [ "$N8N_ENABLED" = 1 ]; then
    echo "== n8n"
    check "GET $N8N_URL/healthz" curl -fsS -o /dev/null "$N8N_URL/healthz"
    check "GET $N8N_URL/healthz/readiness (DB connected)" curl -fsS -o /dev/null "$N8N_URL/healthz/readiness"
    check "editor UI served at $N8N_URL/" curl -fsS -o /dev/null "$N8N_URL/"
    tables=$(psql_as "$N8N_DB_USER" "$N8N_DB_PASSWORD" "$N8N_DB_NAME" "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)
    if [ "${tables:-0}" -gt 10 ]; then pass "n8n schema stored in Postgres ($tables tables)"; else fail "n8n schema stored in Postgres ($tables tables)"; fi
  fi

  echo "== Secrets"
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then fail ".env is NOT tracked by git"; else pass ".env is not tracked by git"; fi
  check ".env is ignored by git" git check-ignore -q .env
}

run_checks

if [ "${1:-}" = "--persistence" ]; then
  echo "== Persistence (docker compose down -> up -d)"
  psql_as "$APP_DB_USER" "$APP_DB_PASSWORD" "$APP_DB_NAME" \
    "create table if not exists _verify_persistence (token text primary key); delete from _verify_persistence;" >/dev/null
  token=$(openssl rand -hex 8)
  psql_as "$APP_DB_USER" "$APP_DB_PASSWORD" "$APP_DB_NAME" "insert into _verify_persistence values ('$token')" >/dev/null
  n8n_before=""
  if [ "$N8N_ENABLED" = 1 ]; then
    n8n_before=$(psql_as "$N8N_DB_USER" "$N8N_DB_PASSWORD" "$N8N_DB_NAME" \
      "select id || '|' || (select count(*) from migrations) from \"user\" order by \"createdAt\" limit 1")
  fi

  docker compose down
  docker compose up -d
  for s in $services; do check "$s healthy again after restart" wait_healthy "$s" 180; done

  after=$(psql_as "$APP_DB_USER" "$APP_DB_PASSWORD" "$APP_DB_NAME" "select token from _verify_persistence" 2>/dev/null || true)
  if [ "$after" = "$token" ]; then pass "app database row survived restart"; else fail "app database row survived restart (got '$after')"; fi
  psql_as "$APP_DB_USER" "$APP_DB_PASSWORD" "$APP_DB_NAME" "drop table if exists _verify_persistence" >/dev/null

  if [ "$N8N_ENABLED" = 1 ]; then
    n8n_after=$(psql_as "$N8N_DB_USER" "$N8N_DB_PASSWORD" "$N8N_DB_NAME" \
      "select id || '|' || (select count(*) from migrations) from \"user\" order by \"createdAt\" limit 1")
    if [ -n "$n8n_before" ] && [ "$n8n_before" = "$n8n_after" ]; then pass "n8n data survived restart (same instance user + migrations)"; else fail "n8n data survived restart ($n8n_before vs $n8n_after)"; fi
    if docker compose logs n8n 2>&1 | grep -qi "mismatching encryption keys"; then fail "n8n encryption key consistent"; else pass "n8n encryption key consistent (no key mismatch)"; fi
  fi
fi

echo
if [ "$FAILED" = 0 ]; then echo "verify: ALL CHECKS PASSED"; else echo "verify: SOME CHECKS FAILED" >&2; exit 1; fi
