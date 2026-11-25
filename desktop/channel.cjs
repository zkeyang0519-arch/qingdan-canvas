"use strict";
function desktopChannel(version) {
  if (/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) return "beta";
  if (/^\d+\.\d+\.\d+$/.test(version)) return "stable";
  throw Error("不支持的桌面版本渠道。");
}
function channelDetails(version) {
  return desktopChannel(version) === "beta"
    ? {
        id: "beta",
        appId: "cn.zky.qingdao.beta",
        productName: "QingdaoBeta",
        executableName: "QingdaoBeta",
        profileName: "QingdaoBeta",
        protocol: "qingdao-beta",
        title: "轻岛测试版",
        publicHost: "localhost",
        webLaunchPort: 8795,
        ports: { app: 8794, web: 8793 },
      }
    : {
        id: "stable",
        appId: "cn.zky.qingdao",
        productName: "Qingdao",
        executableName: "Qingdao",
        profileName: "Qingdao",
        protocol: "qingdao",
        title: "轻岛",
        publicHost: "127.0.0.1",
        webLaunchPort: 8791,
        ports: { app: 8790, web: 8788 },
      };
}
module.exports = { desktopChannel, channelDetails };
