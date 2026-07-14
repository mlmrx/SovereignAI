# SovereignAI — zero runtime dependencies, so this image is just Node + our source.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    SOVEREIGN_HOME=/state \
    SOVEREIGN_HOST=0.0.0.0 \
    SOVEREIGN_PORT=4321

# Run as a non-root user. The state directory is owned by that user so the app
# can write its SQLite database and config without root. A hostile request that
# escapes the app process therefore lands as an unprivileged user, not root.
RUN mkdir -p /state && \
    addgroup -S sovereign && adduser -S -G sovereign -h /state sovereign && \
    chown -R sovereign:sovereign /state /app
USER sovereign

# Set SOVEREIGN_TOKEN to reach the API/UI from outside the container. When set,
# every API request (including this container's healthcheck) must send it.
EXPOSE 4321
# One durable state root: /state/sovereign.config.json + /state/data/sovereign.db.
VOLUME /state

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- --header="Authorization: Bearer ${SOVEREIGN_TOKEN}" http://127.0.0.1:4321/api/status > /dev/null || exit 1

CMD ["node", "--no-warnings", "bin/sovereign.js", "start"]
