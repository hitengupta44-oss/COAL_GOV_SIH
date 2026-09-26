#!/usr/bin/env bash
# Builds a throwaway Postgres database, applies the Supabase stubs, schema
# and every migration in order, then runs the policy/workflow tests.
#
#   PGPASSWORD=... ./tests/run_tests.sh
#
# Needs Postgres 15+ with PostGIS, and `pip install psycopg2-binary`.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${PGDATABASE:-coal_test}
export PGHOST=${PGHOST:-localhost} PGUSER=${PGUSER:-postgres}
dropdb --if-exists "$DB" && createdb "$DB"
for f in tests/supabase_stub.sql schema.sql migration_0{2,3,4,5,6,7,8,9}_*.sql; do
  echo "applying $f"
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1 | { grep -v NOTICE || true; }
done
PGDATABASE=$DB python3 tests/test_policies.py
