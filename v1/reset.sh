#!/usr/bin/env bash
# Deletes everything in fitness_tracker_v1 and loads the sample data again.
# Doesn't start the site: run ./run.sh afterwards.
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a

sql() { "$(command -v mariadb || command -v mysql)" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$@"; }

sql < db/01_schema.sql                          # drop and recreate the database
.venv/bin/python manage.py migrate --verbosity 0 # Django's own tables
sql < db/02_seed.sql                            # sample data
sql -N "$DB_NAME" -e "SELECT CONCAT('Reset done: ', COUNT(*), ' users') FROM Users"
