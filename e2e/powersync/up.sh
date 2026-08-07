#!/usr/bin/env bash
# Start PowerSync Service against the local Supabase stack.
#
# PORTABILITY NOTE. An earlier draft used `--network host`, which is the obvious choice on a
# Linux runner and does not work on Docker Desktop (Windows/macOS), where the container would
# get its own stack and never see Postgres. Published ports plus `host.docker.internal` behave
# identically in both places -- on Linux the `--add-host ...:host-gateway` line is what makes
# that name resolve, and Docker Desktop provides it already.
#
# Reachability, once this is up:
#   host      -> http://127.0.0.1:8080
#   emulator  -> http://10.0.2.2:8080   (the emulator's alias for the host loopback)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NAME="${POWERSYNC_CONTAINER:-cortex-powersync}"
HOST_PORT="${POWERSYNC_PORT:-8080}"

# The port the service listens on INSIDE the container. PowerSync's own README documents
# `docker run -p 8080:80`, and that is wrong for the current image: v1.23.3 logs
# "Running on port 8080" at boot. Mapping to 80 produced a container that was Up, with the port
# apparently published, and every probe answering "Empty reply from server" -- Docker's proxy
# accepting the connection with nothing behind it. Confirmed by reading /proc/net/tcp inside.
CONTAINER_PORT=8080

: "${SUPABASE_URL:?set SUPABASE_URL, e.g. http://127.0.0.1:54321}"

# Supabase's own container, so `psql` need not exist on the host. Windows developers do not have
# it and neither does a bare runner; the database image always does.
DB_CONTAINER="$(docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1)"
if [ -z "$DB_CONTAINER" ]; then
  echo "::error::no running supabase_db_* container; run \`pnpm exec supabase start\` first" >&2
  exit 1
fi

# Bucket storage gets its OWN database. PowerSync's internal tables have no business in the
# schema being replicated, and keeping them out means `supabase db reset` cannot half-wipe them.
# Created here rather than in supabase/migrations/ because those describe the product's schema
# and must not gain a test-only database.
if ! docker exec "$DB_CONTAINER" psql -U postgres -d postgres -tAc \
      "select 1 from pg_database where datname='powersync_storage'" | grep -q 1; then
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -c "create database powersync_storage"
  echo "[powersync] created database powersync_storage"
fi

# host.docker.internal, not 127.0.0.1: these URIs are resolved INSIDE the container.
export PS_REPLICATION_URI="postgresql://postgres:postgres@host.docker.internal:54322/postgres"
export PS_STORAGE_URI="postgresql://postgres:postgres@host.docker.internal:54322/powersync_storage"
# The JWKS endpoint is behind Kong, which the container also reaches through the host alias.
export PS_JWKS_URI="$(printf '%s' "$SUPABASE_URL" \
  | sed -e 's#http://127\.0\.0\.1#http://host.docker.internal#' \
        -e 's#http://localhost#http://host.docker.internal#')/auth/v1/.well-known/jwks.json"

# `base64` differs between GNU (-w0) and BSD (-b0); node is already a hard requirement of this
# repo and spells it the same way everywhere.
#
# Read from STDIN (fd 0) rather than by path. Under Git Bash on Windows, $HERE is a POSIX path
# like /c/Users/... and node is a native Windows binary that reads that as C:\c\Users\... --
# the redirect keeps path translation in the shell, which is the only thing that understands it.
CONFIG_B64="$(node -e "process.stdout.write(require('fs').readFileSync(0).toString('base64'))" < "$HERE/config.yaml")"

# Same class of problem for the bind mount: Docker needs a path its own daemon can resolve.
# `pwd -W` exists only under MSYS/Git Bash and prints the Windows form; elsewhere the POSIX
# path is already correct.
if command -v cygpath >/dev/null 2>&1; then
  MOUNT_SRC="$(cygpath -m "$REPO/packages/sync/src/sync-rules.yaml")"
else
  MOUNT_SRC="$REPO/packages/sync/src/sync-rules.yaml"
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  --add-host host.docker.internal:host-gateway \
  -e POWERSYNC_CONFIG_B64="$CONFIG_B64" \
  -e PS_REPLICATION_URI -e PS_STORAGE_URI -e PS_JWKS_URI \
  -v "$MOUNT_SRC:/config/sync-rules.yaml:ro" \
  journeyapps/powersync-service:latest >/dev/null

echo "[powersync] container started, waiting for liveness on :${HOST_PORT}"
for _ in $(seq 1 60); do
  # /probes/liveness answers as soon as the process is up; /probes/startup is the one that also
  # means replication has initialised, which is what the tests actually depend on. There is no
  # /probes/ready on v1.23.3 -- it answers 404, and an earlier version of this script reported
  # that as "live but not ready yet" forever, which read as a stalled service rather than as a
  # wrong URL.
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/probes/startup" >/dev/null 2>&1; then
    echo "[powersync] up on :${HOST_PORT} (liveness + startup both green)"
    exit 0
  fi
  # A container that exited is never going to become live; say so now rather than in 2 minutes.
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
    echo "::error::powersync container exited" >&2
    docker logs "$NAME" >&2
    exit 1
  fi
  sleep 2
done

echo "::error::powersync did not become live within 120s" >&2
docker logs "$NAME" >&2
exit 1
