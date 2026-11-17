// Thumbnails are captured from each release tag with isolated sample tasks.
// Viewing a release never installs it or changes the active appearance.
export const islandReleases = [
  {
    version: "0.3.6",
    title: "青透双舱",
    description: "透明材质 · 双舱下方展开待办",
  },
  { version: "0.3.5", title: "雾玉双舱", description: "悬停展开完整待办" },
  {
    version: "0.3.4",
    title: "绿色双舱",
    description: "动物奔跑 · 横向与侧边双舱",
  },
  {
    version: "0.3.3",
    title: "待办胶囊",
    description: "首条待办摘要 · 完成后自动前移",
  },
  {
    version: "0.3.2",
    title: "宽幅胶囊",
    description: "加宽收起状态的待办标题",
  },
  { version: "0.3.1", title: "经典轻岛", description: "单舱待办 · 左右侧签" },
].map((release) => ({
  ...release,
  image: `/island-releases/v${release.version}.jpg`,
}));
