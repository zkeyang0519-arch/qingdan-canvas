import { fileURLToPath } from "node:url";
import { createDesktopLauncher } from "./lib/desktop-launcher.mjs";

const launcher = createDesktopLauncher({
  projectRoot: fileURLToPath(new URL("..", import.meta.url)),
  onStatus: (message) => console.log(message),
});

try {
  await launcher.launch();
  console.log(
    "正在打开轻岛；启动后无需保留此终端，可从系统托盘显示、隐藏和退出。首次使用请在桌面窗口登录轻单。",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
