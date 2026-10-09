# One image for both roles; APP_ROLE=api|worker selects what runs.
FROM node:22-alpine AS build
WORKDIR /app
# The lock file is written by npm 12 (see packageManager); npm 10 rejects it.
RUN npm install -g npm@12.2.0
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# tini forwards SIGTERM so Nest can finish running work on shutdown.
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
