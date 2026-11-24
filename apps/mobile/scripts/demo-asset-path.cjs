module.exports = (asset) => ({
  ...asset,
  // GitHub artifacts skip dot directories and Pages skips node_modules when uploading assets.
  httpServerLocation: asset.httpServerLocation
    .replaceAll("/.pnpm/", "/pnpm-store/")
    .replaceAll("/node_modules/", "/dependencies/"),
});
