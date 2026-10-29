#!/usr/bin/env bash
# Starts Stride v1 (Django) on http://localhost:$PORT
#
#   ./run.sh            start the site
#   ./run.sh --reset    rebuild the database first: 01_schema.sql, migrate, 02_seed.sql
#
# Settings and passwords come from .env. The MySQL account in DB_USER must
# exist already: run db/00_account.sql once as root (see README).
set -euo pipefail
cd "$(dirname "$0")"

# .env -> environment (variables already set in the shell win)
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  if [[ -z "${!key:-}" ]]; then export "$key=$value"; fi
done < .env

# Python environment
if [[ ! -x .venv/bin/python ]]; then
  echo "Creating .venv and installing requirements..."
  if command -v uv >/dev/null; then
    uv venv -q .venv && uv pip install -q --python .venv/bin/python -r requirements.txt
  else
    python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
  fi
fi
PY=.venv/bin/python

MYSQL=$(command -v mariadb || command -v mysql || true)
sql() { "$MYSQL" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$@"; }

if [[ "${1:-}" == "--reset" ]]; then
  [[ -z "$MYSQL" ]] && { echo "--reset needs the mysql or mariadb command-line client"; exit 1; }
  echo "1/3  db/01_schema.sql   (drops and recreates $DB_NAME)"
  sql < db/01_schema.sql
  echo "2/3  manage.py migrate  (Django's own tables: sessions, admin log, permissions)"
  $PY manage.py migrate --verbosity 0
  echo "3/3  db/02_seed.sql     (sample users, catalogue and four weeks of logs)"
  sql < db/02_seed.sql
fi

if [[ -n "$MYSQL" ]] && ! sql -N -e "SELECT 1 FROM $DB_NAME.Users LIMIT 1" >/dev/null 2>&1; then
  echo "Can't read $DB_NAME.Users as $DB_USER@$DB_HOST:$DB_PORT."
  echo "  - account missing?  sudo mariadb < db/00_account.sql   (or: mysql -u root -p < db/00_account.sql)"
  echo "  - database empty?   ./run.sh --reset"
  exit 1
fi

echo
echo "  Stride v1:    http://localhost:$PORT"
echo "  Admin panel:  http://localhost:$PORT/admin/   ($SEED_ADMIN_USER / $SEED_ADMIN_PASSWORD)"
echo
exec $PY manage.py runserver "0.0.0.0:$PORT"
