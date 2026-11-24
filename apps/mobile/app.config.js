const variants = {
  development: { name: "Leve Dev", slug: "leve-dev", icon: "./assets/icon-dev.png" },
  production: { name: "Leve", slug: "leve", icon: "./assets/icon.png" },
};

module.exports = ({ config }) => {
  const variant = process.env.LEVE_APP_VARIANT ?? "development";
  if (variant === "preview") return config;

  const app = variants[variant];
  if (!app || !Object.hasOwn(variants, variant))
    throw new Error(`Unknown Leve app variant: ${variant}`);

  const production = variant === "production";
  const projectId = production
    ? process.env.LEVE_PRODUCTION_EAS_PROJECT_ID
    : process.env.LEVE_DEV_EAS_PROJECT_ID;
  if (projectId && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(projectId)) {
    throw new Error("The EAS project ID must be a UUID.");
  }
  if (projectId && projectId.toLowerCase() === config.extra?.eas?.projectId?.toLowerCase()) {
    throw new Error("Leve Dev and Leve require an EAS project separate from TestFlight.");
  }
  const version = production ? process.env.LEVE_STORE_VERSION : config.version;
  if (production && (!projectId || !/^\d+\.\d+\.\d+$/.test(version ?? ""))) {
    throw new Error("The production variant requires its EAS project ID and a store version.");
  }

  const bundleIdentifier = production ? "app.leve.production" : "app.leve.dev";
  return {
    ...config,
    experiments: {
      ...config.experiments,
      ...(process.env.EXPO_PUBLIC_WEB_DEMO === "1" ? { baseUrl: "/demo" } : {}),
    },
    ...app,
    version,
    scheme: app.slug,
    ios: { ...config.ios, bundleIdentifier },
    android: { ...config.android, package: production ? "app.leve" : bundleIdentifier },
    owner: projectId ? (process.env.LEVE_EXPO_OWNER ?? config.owner) : undefined,
    updates: projectId ? { url: `https://u.expo.dev/${projectId}` } : { enabled: false },
    extra: { ...config.extra, eas: projectId ? { projectId } : undefined },
  };
};
