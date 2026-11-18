FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm test
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/fixtures ./fixtures
COPY --from=build --chown=node:node /app/scripts/smoke.mjs ./scripts/smoke.mjs
USER node
EXPOSE 8080
CMD ["node","dist/server/main.js"]
