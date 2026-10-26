#!/bin/sh
# Railway mounts volumes owned by root. Give the data folder to the unprivileged "node" user, then run
# the site as that user so a compromise of the web process can't touch the rest of the container.
set -e
if [ "$(id -u)" = "0" ]; then
  for d in "$RAILWAY_VOLUME_MOUNT_PATH" "$TEAMCODE_DATA"; do
    [ -n "$d" ] && mkdir -p "$d" && chown -R node:node "$d"
  done
  exec su-exec node "$@"
fi
exec "$@"
