const SECTIONS = [
  "【全局角色锚定】",
  "【运镜铁律（全局）】",
  "【声音设定（全局）】",
  "【音效与氛围（全局）】",
  "【负面提示词】",
];
const close = (a, b) => Math.abs(a - b) <= 0.05;
const range = String.raw`(\d+(?:\.\d+)?)[ \t]*(?:秒|s)?[ \t]*[-—–~至][ \t]*(\d+(?:\.\d+)?)[ \t]*(?:秒|s)`;
const covers = (ranges, start, end) =>
  ranges.length > 0 &&
  ranges.every(
    ([a, b], i) => b > a && close(a, i ? ranges[i - 1][1] : start),
  ) &&
  close(ranges.at(-1)[1], end);

// Structural checks complement model review; they do not judge story or visual quality.
export function inspectDraft(draft, duration, profile, timeline) {
  const text = String(draft || "").replace(/\r\n/g, "\n");
  const issues = [];
  const add = (id, category, location, reason, required_fix) =>
    issues.push({
      id,
      severity: "blocking",
      category,
      location,
      reason,
      required_fix,
      node_id: "generate_prompt",
    });
  const lockedAnchor =
    profile?.character_anchor?.replace(/\r\n/g, "\n").trim() || "";
  const anchorHeading = /^[ \t]*(?:#{1,6}[ \t]+)?【全局角色锚定】[ \t]*$/m.exec(
    text,
  );
  const afterHeading = anchorHeading
    ? anchorHeading.index + anchorHeading[0].length
    : 0;
  const anchorStart =
    afterHeading + /^\s*/.exec(text.slice(afterHeading))[0].length;
  const hasLockedAnchor = Boolean(
    anchorHeading &&
    lockedAnchor &&
    text.slice(anchorStart, anchorStart + lockedAnchor.length) === lockedAnchor,
  );
  // Locked IP may contain character labels or describe a space with its own 场景：.
  // Hide only an exact copy from structural scanning while retaining string offsets.
  const structure = hasLockedAnchor
    ? text.slice(0, anchorStart) +
      lockedAnchor.replace(/[^\n]/g, " ") +
      text.slice(anchorStart + lockedAnchor.length)
    : text;
  const headings = [
    ...structure.matchAll(
      /^[ \t]*(?:#{1,6}[ \t]+)?(【[^】\n]+】)[ \t]*(.*)$/gm,
    ),
  ];
  const sections = SECTIONS.map((title) =>
    headings.find((match) => match[1] === title),
  );
  const extraMarkdownHeadings = [
    ...structure.matchAll(/^[ \t]*#{1,6}[ \t]+(.+)$/gm),
  ].some((match) => !/^(?:【|═══)/.test(match[1]));
  if (
    headings.length !== SECTIONS.length ||
    headings.some((match, i) => match[1] !== SECTIONS[i] || match[2].trim()) ||
    extraMarkdownHeadings
  ) {
    add(
      "format-sections",
      "format",
      "全局区块",
      "全局标题缺失、重复、多出或顺序与指定版式不一致。",
      "依次使用角色锚定、运镜铁律、声音设定、音效与氛围、负面提示词五个原定标题。",
    );
  }
  if (
    structure.slice(0, headings[0]?.index ?? structure.length).trim() ||
    /^\s*```/m.test(structure)
  ) {
    add(
      "format-wrapper",
      "format",
      "正文",
      "正文带有额外前言或代码围栏。",
      "正文从【全局角色锚定】开始，只保留指定版式。",
    );
  }
  const content = (index) => {
    const match = sections[index];
    if (!match) return "";
    const next = headings.find((heading) => heading.index > match.index);
    return text
      .slice(match.index + match[0].length, next?.index ?? text.length)
      .trim();
  };
  const shots = [
    ...structure.matchAll(
      new RegExp(
        String.raw`^[ \t]*(?:#{1,6}[ \t]+)?═══[ \t]*分镜[ \t]*(\d+)[ \t]*｜([^\n（）()]+)[（(][ \t]*${range}[ \t]*[）)][ \t]*═══[ \t]*$`,
        "gm",
      ),
    ),
  ];
  for (let i = 0; i < SECTIONS.length; i++) {
    let body = content(i);
    if (i === 2) body = body.split(/^[ \t]*(?:#{1,6}[ \t]+)?═══/m)[0].trim();
    if (sections[i] && !body)
      add(
        `format-empty-${i}`,
        "format",
        SECTIONS[i],
        "区块内容为空。",
        "填写与本片对应的实际内容；不使用的声音明确写无。",
      );
  }

  const anchorBlock = content(0);
  const sceneOffset = hasLockedAnchor ? lockedAnchor.length : 0;
  const scene = [...anchorBlock.matchAll(/^[ \t]*场景[：:][ \t]*/gm)].find(
    (match) => match.index >= sceneOffset,
  );
  const sceneIndex = scene?.index ?? anchorBlock.length;
  if (!scene || !anchorBlock.slice(sceneIndex + scene[0].length).trim()) {
    add(
      "format-scene",
      "format",
      "全局角色锚定后的场景",
      "角色锚定后缺少“场景：”及实际场景说明。",
      "在角色原文之后另起一段“场景：”，写空间、道具、光线和色调。",
    );
  }
  if (lockedAnchor) {
    const anchor = anchorBlock.slice(0, sceneIndex).trim();
    if (anchor !== lockedAnchor) {
      add(
        "identity-anchor",
        "identity",
        "全局角色锚定",
        "成稿角色锚定与入口锁定内容不一致。",
        "原样使用已锁定的 character_anchor；场景另起一段。若要改设定，先修改 IP 输入。",
      );
    }
  }
  if (sections[1] && !/^\d+[.、][ \t]*\S/m.test(content(1))) {
    add(
      "format-camera-rules",
      "format",
      "运镜铁律（全局）",
      "运镜规则没有按编号展开。",
      "按 1.、2. 等编号写本片实际使用的镜头和连续性规则。",
    );
  }

  if (
    !shots.length ||
    shots.some((shot, i) => Number(shot[1]) !== i + 1 || !shot[2].trim())
  ) {
    add(
      "format-numbering",
      "format",
      "分镜标题",
      "分镜标题缺失、标题为空或编号不连续。",
      "从分镜1开始连续编号，使用“═══ 分镜N｜具体标题（开始-结束秒）═══”。",
    );
  }
  if (
    shots.some(
      (shot) =>
        !sections[2] ||
        !sections[3] ||
        shot.index <= sections[2].index ||
        shot.index >= sections[3].index,
    )
  ) {
    add(
      "format-shot-order",
      "format",
      "分镜位置",
      "分镜没有全部放在声音设定与音效汇总之间。",
      "将所有编号分镜放在【声音设定（全局）】之后、分隔线之前。",
    );
  }
  const dividers = [...structure.matchAll(/^[ \t]*\*\*\*[ \t]*$/gm)];
  const divider = dividers[0];
  if (
    dividers.length !== 1 ||
    !sections[3] ||
    !shots.length ||
    divider.index <= shots.at(-1).index ||
    divider.index >= sections[3].index ||
    text.slice(divider.index + divider[0].length, sections[3].index).trim()
  ) {
    add(
      "format-divider",
      "format",
      "分镜与音效汇总之间",
      "缺少或错放示范中的 *** 分隔线。",
      "在最后一镜结束后、【音效与氛围（全局）】之前单列 ***。",
    );
  }

  const ranges = shots.map((shot) => [Number(shot[3]), Number(shot[4])]);
  if (!covers(ranges, 0, duration)) {
    add(
      "timing-total",
      "timing",
      "分镜时间",
      `分镜应从 0 秒连续覆盖至 ${duration} 秒。`,
      "修正重叠、空档或总时长。",
    );
  }
  if (
    Array.isArray(timeline) &&
    (timeline.length !== ranges.length ||
      timeline.some(
        (shot, i) =>
          !ranges[i] ||
          !close(shot.start, ranges[i][0]) ||
          !close(shot.end, ranges[i][1]),
      ))
  ) {
    add(
      "timing-plan",
      "timing",
      "分镜时间",
      "成稿镜头时段与剪辑时间轴不一致。",
      "按照剪辑方案成稿，或手动回退修改剪辑方案。",
    );
  }
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const boundary = Math.min(
      shots[i + 1]?.index ?? text.length,
      headings.find((h) => h.index > shot.index)?.index ?? text.length,
      dividers.find((d) => d.index > shot.index)?.index ?? text.length,
    );
    const lines = text
      .slice(shot.index + shot[0].length, boundary)
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const cameraLines = lines.filter((line) => /^镜头[：:]/.test(line));
    if (
      cameraLines.length !== 1 ||
      !cameraLines[0].replace(/^镜头[：:]\s*/, "").trim()
    ) {
      add(
        `format-camera-${i + 1}`,
        "format",
        `分镜${i + 1}`,
        "缺少独立完整的“镜头：”描述或重复了该字段。",
        "本镜最后一段单列“镜头：”，写观察动机、路径或固定观察、结束构图。",
      );
    }
    const beatPattern = new RegExp(String.raw`^${range}[ \t]*[：:](.*)$`);
    const beats = lines.map((line) => beatPattern.exec(line)).filter(Boolean);
    if (
      !covers(
        beats.map((beat) => [Number(beat[1]), Number(beat[2])]),
        ...ranges[i],
      )
    ) {
      add(
        `timing-detail-${i + 1}`,
        "timing",
        `分镜${i + 1}镜内时间`,
        "镜内时间段缺失、重叠、留空或超出本镜范围。",
        "使用全片绝对秒数逐段覆盖本镜时段，可使用小数秒。",
      );
    }
    if (beats.some((beat) => !beat[3].trim())) {
      add(
        `format-action-${i + 1}`,
        "format",
        `分镜${i + 1}时间段正文`,
        "时间段后没有实际动作描述。",
        "写可见动作、表演、环境变化和同步声音，不能只列秒数。",
      );
    }
    if (
      lines.some(
        (line) => !beatPattern.test(line) && !/^镜头[：:]/.test(line),
      ) ||
      (cameraLines.length && lines.at(-1) !== cameraLines[0])
    ) {
      add(
        `format-shot-${i + 1}`,
        "format",
        `分镜${i + 1}正文`,
        "分镜未按“时间段正文 → 镜头：”排列，或多出了独立字段。",
        "将光线、声音、衔接融入时间段正文或镜头段；镜头段放在本镜最后。",
      );
    }
  }
  return issues;
}
