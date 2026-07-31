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

# @cortex/api has no *runtime* workspace dependencies (its only workspace
# dependency, @cortex/config, is a devDependency supplying tsconfig.base.json /
# eslint.base.mjs -- build-time only, never imported by src/). Installing the
# full dependency graph (incl. devDependencies) is still required here because
# `nest build` itself, and apps/api/tsconfig.json's `extends`, need it.
RUN pnpm install --frozen-lockfile --filter @cortex/api...
RUN pnpm --filter @cortex/api build

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
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/main.js"]
