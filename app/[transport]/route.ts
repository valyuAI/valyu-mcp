/** Streamable HTTP endpoint at /mcp. */

import { buildContext, unauthorizedResponse } from "@/lib/mcp/auth";
import { notFound, serveMcp, type ServeOptions } from "@/lib/mcp/serve";
import { registerTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "@/lib/mcp/server";

/**
 * Connector icons, served from this deployment so every host advertises its
 * own reachable URLs rather than a hardcoded one.
 *
 * The SVG carries a `prefers-color-scheme` switch and covers most clients on
 * its own; the PNGs are there for the ones that refuse to render SVG, split by
 * theme because a single-colour mark on transparent cannot suit both.
 */
function serverIcons(request: Request): ServeOptions["icons"] {
  let origin: string;
  try {
    origin = new URL(request.url).origin;
  } catch {
    return undefined;
  }
  return [
    { src: `${origin}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
    {
      src: `${origin}/icon-512.png`,
      mimeType: "image/png",
      sizes: ["512x512"],
      theme: "light",
    },
    {
      src: `${origin}/icon-512-dark.png`,
      mimeType: "image/png",
      sizes: ["512x512"],
      theme: "dark",
    },
  ];
}

// DeepResearch inline waits can run for minutes, so the function needs a
// longer budget than a plain search.
export const maxDuration = 300;

async function handler(
  request: Request,
  { params }: { params: Promise<{ transport: string }> },
): Promise<Response> {
  // Only `/mcp` is served; any other segment 404s.
  if ((await params).transport !== "mcp") return notFound();

  const ctx = buildContext(request);
  if (!ctx) return unauthorizedResponse();

  return serveMcp(request, {
    ...SERVER_INFO,
    icons: serverIcons(request),
    instructions: SERVER_INSTRUCTIONS,
    register: (server) => registerTools(server, ctx),
  });
}

export { handler as GET, handler as POST, handler as DELETE };
