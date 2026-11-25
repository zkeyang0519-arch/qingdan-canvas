// Intake is deliberately independent of the strict final-output parser. A
// screenplay must not already be a finished director prompt to enter the graph.
export function extractSourceAnchor(value) {
  const lines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "")
    .split("\n");
  const names =
    "全局角色锚定|角色锚定|全局角色设定|角色设定|人物设定|角色形象|人物形象|角色介绍|人物介绍|主要角色|出场角色";
  const bracketed = new RegExp(
    `^[【\\[](${names})[】\\]][ \\t]*[：:]?[ \\t]*(.*)$`,
  );
  const plain = new RegExp(`^(${names})(?:[：:][ \\t]*(.*))?$`);
  const boundary =
    /^(?:#{1,6}\s*)?(?:\*\*)?(?:[【\[])?(?:场景|环境|剧情|故事|分镜|镜头|运镜|声音设定|音效与氛围|负面提示词|光线|灯光)(?:[\s：:（(【】\[\]0-9]|$)|^═══\s*分镜/;
  for (let index = 0; index < lines.length; index++) {
    const title = lines[index]
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\*\*(.*?)\*\*([：:].*)?$/, "$1$2");
    const match = bracketed.exec(title) || plain.exec(title);
    if (!match) continue;
    const level = /^\s*(#{1,6})\s/.exec(lines[index])?.[1].length;
    const content = match[2] ? [match[2]] : [];
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next],
        nextLevel = /^\s*(#{1,6})\s/.exec(line)?.[1].length;
      if (
        boundary.test(line.trim()) ||
        (level && nextLevel && nextLevel <= level)
      )
        break;
      content.push(line);
    }
    const anchor = content.join("\n").trim();
    if (anchor) return anchor;
  }
  return "";
}
