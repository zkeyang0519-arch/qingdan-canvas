"use strict";

module.exports = {
  appId: "cn.zky.qingdao",
  productName: "Qingdao",
  executableName: "Qingdao",
  protocols: [{ name: "轻岛", schemes: ["qingdao"] }],
  directories: {
    app: ".tmp/desktop-package",
    output: "output/desktop-release",
  },
  asar: true,
  npmRebuild: false,
  files: ["desktop/**/*.cjs", "shared/desktop-origins.cjs", "package.json"],
  extraResources: [{ from: "dist", to: "web" }],
  artifactName: "Qingdao-Setup-${version}-${arch}.${ext}",
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
    allowToChangeInstallationDirectory: false,
    runAfterFinish: true,
    shortcutName: "轻岛",
    uninstallDisplayName: "轻岛 Qingdao",
    deleteAppDataOnUninstall: false,
  },
  publish: [
    {
      provider: "github",
      owner: "zkeyang0519-arch",
      repo: "qingdan-canvas",
      releaseType: "release",
      vPrefixedTagName: true,
    },
  ],
};
