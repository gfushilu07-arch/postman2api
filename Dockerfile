FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=1930 \
    DATABASE_PATH=/data/postman2api.db

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --ignore-scripts && bun pm cache rm

# The host-side build step creates .docker-context as an immutable snapshot.
# This image only copies that snapshot; it never compiles TypeScript or Vite.
COPY .docker-context/server ./dist
COPY .docker-context/dashboard ./dashboard/dist
COPY .docker-context/docs ./docs

RUN mkdir -p /data
EXPOSE 1930
VOLUME ["/data"]
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD bun -e 'const response = await fetch("http://127.0.0.1:1930/health"); if (!response.ok) process.exit(1)'

CMD ["sh", "-c", "bun dist/db/migrate.js && exec bun dist/index.js"]

FROM runtime AS runtime-browser
USER root
ENV LOGIN_BROWSER_BACKEND=playwright
RUN bunx playwright install --with-deps chromium
