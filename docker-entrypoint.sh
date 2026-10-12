#!/usr/bin/env bash
set -euo pipefail

# Without a volume the database lands on the Machine's root filesystem, which every deploy
# wipes, and the app would run normally until the data quietly vanished.
if ! mountpoint -q /app/data; then
  echo "docker-entrypoint: no volume is mounted at /app/data; refusing to start." >&2
  exit 1
fi
case "${SONGBIRD_DATABASE_URL:-}" in
  sqlite:///app/data/*) ;;
  *)
    echo "docker-entrypoint: SONGBIRD_DATABASE_URL must point under /app/data, the volume." >&2
    exit 1
    ;;
esac

# A fresh Fly volume is root-owned, and the services must not run as root.
chown songbird:songbird /app/data

# Both services drain in-flight streams on SIGTERM, so pass it on rather than exiting.
# Installed before either service starts so an early signal can't orphan them.
api='' web='' signalled=0
stop() { kill -TERM ${api:+"$api"} ${web:+"$web"} 2>/dev/null || true; }
trap 'signalled=1; stop' TERM INT

# setpriv is backgrounded directly, not via a function, because a function would run in a
# forked subshell and $! would then name the subshell rather than the service it must signal.
setpriv --reuid=songbird --regid=songbird --init-groups songbird-api &
api=$!
setpriv --reuid=songbird --regid=songbird --init-groups node /app/web/server-wrapper.mjs &
web=$!
if [[ $signalled == 1 ]]; then stop; fi

# Either service dying alone leaves a Machine that serves nothing useful, so take the other
# down too and exit non-zero so Fly restarts the whole Machine.
wait -n "$api" "$web" || true
stop
for pid in "$api" "$web"; do
  while kill -0 "$pid" 2>/dev/null; do wait "$pid" || true; done
done

if [[ $signalled == 1 ]]; then exit 0; fi
echo "docker-entrypoint: a service exited unexpectedly; stopping the Machine." >&2
exit 1
