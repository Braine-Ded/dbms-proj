#!/usr/bin/env bash
# Starts the Fitness Tracker.
#
#   ./run.sh            start the website (database and accounts must already exist)
#   ./run.sh --reset    rebuild the database and its MySQL accounts from
#                       db/01_schema.sql, db/02_seed.sql and db/04_users.sql, then start
#
# Settings and passwords come from .env. A variable set in the shell wins, e.g.
#   MYSQL_PASSWORD=secret ./run.sh --reset
set -e
cd "$(dirname "$0")"

# load .env without overriding variables already set in the shell
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Z_]+$ ]] || continue
    if [ -z "${!key+x}" ]; then export "$key=$value"; fi
  done < .env
fi

MYSQL_USER=${MYSQL_USER:-root}
MYSQL_PASSWORD=${MYSQL_PASSWORD:-root}
MYSQL_HOST=${MYSQL_HOST:-127.0.0.1}
MYSQL_PORT=${MYSQL_PORT:-3306}
PORT=${PORT:-8080}

if [ "$1" = "--reset" ]; then
  echo "Rebuilding fitness_tracker database and accounts..."
  for f in db/01_schema.sql db/02_seed.sql db/04_users.sql; do
    mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" < "$f" > /dev/null
  done
fi

echo "Sign in with:  admin / $ADMIN_PASSWORD   clerk / $CLERK_PASSWORD   viewer / $VIEWER_PASSWORD"
go run . -mysql "$MYSQL_HOST:$MYSQL_PORT" -port "$PORT"
