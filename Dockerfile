# SovereignAI — zero runtime dependencies, so this image is just Node + our source.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    SOVEREIGN_HOST=0.0.0.0 \
    SOVEREIGN_PORT=4321

# Set SOVEREIGN_TOKEN to reach the API/UI from outside the container
# (non-localhost requests are refused without it, by design).
EXPOSE 4321
VOLUME /app/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:4321/api/status > /dev/null || exit 1

CMD ["node", "--no-warnings", "bin/sovereign.js", "start"]
