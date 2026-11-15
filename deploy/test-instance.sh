#!/bin/sh
# Test instance of a branch (default: main) next to live, on the same server.
#
#   sh deploy/test-instance.sh start      build/update, first start copies the live database
#   sh deploy/test-instance.sh neu-kopie  replace the test database with a fresh copy of live
#   sh deploy/test-instance.sh stop       stop the test instance (data stays)
#   sh deploy/test-instance.sh entfernen  stop and delete the test instance and its database
#
# Live is only read: one pg_dump of its database, its .env and theme are copied.
# The test instance has no worker (no mailbox sync, nothing is sent, no automation),
# SEND_MODE=drafts_only and listens on 127.0.0.1:3100 only. Open it through a tunnel:
#   ssh -L 3100:127.0.0.1:3100 root@<server>   then http://localhost:3100
# Note: buttons that act at Amazon or weclapp (refund, credit note draft) use the
# copied live credentials and are real actions there.
set -eu
LIVE_DIR="${SUPPORTX_LIVE_DIR:-/opt/supportx}"
TEST_DIR="${SUPPORTX_TEST_DIR:-/opt/supportx-test}"
BRANCH="${SUPPORTX_TEST_BRANCH:-main}"
LIVE="docker compose -f $LIVE_DIR/deploy/docker-compose.prod.yml --env-file $LIVE_DIR/.env"
TEST="docker compose -f $TEST_DIR/deploy/docker-compose.test.yml --env-file $TEST_DIR/.env"

copy_db() {
  echo "Kopiere die Live-Datenbank in die Testinstanz …"
  $TEST up -d --wait db
  $TEST stop server 2>/dev/null || true
  $LIVE exec -T db pg_dump -U supportx -Fc supportx > "$TEST_DIR/live-copy.dump"
  $TEST exec -T db psql -q -U supportx -d postgres -c "DROP DATABASE IF EXISTS supportx WITH (FORCE)" -c "CREATE DATABASE supportx OWNER supportx"
  $TEST exec -T db pg_restore -U supportx -d supportx --no-owner < "$TEST_DIR/live-copy.dump"
  rm -f "$TEST_DIR/live-copy.dump"
  touch "$TEST_DIR/.db-copied"
}

case "${1:-start}" in
  start)
    if [ ! -d "$TEST_DIR/.git" ]; then git clone -q "$(git -C "$LIVE_DIR" remote get-url origin)" "$TEST_DIR"; fi
    git -C "$TEST_DIR" fetch -q origin "$BRANCH"
    git -C "$TEST_DIR" reset -q --hard "origin/$BRANCH"
    cp "$LIVE_DIR/.env" "$TEST_DIR/.env"; chmod 600 "$TEST_DIR/.env"
    rm -rf "$TEST_DIR/theme"; if [ -d "$LIVE_DIR/theme" ]; then cp -r "$LIVE_DIR/theme" "$TEST_DIR/theme"; else mkdir "$TEST_DIR/theme"; fi
    [ -f "$TEST_DIR/.db-copied" ] || copy_db
    $TEST up -d --build server
    echo "Testinstanz läuft auf Stand $(git -C "$TEST_DIR" log -1 --format='%h %s')."
    echo "Live ist unverändert: $(git -C "$LIVE_DIR" log -1 --format='%h %s')."
    ;;
  neu-kopie) copy_db; $TEST up -d server ;;
  stop) $TEST stop ;;
  entfernen) $TEST down -v; rm -rf "$TEST_DIR" ;;
  *) echo "start | neu-kopie | stop | entfernen"; exit 2 ;;
esac
