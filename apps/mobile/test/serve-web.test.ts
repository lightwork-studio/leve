import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createWebServer, isLoopback } from "../scripts/serve-web.mts";

let port: number;
let server: Server;
const parent = mkdtempSync(join(tmpdir(), "leve-web-"));
const build = join(parent, "dist");
const BUNDLE = "/_expo/entry-0123456789abcdef0123.js";

beforeAll(async () => {
  mkdirSync(join(build, "_expo"), { recursive: true });
  writeFileSync(join(build, "index.html"), "<html>app</html>");
  writeFileSync(join(build, BUNDLE), "console.log(1)");
  writeFileSync(join(build, "favicon.ico"), "icon");
  writeFileSync(join(parent, "secret.txt"), "outside the build");
  symlinkSync(join(parent, "secret.txt"), join(build, "linked.txt"));
  server = createWebServer(build);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(parent, { recursive: true, force: true });
});

/** Sends the path exactly as given, so no client normalises it first. */
function get(path: string, method = "GET") {
  return new Promise<{ status: number; cache?: string; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          cache: res.headers["cache-control"],
          body,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

it("serves the build and has the browser check every file again on each load", async () => {
  expect(await get("/")).toEqual({ status: 200, cache: "no-cache", body: "<html>app</html>" });
  // Bundle names look hashed but don't always change with their content: never cache for good.
  expect(await get(BUNDLE)).toMatchObject({
    status: 200,
    body: "console.log(1)",
    cache: "no-cache",
  });
  expect((await get("/favicon.ico")).cache).toBe("no-cache");
  expect(await get("/", "HEAD")).toMatchObject({ status: 200, body: "" });
});

it("answers app routes with the page and missing files with 404", async () => {
  expect((await get("/history")).body).toBe("<html>app</html>");
  expect((await get("/_expo/entry-old.js")).status).toBe(404);
});

it("never serves files outside the build", async () => {
  for (const path of [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/_expo/..%2f..%2fsecret.txt",
    "/linked.txt",
  ]) {
    const response = await get(path);
    expect(response.body, path).not.toContain("outside the build");
  }
  expect((await get("/%")).status).toBe(400);
});

it("keeps running while the build is being replaced", async () => {
  renameSync(join(build, "index.html"), join(build, "index.old"));
  try {
    expect((await get("/history")).status).toBe(503);
  } finally {
    renameSync(join(build, "index.old"), join(build, "index.html"));
  }
  expect((await get("/history")).status).toBe(200);
});

it("only listens on loopback", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost"]) {
    expect(isLoopback(host), host).toBe(true);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "100.64.0.1", "example.com"]) {
    expect(isLoopback(host), host).toBe(false);
  }
});
