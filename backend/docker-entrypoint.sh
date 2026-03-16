#!/bin/sh
set -e
# Fix ownership on data volumes at startup.
# Named Docker volumes may be created as root; chown before dropping privileges.
chown -R appuser:appuser /app/data 2>/dev/null || true
exec gosu appuser "$@"
