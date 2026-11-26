// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

/*
 * The page a pairing link opens, for example from the iPhone's camera reading its QR code. The code
 * is in the link's fragment, which browsers never send, so it stays out of server and proxy logs.
 * The page only turns the link into one that opens the app; pairing itself happens in the app.
 */

/** URL schemes of the app's builds: the App Store app, TestFlight previews, development builds. */
export const APP_SCHEMES = [
  { scheme: "leve", label: "Open in Leve" },
  { scheme: "leve-preview", label: "Open in the Leve preview" },
  { scheme: "leve-dev", label: "Open in Leve Dev" },
] as const;

const SCRIPT = `
const code = new URLSearchParams(location.hash.slice(1)).get("code") || "";
const server = location.origin + location.pathname.replace(/\\/connect\\/?$/, "");
const links = document.getElementById("links");
const note = document.getElementById("note");
if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) {
  note.textContent = "This link has no pairing code. Ask for a new link.";
} else {
  const query = "connect?server=" + encodeURIComponent(server) + "&code=" + encodeURIComponent(code);
  for (const { scheme, label } of ${JSON.stringify(APP_SCHEMES)}) {
    const a = document.createElement("a");
    a.href = scheme + "://" + query;
    a.textContent = label;
    links.append(a);
  }
  note.textContent = "Or copy this page's address and paste it under Settings, Sync server, in Leve. The code works once, for 15 minutes.";
}
`;

export const CONNECT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect Leve</title>
<style>
  :root { color-scheme: light dark; font: 17px/1.45 -apple-system, system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 28rem; padding: 2rem 1rem; }
  h1 { font-size: 1.4rem; }
  #links { display: grid; gap: .75rem; margin: 1.5rem 0; }
  #links a { display: block; padding: .8rem 1rem; border-radius: .7rem; text-align: center;
    text-decoration: none; background: #1d1d1f; color: #fff; }
  @media (prefers-color-scheme: dark) { #links a { background: #f5f5f7; color: #1d1d1f; } }
  p { color: GrayText; }
</style>
</head>
<body>
<h1>Connect Leve to this sync server</h1>
<div id="links"></div>
<p id="note"></p>
<script>${SCRIPT}</script>
</body>
</html>
`;

/** Only this page's own script and styles run; nothing else loads. */
export const CONNECT_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'`,
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
