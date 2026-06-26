# syntax=docker/dockerfile:1
# filepeek — single-file web viewer for the files your agents produce.
# Multi-arch (linux/amd64 + linux/arm64); pure-Python, so no per-arch binaries.
#
# Build (multi-arch):
#   docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/filepeek:latest --push .
# Run (publish to 127.0.0.1 / a tailnet — it exposes read/write access to FILEPEEK_ROOT):
#   docker run --rm -p 127.0.0.1:8765:8765 \
#     -v "$HOME/projects:/root/projects" \
#     -v filepeek-state:/root/.config/filepeek <registry>/filepeek:latest
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# curl: healthcheck. tini: clean PID 1 / signal handling.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first for layer caching.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# App source (the GitHub repo's contents during CI — nothing host-local).
COPY . .

ENV FILEPEEK_PORT=8765 \
    FILEPEEK_ROOT=/root/projects \
    FILEPEEK_STATE_DIR=/root/.config/filepeek

# Served tree + persistent state (permlinks, bookmarks, auth.json, backup config).
RUN mkdir -p /root/projects /root/.config/filepeek
VOLUME ["/root/projects", "/root/.config/filepeek"]

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${FILEPEEK_PORT}/login" >/dev/null || exit 1

# Serve via uvicorn directly (binds 0.0.0.0 INSIDE the container; the real
# boundary is how the port is published — 127.0.0.1/tailnet, see compose). This
# is the same approach as agentpeek and avoids app.py's CLI bind-guard. Note: the
# optional interval backup worker (started only by `python app.py`) does not run
# in this mode. FILEPEEK_ROOT/STATE_DIR are read at import from the env above.
ENTRYPOINT ["/usr/bin/tini", "--", "sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port \"${FILEPEEK_PORT:-8765}\""]
