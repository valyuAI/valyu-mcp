import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";

const root = new URL("../", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(
        new URL(`${specifier.slice(2)}.ts`, root).href,
        context,
      );
    }
    if (
      specifier.startsWith(".") &&
      context.parentURL?.endsWith(".ts") &&
      !/\.[a-z]+$/i.test(specifier)
    ) {
      return nextResolve(
        new URL(`${specifier}.ts`, context.parentURL).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (
      url.startsWith(root.href) &&
      url.endsWith(".ts") &&
      !url.includes("/node_modules/")
    ) {
      const source = ts.transpileModule(
        readFileSync(fileURLToPath(url), "utf8"),
        {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
        },
      ).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

export const textOf = (result) =>
  result.content.map((part) => part.text || "").join("\n");

/** Stub requests with a fixed JSON response or an ordered response queue. */
export function toolHarness(t, registrars, responses) {
  const tools = new Map();
  const requests = [];
  const controller = new AbortController();
  const server = {
    tool(name, description, schema, annotations, handler) {
      tools.set(name, {
        description,
        schema: z.object(schema),
        annotations,
        handler,
      });
    },
  };
  for (const register of registrars)
    register(server, { ctx: { apiKey: "test-only" } });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({
      url: String(url),
      body: init.body && JSON.parse(init.body),
      signal: init.signal,
    });
    if (Array.isArray(responses) && !responses.length)
      throw new Error(`Unexpected upstream request: ${url}`);
    const response = Array.isArray(responses) ? responses.shift() : responses;
    return typeof response === "function"
      ? response(init)
      : Response.json(response);
  });
  return {
    tools,
    requests,
    controller,
    call(name, input = {}) {
      const tool = tools.get(name);
      return tool.handler(tool.schema.parse(input), {
        signal: controller.signal,
      });
    },
  };
}
