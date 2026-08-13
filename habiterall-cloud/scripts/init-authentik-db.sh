#!/bin/sh
# Runs once, on first initialisation of the Postgres data volume.
#
# Authentik keeps its own database in the same Postgres server, with its own
# role. It has no access to the habiterall database, and the habiterall app
# role has no access to Authentik's — a compromise of one does not hand over
# the other.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE authentik LOGIN PASSWORD '${AUTHENTIK_DB_PASSWORD}';
  CREATE DATABASE authentik OWNER authentik;
  REVOKE ALL ON DATABASE authentik FROM PUBLIC;
  REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM authentik;
EOSQL

echo "created authentik database and role"
