FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
COPY dashboard/package.json dashboard/bun.lock ./dashboard/
RUN bun install --frozen-lockfile --ignore-scripts
RUN cd dashboard && bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN cd dashboard && bunx vite build
RUN bun build src/index.ts src/db/migrate.ts --outdir dist --target bun --packages external

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=1930 \
    DATABASE_PATH=/data/postman2api.db

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --ignore-scripts && bun pm cache rm
COPY --from=build /app/dist ./dist
COPY --from=build /app/dashboard/dist ./dashboard/dist
COPY --from=build /app/docs ./docs

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
