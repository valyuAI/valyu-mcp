# stdio MCP server. Pass the key at run time, never at build time:
#   docker run --rm -i -e VALYU_API_KEY valyu-mcp
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY tsconfig.json stdio.ts ./
COPY lib ./lib

USER node
CMD ["node", "node_modules/tsx/dist/cli.mjs", "stdio.ts"]
