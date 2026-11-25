"use strict";
const { channelDetails } = require("./desktop/channel.cjs");
const variant = channelDetails(
  process.env.QINGDAO_BUILD_VERSION || require("./package.json").version,
);

module.exports = {
  appId: variant.appId,
  productName: variant.productName,
  executableName: variant.executableName,
  protocols: [{ name: variant.title, schemes: [variant.protocol] }],
  directories: {
    app: ".tmp/desktop-package",
    output: process.env.QINGDAO_OUTPUT_DIR || "output/desktop-release",
  },
  asar: true,
  npmRebuild: false,
  files: [
    "desktop/**/*.cjs",
    "shared/desktop-origins.cjs",
    "shared/island-size.json",
    "package.json",
  ],
  extraResources: [
    { from: "dist", to: "web" },
    {
      from: ".tmp/local-service-package",
      to: "local-service",
      filter: ["**/*", "!node_modules/**", "!**/.cache/**", "!**/*.map"],
    },
    // electron-builder omits a source tree's root node_modules. Copy the
    // service's separately locked runtime dependencies as an explicit resource.
    {
      from: ".tmp/local-service-package/node_modules",
      to: "local-service/node_modules",
      filter: ["**/*", "!**/.cache/**", "!**/*.map"],
    },
  ],
  artifactName:
    variant.id === "beta"
      ? "Qingdao-Beta-Setup-${version}-${arch}.${ext}"
      : "Qingdao-Setup-${version}-${arch}.${ext}",
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    ...(process.env.QINGDAO_PUBLISHER_NAME
      ? {
          signtoolOptions: {
            publisherName: [process.env.QINGDAO_PUBLISHER_NAME],
          },
        }
      : {}),
  },
  nsis: {
    include: "build/desktop-installer.nsh",
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    // The custom maintenance page offers overwrite or the native directory picker.
    runAfterFinish: true,
    shortcutName: variant.title,
    uninstallDisplayName: variant.title + " " + variant.productName,
    deleteAppDataOnUninstall: false,
  },
  publish: [
    {
      provider: "github",
      owner: "zkeyang0519-arch",
      repo: "qingdan-canvas",
      releaseType: variant.id === "beta" ? "prerelease" : "release",
      channel: variant.id === "beta" ? "beta" : "latest",
      vPrefixedTagName: true,
    },
  ],
};
