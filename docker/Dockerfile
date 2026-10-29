# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.13.0-bookworm-slim@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff
FROM ${NODE_IMAGE} AS source-build
WORKDIR /src
ENV npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY packages/game-client/package.json packages/game-client/
COPY packages/control-core/package.json packages/control-core/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY adapters/stdio/package.json adapters/stdio/
COPY tests/package.json tests/
RUN npm ci --no-progress
COPY . .
RUN npm run build
ARG SAB_SOURCE_COMMIT=unknown
ARG SAB_BUILD_TIMESTAMP=unknown
ARG SAB_WORKTREE_DIRTY=unknown
ENV SAB_SOURCE_COMMIT=${SAB_SOURCE_COMMIT} SAB_BUILD_TIMESTAMP=${SAB_BUILD_TIMESTAMP} SAB_WORKTREE_DIRTY=${SAB_WORKTREE_DIRTY}
RUN node scripts/docker/build.mjs --bundle --output /out

# Use a clean glibc runtime: no npm, node_modules, SDK or source tree.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8 AS bridge-runtime
ARG SAB_UID=1000
ARG SAB_GID=1000
ARG SAB_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="stardew-agent-bridge" \
      org.opencontainers.image.source="https://github.com/amy2022525-sketch/stardew-agent-bridge" \
      org.opencontainers.image.revision="${SAB_SOURCE_COMMIT}" \
      org.opencontainers.image.version="0.2.0-preview.1" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Single-player Stardew MCP container preview"
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${SAB_GID}" sab \
    && useradd --uid "${SAB_UID}" --gid "${SAB_GID}" --home-dir /home/sab --create-home --shell /usr/sbin/nologin sab \
    && mkdir -p /opt/sab /var/lib/sab /run/sab /srv/game /input/mod /var/backups/sab \
    && chown "${SAB_UID}:${SAB_GID}" /var/lib/sab /run/sab /srv/game /input/mod /var/backups/sab /home/sab \
    && chmod 0700 /var/lib/sab /run/sab /srv/game /input/mod /var/backups/sab /home/sab
COPY --from=source-build /usr/local/bin/node /usr/local/bin/node
COPY --from=source-build /out/ /opt/sab/
COPY --from=source-build /usr/local/LICENSE /opt/sab/licenses/node-LICENSE
RUN dpkg-query -W > /opt/sab/metadata/os-packages.tsv && chmod -R a-w /opt/sab
ENV NODE_ENV=production SAB_HOME=/var/lib/sab SAB_WEB_DIST=/opt/sab/web SAB_HTTP_PORT=17655 SAB_RUN_MODE=bridge HOME=/tmp/sab-home
USER ${SAB_UID}:${SAB_GID}
WORKDIR /var/lib/sab
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["/usr/local/bin/node", "/opt/sab/container/healthcheck.mjs"]
ENTRYPOINT ["/usr/local/bin/node", "/opt/sab/container/lease-entrypoint.mjs"]
CMD ["--mode", "bridge"]

FROM bridge-runtime AS game-runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11-utils x11vnc novnc websockify openbox xauth libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libglu1-mesa \
    libsdl2-2.0-0 libopenal1 libopenal-data libicu72 libssl3 libfontconfig1 libfreetype6 \
    libx11-6 libxext6 libxrandr2 libxi6 libxcursor1 libxinerama1 fonts-dejavu-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && chmod u+w /opt/sab/metadata && dpkg-query -W > /opt/sab/metadata/os-packages-game.tsv && chmod a-w /opt/sab/metadata
ENV SAB_RUN_MODE=game HOME=/home/sab DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 ALSOFT_DRIVERS=null SDL_AUDIODRIVER=dummy \
    XDG_DATA_HOME=/home/sab/.local/share XDG_CONFIG_HOME=/home/sab/.config
USER ${SAB_UID}:${SAB_GID}
WORKDIR /srv/game
CMD ["--mode", "game"]
