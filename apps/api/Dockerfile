# Build context MUST be the repo root (this Dockerfile copies workspace packages), e.g.:
#   docker build -f apps/api/Dockerfile -t cortex-api .
#
# apps/api/Dockerfile.dockerignore (sibling of this file, not "apps/api/.dockerignore")
# keeps node_modules/.env/etc. out of the build context. Verified locally: with a
# repo-root build context, BuildKit reads "<dockerfile>.dockerignore" next to the
# Dockerfile named by -f, in preference to a root .dockerignore; a plain
# "apps/api/.dockerignore" is NOT read at all in this configuration -- confirmed by
# a throwaway COPY-and-ls test before settling on this file's name.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable

# Copy just enough of the workspace manifest surface for `pnpm install` to
# resolve the lockfile before pulling in full source (better layer caching).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/api ./apps/api

# As of Phase 1a @cortex/api DOES have runtime workspace dependencies: @cortex/core
# (services) and @cortex/shared (zod DTOs). Both ship as compiled dist/ -- Node cannot
# require TypeScript source -- so the build must cover them, not just apps/api. The
# trailing "..." on the filter is what pulls dependencies into both commands; without it
# `node dist/main.js` dies at startup on an unresolvable @cortex/core import.
# (@cortex/config remains build-time only: tsconfig.base.json / eslint.base.mjs.)
RUN pnpm install --frozen-lockfile --filter @cortex/api...
RUN pnpm --filter @cortex/api... build

# pnpm v10+ refuses `deploy` from a shared workspace lockfile unless the
# workspace has injected dependencies enabled (this repo doesn't); confirmed
# locally that plain `pnpm deploy` fails with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE
# and that `--legacy` fixes it. `--prod` prunes devDependencies out of the
# deployed node_modules. The deploy output at /app also includes the dist/
# built above (deploy copies the whole package directory), which is why the
# final stage below only needs to cherry-pick package.json/node_modules/dist.
RUN pnpm --filter @cortex/api deploy --prod --legacy /app

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# node:22-alpine ships a non-root "node" user (uid/gid 1000) out of the box -- run as
# it rather than root. --chown on each COPY (not a separate `RUN chown -R`) avoids an
# extra full-tree-walking layer on top of files that are already being copied.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node

EXPOSE 3001

# Plain `node -e` http probe instead of curl/wget: alpine's base image has neither
# installed, and this avoids adding a package just for the healthcheck. Exits 0 only on
# an actual 200 from /health; any connection error/non-200 exits 1 (unhealthy).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
