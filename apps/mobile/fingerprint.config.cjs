const { existsSync } = require("node:fs");
const { join } = require("node:path");

// Expo checks for patches under the app root. pnpm applies these from the workspace root.
const workspacePatches = "../../patches";

module.exports = {
  extraSources: existsSync(join(__dirname, workspacePatches))
    ? [{ type: "dir", filePath: workspacePatches, reasons: ["workspacePatches"] }]
    : [],
};
