import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";

async function readRequestBody(request: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function layoutStoragePlugin(): Plugin {
  const layoutPathPrefix = "/chatui/src/layouts/";

  return {
    name: "openclaw-layout-storage",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const method = request.method?.toUpperCase() ?? "GET";
        if (method !== "PUT" && method !== "PATCH" && method !== "DELETE") {
          next();
          return;
        }

        if (!request.url) {
          next();
          return;
        }

        const url = new URL(request.url, "http://localhost");
        if (!url.pathname.startsWith(layoutPathPrefix) || !url.pathname.endsWith(".json")) {
          next();
          return;
        }

        const relativePath = url.pathname.slice(layoutPathPrefix.length);
        const filePath = path.resolve(server.config.root, "src", "layouts", relativePath);

        try {
          if (method === "DELETE") {
            await unlink(filePath).catch(() => undefined);
            response.statusCode = 204;
            response.end();
            return;
          }

          const body = await readRequestBody(request);
          const parsed = body.trim() ? JSON.parse(body) : {};

          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true }));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });
    },
  };
}

export default defineConfig({
  root: ".",
  base: "/chatui/",
  plugins: [layoutStoragePlugin()],
  server: {
    port: 8083,
    allowedHosts: [".nip.io", "localhost", "127.0.0.1"],
  },
});
