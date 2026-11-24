module.exports = ({ config }) => {
  const variant = process.env.LEVE_APP_VARIANT ?? "development";
  if (variant === "preview") return config;
  if (variant !== "development") throw new Error(`Unknown Leve app variant: ${variant}`);

  return {
    ...config,
    experiments: {
      ...config.experiments,
      ...(process.env.EXPO_PUBLIC_WEB_DEMO === "1" ? { baseUrl: "/demo" } : {}),
    },
    name: "Leve Dev",
    slug: "leve-dev",
    scheme: "leve-dev",
    icon: "./assets/icon-dev.png",
    ios: { ...config.ios, bundleIdentifier: "app.leve.dev" },
    android: { ...config.android, package: "app.leve.dev" },
    owner: undefined,
    updates: { enabled: false },
    extra: { ...config.extra, eas: undefined },
  };
};
