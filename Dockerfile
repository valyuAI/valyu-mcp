# stdio MCP server. Pass the key at run time, never at build time:
#   docker run --rm -i -e VALYU_API_KEY valyu-mcp

# Base image pinned by digest: a re-pushed tag cannot change what is built.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

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
