module.exports = ({ config }) => {
  const variant = process.env.LEVE_APP_VARIANT ?? "development";
  if (variant === "preview") return config;
  if (variant !== "development") throw new Error(`Unknown Leve app variant: ${variant}`);

  return {
    ...config,
    name: "Leve Dev",
    slug: "leve-dev",
    scheme: "leve-dev",
    icon: "./assets/icon-dev.png",
    // Development builds have no sign-in, and a personal signing team can't grant Apple sign-in.
    plugins: config.plugins.filter((plugin) => plugin !== "expo-apple-authentication"),
    ios: { ...config.ios, bundleIdentifier: "app.leve.dev" },
    android: { ...config.android, package: "app.leve.dev" },
    owner: undefined,
    updates: { enabled: false },
    extra: { ...config.extra, eas: undefined },
  };
};
