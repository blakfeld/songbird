FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Next bakes rewrite destinations into the build, so the backend URL is a build arg.
ARG SONGBIRD_API_URL=http://backend:8080
ENV SONGBIRD_API_URL=$SONGBIRD_API_URL
RUN pnpm build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/server-wrapper.mjs ./server-wrapper.mjs
USER node
EXPOSE 3000
# The wrapper, not server.js, so SIGTERM drains in-flight streams instead of exiting at once.
CMD ["node", "server-wrapper.mjs"]
