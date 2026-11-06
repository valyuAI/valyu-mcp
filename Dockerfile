# stdio MCP server. Pass the key at run time, never at build time:
#   docker run --rm -i -e VALYU_API_KEY valyu-mcp

# Base image pinned by digest: a re-pushed tag cannot change what is built.
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

ENV NODE_ENV=production
WORKDIR /app

# The pnpm pinned in package.json, installed only if its tarball matches the
# integrity hash in pnpm-lock.yaml. Install scripts never run.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/install-pnpm.mjs ./scripts/
RUN node scripts/install-pnpm.mjs && pnpm install --frozen-lockfile --prod

COPY tsconfig.json stdio.ts ./
COPY lib ./lib

USER node
CMD ["node", "node_modules/tsx/dist/cli.mjs", "stdio.ts"]
