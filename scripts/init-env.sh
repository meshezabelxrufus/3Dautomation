#!/bin/sh
# Create .env from .env.example, replacing each __GENERATE__ with a unique random hex secret.
# Refuses to overwrite an existing .env (it holds the n8n encryption key and DB passwords).
set -eu
cd "$(dirname "$0")/.."

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
