#!/bin/sh
# Create .env from .env.example, replacing each __GENERATE__ with a unique random hex secret.
# Refuses to overwrite an existing .env (it holds the n8n encryption key and DB passwords).
#   scripts/init-env.sh --add-missing   append generated secrets that a newer .env.example added
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--add-missing" ]; then
  [ -f .env ] || { echo "init-env: no .env yet; run without --add-missing" >&2; exit 1; }
  grep -E '^[A-Z0-9_]+=__GENERATE__' .env.example | while IFS= read -r line; do
    key="${line%%=*}"
    if ! grep -q "^${key}=" .env; then
      printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> .env
      echo "init-env: added $key"
    fi
  done
  exit 0
fi

if [ -f .env ]; then
  echo "init-env: .env already exists; not overwriting. Delete it first if you really want new secrets." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "init-env: openssl is required" >&2; exit 1; }

umask 077
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *__GENERATE__*) printf '%s\n' "$(printf '%s' "$line" | sed "s/__GENERATE__/$(openssl rand -hex 32)/")" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env.example > .env

echo "init-env: wrote .env (mode 600). Back up N8N_ENCRYPTION_KEY somewhere safe."
