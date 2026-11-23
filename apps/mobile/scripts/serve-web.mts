import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Serves the exported web build (`pnpm --filter @leve/mobile export:web`) for phone previews.
// It only listens on loopback; a private proxy (such as a tailnet HTTPS route) puts it in reach.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Whether `host` is a loopback address or name. */
export function isLoopback(host: string): boolean {
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return host === "::1";
}

/**
 * A server for the build in `directory`. App routes (paths without an extension) get the page,
 * which routes them itself; a missing file gets 404, and a build that is being replaced 503.
 */
export function createWebServer(directory: string): Server {
  const root = realpathSync(resolve(directory));
  const index = join(root, "index.html");
  return createServer((request, response) => {
    const fail = (status: number, message: string) => {
      if (response.headersSent) return void response.destroy();
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(message);
    };
    let path: string;
    try {
      path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    } catch {
      return fail(400, "bad path");
    }
    let file: string | null = null;
    const candidate = normalize(join(root, path));
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        const real = realpathSync(candidate);
        // Never serve anything outside the build, including through a symlink.
        if (real.startsWith(root + sep)) file = real;
      }
    } catch {
      file = null;
    }
    if (!file) {
      if (extname(path) !== "") return fail(404, "not found");
      file = index;
    }
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      // The build is missing or being replaced (an export empties the folder first).
      return fail(503, "the preview is being rebuilt; try again in a moment");
    }
    const stream = createReadStream(file);
    stream.on("error", () => fail(503, "the preview is being rebuilt; try again in a moment"));
    stream.on("open", () => {
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": size,
        // Every file is checked again on each load. Bundle names look hashed but don't always
        // change with their content, so caching them for good mixed old and new code after a rebuild.
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") {
        stream.destroy();
        response.end();
        return;
      }
      stream.pipe(response);
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const directory = resolve(
    process.env.LEVE_WEB_DIR ?? fileURLToPath(new URL("../dist", import.meta.url)),
  );
  if (!existsSync(join(directory, "index.html"))) {
    console.error(`No web build in ${directory}; run: pnpm --filter @leve/mobile export:web`);
    process.exit(1);
  }
  const host = process.env.LEVE_WEB_HOST ?? "127.0.0.1";
  if (!isLoopback(host)) {
    console.error(`LEVE_WEB_HOST must be a loopback address, not ${host}`);
    process.exit(1);
  }
  const port = Number(process.env.LEVE_WEB_PORT ?? 41788);
  createWebServer(directory).listen(port, host, () => {
    console.log(`Leve web preview: http://${host}:${port} (serving ${directory})`);
  });
}
