import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import "./chat-markdown.css";

const maxDepth = 20;
const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const headingPattern = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/;
const quotePattern = /^ {0,3}>[ \t]?(.*)$/;
const rulePattern = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

// Only explicit web/mail links and local paths become anchors. Text never enters
// an HTML parser, including code, labels, language names, and rejected URLs.
function safeHref(value) {
  if (!value || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return null;
  if (/^(?:#|\/(?!\/)|\.\.?\/)/.test(value)) return value;
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function linkElement(href, label, key, title) {
  const external = /^https?:/i.test(href);
  return (
    <a
      key={key}
      href={href}
      title={title}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
    >
      {label}
    </a>
  );
}

function closingMarker(text, marker, start) {
  let position = start;
  while ((position = text.indexOf(marker, position)) !== -1) {
    let escapes = 0;
    for (let i = position - 1; i >= 0 && text[i] === "\\"; i--) escapes++;
    if (escapes % 2 === 0 && !/\s/.test(text[position - 1] || " "))
      return position;
    position += marker.length;
  }
  return -1;
}

function readLink(text, start) {
  let brackets = 1;
  let labelEnd = start + 1;
  for (; labelEnd < text.length; labelEnd++) {
    if (text[labelEnd] === "\\") labelEnd++;
    else if (text[labelEnd] === "[") brackets++;
    else if (text[labelEnd] === "]" && --brackets === 0) break;
  }
  if (brackets || text[labelEnd + 1] !== "(") return null;
  let parentheses = 1;
  let quote = null;
  let end = labelEnd + 2;
  for (; end < text.length; end++) {
    const char = text[end];
    if (char === "\\") end++;
    else if (quote) {
      if (char === quote) quote = null;
    } else if ((char === '"' || char === "'") && /\s/.test(text[end - 1]))
      quote = char;
    else if (char === "(") parentheses++;
    else if (char === ")" && --parentheses === 0) break;
  }
  if (parentheses) return null;
  const destination = text.slice(labelEnd + 2, end).trim();
  const match = destination.match(
    /^(?:<([^<>]*)>|(\S+?))(?:\s+(?:"([^"]*)"|'([^']*)'))?$/,
  );
  if (!match) return null;
  return {
    label: text.slice(start + 1, labelEnd),
    href: safeHref((match[1] ?? match[2]).replace(/\\([()\[\]\\])/g, "$1")),
    title: match[3] ?? match[4],
    end: end + 1,
  };
}

function inline(text, depth = 0, allowLinks = true) {
  if (depth > maxDepth) return text;
  const nodes = [];
  let plain = "";
  const flush = () => {
    if (plain) nodes.push(plain);
    plain = "";
  };
  let position = 0;
  while (position < text.length) {
    const char = text[position];
    if (
      char === "\\" &&
      /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[position + 1] || "")
    ) {
      plain += text[position + 1];
      position += 2;
      continue;
    }
    if (char === "`") {
      const marker = text.slice(position).match(/^`+/)[0];
      let end = text.indexOf(marker, position + marker.length);
      while (
        end !== -1 &&
        (text[end - 1] === "`" || text[end + marker.length] === "`")
      )
        end = text.indexOf(marker, end + marker.length);
      if (end !== -1) {
        let code = text
          .slice(position + marker.length, end)
          .replace(/\n/g, " ");
        if (/^ .+ $/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
        flush();
        nodes.push(<code key={nodes.length}>{code}</code>);
        position = end + marker.length;
        continue;
      }
      plain += marker;
      position += marker.length;
      continue;
    }
    if (allowLinks && char === "[") {
      const link = readLink(text, position);
      if (link) {
        flush();
        const label = inline(link.label, depth + 1, false);
        nodes.push(
          link.href ? (
            linkElement(link.href, label, nodes.length, link.title)
          ) : (
            <React.Fragment key={nodes.length}>{label}</React.Fragment>
          ),
        );
        position = link.end;
        continue;
      }
    }
    if (allowLinks && char === "<") {
      const end = text.indexOf(">", position + 1);
      const value = end === -1 ? "" : text.slice(position + 1, end);
      const href = /^(?:https?:\/\/|mailto:)/i.test(value) && safeHref(value);
      if (href) {
        flush();
        nodes.push(linkElement(href, value, nodes.length));
        position = end + 1;
        continue;
      }
    }
    if (char === "*" || char === "_" || char === "~") {
      const marker = ["***", "___", "**", "__", "~~", "*", "_"].find((value) =>
        text.startsWith(value, position),
      );
      const intraword =
        char === "_" && /[\p{L}\p{N}]/u.test(text[position - 1] || "");
      if (
        marker &&
        !intraword &&
        !/\s/.test(text[position + marker.length] || " ")
      ) {
        const end = closingMarker(text, marker, position + marker.length);
        if (end > position + marker.length) {
          flush();
          const content = inline(
            text.slice(position + marker.length, end),
            depth + 1,
            allowLinks,
          );
          const key = nodes.length;
          if (marker.length === 3)
            nodes.push(
              <strong key={key}>
                <em>{content}</em>
              </strong>,
            );
          else if (marker === "~~") nodes.push(<del key={key}>{content}</del>);
          else if (marker.length === 2)
            nodes.push(<strong key={key}>{content}</strong>);
          else nodes.push(<em key={key}>{content}</em>);
          position = end + marker.length;
          continue;
        }
      }
    }
    plain += char;
    position++;
  }
  flush();
  return nodes;
}

function CodeBlock({ code, language }) {
  const [copyState, setCopyState] = useState("idle");
  const resetTimer = useRef();
  const copyVersion = useRef(0);
  useEffect(() => {
    copyVersion.current++;
    setCopyState("idle");
    return () => {
      copyVersion.current++;
      clearTimeout(resetTimer.current);
    };
  }, [code]);
  const copy = async () => {
    const version = ++copyVersion.current;
    clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(code);
      if (version !== copyVersion.current) return;
      setCopyState("copied");
    } catch {
      if (version !== copyVersion.current) return;
      setCopyState("failed");
    }
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2400);
  };
  return (
    <div className="agent-chat-code-block">
      <div className="agent-chat-code-heading">
        <span>{language || "代码"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="复制代码"
          title={
            copyState === "failed" ? "无法复制，请手动选择代码" : "复制代码"
          }
        >
          {copyState === "copied" ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <Copy size={13} aria-hidden="true" />
          )}
          <span aria-live="polite">
            {copyState === "copied"
              ? "已复制"
              : copyState === "failed"
                ? "复制失败"
                : "复制"}
          </span>
        </button>
      </div>
      <pre tabIndex={0} aria-label={language ? `${language} 代码` : "代码"}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function tableCells(line) {
  const value = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  const cells = [];
  let cell = "";
  let codeMarker = "";
  for (let position = 0; position < value.length; position++) {
    const char = value[position];
    if (char === "\\" && position + 1 < value.length) {
      cell += char + value[++position];
    } else if (char === "`") {
      const marker = value.slice(position).match(/^`+/)[0];
      if (!codeMarker) codeMarker = marker;
      else if (codeMarker === marker) codeMarker = "";
      cell += marker;
      position += marker.length - 1;
    } else if (char === "|" && !codeMarker) {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignment(line) {
  if (!line || !line.includes("|")) return null;
  const cells = tableCells(line);
  if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) =>
    cell.startsWith(":")
      ? cell.endsWith(":")
        ? "center"
        : "left"
      : cell.endsWith(":")
        ? "right"
        : undefined,
  );
}

function listMarker(line) {
  const match = line.match(/^( *)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/);
  return (
    match && {
      indent: match[1].length,
      ordered: /^\d/.test(match[2]),
      start: Number.parseInt(match[2], 10),
      contentIndent: match[1].length + match[2].length + match[3].length,
      text: match[4],
    }
  );
}

function startsBlock(lines, position) {
  const line = lines[position];
  return (
    fencePattern.test(line) ||
    headingPattern.test(line) ||
    quotePattern.test(line) ||
    rulePattern.test(line) ||
    listMarker(line) ||
    (line.includes("|") && tableAlignment(lines[position + 1]))
  );
}

function blocks(lines, depth = 0) {
  if (depth > maxDepth) return <p>{lines.join("\n")}</p>;
  const nodes = [];
  let position = 0;
  while (position < lines.length) {
    const line = lines[position];
    if (!line.trim()) {
      position++;
      continue;
    }
    const key = position;
    const fence = line.match(fencePattern);
    if (fence) {
      const marker = fence[1];
      const endPattern = new RegExp(
        `^ {0,3}${marker[0]}{${marker.length},}\\s*$`,
      );
      const code = [];
      position++;
      while (position < lines.length && !endPattern.test(lines[position]))
        code.push(lines[position++]);
      if (position < lines.length) position++;
      nodes.push(
        <CodeBlock
          key={key}
          code={code.join("\n")}
          language={fence[2].trim().split(/\s+/)[0]}
        />,
      );
      continue;
    }
    const heading = line.match(headingPattern);
    if (heading) {
      nodes.push(
        React.createElement(
          `h${heading[1].length}`,
          { key },
          inline(heading[2].replace(/[ \t]+#+[ \t]*$/, "")),
        ),
      );
      position++;
      continue;
    }
    if (rulePattern.test(line)) {
      nodes.push(<hr key={key} />);
      position++;
      continue;
    }
    if (quotePattern.test(line)) {
      const quote = [];
      while (position < lines.length && quotePattern.test(lines[position]))
        quote.push(lines[position++].replace(quotePattern, "$1"));
      nodes.push(<blockquote key={key}>{blocks(quote, depth + 1)}</blockquote>);
      continue;
    }
    const alignment = line.includes("|") && tableAlignment(lines[position + 1]);
    if (alignment && tableCells(line).length === alignment.length) {
      const headers = tableCells(line);
      const rows = [];
      position += 2;
      while (
        position < lines.length &&
        lines[position].trim() &&
        lines[position].includes("|") &&
        !startsBlock(lines, position)
      )
        rows.push(tableCells(lines[position++]));
      nodes.push(
        <div
          key={key}
          className="agent-chat-table-scroll"
          role="region"
          aria-label="表格"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                {headers.map((cell, index) => (
                  <th
                    key={index}
                    scope="col"
                    style={{ textAlign: alignment[index] }}
                  >
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, index) => (
                    <td key={index} style={{ textAlign: alignment[index] }}>
                      {inline(row[index] || "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const list = listMarker(line);
    if (list) {
      const items = [];
      while (position < lines.length) {
        const current = listMarker(lines[position]);
        if (
          !current ||
          current.indent !== list.indent ||
          current.ordered !== list.ordered
        )
          break;
        const itemKey = position;
        const task = current.text.match(/^\[([ xX])\][ \t]+(.*)$/);
        const content = [task ? task[2] : current.text];
        position++;
        while (position < lines.length) {
          if (!lines[position].trim()) {
            let next = position + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            const nextMarker = next < lines.length && listMarker(lines[next]);
            if (
              nextMarker &&
              nextMarker.indent === list.indent &&
              nextMarker.ordered === list.ordered
            ) {
              position = next;
              break;
            }
            if (
              next < lines.length &&
              lines[next].match(/^ */)[0].length > list.indent
            ) {
              content.push("");
              position++;
              continue;
            }
            break;
          }
          const indent = lines[position].match(/^ */)[0].length;
          if (indent <= list.indent) break;
          content.push(
            lines[position++].slice(Math.min(current.contentIndent, indent)),
          );
        }
        items.push(
          <li
            key={itemKey}
            className={task ? "agent-chat-task-item" : undefined}
          >
            {task && (
              <input
                type="checkbox"
                checked={task[1].toLowerCase() === "x"}
                disabled
                aria-label={task[2]}
              />
            )}
            {blocks(content, depth + 1)}
          </li>,
        );
      }
      nodes.push(
        list.ordered ? (
          <ol key={key} start={list.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        ),
      );
      continue;
    }
    const paragraph = [line];
    position++;
    while (
      position < lines.length &&
      lines[position].trim() &&
      !startsBlock(lines, position)
    )
      paragraph.push(lines[position++]);
    nodes.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  return nodes;
}

function timelineBlocks(content) {
  const headings = content.flatMap((node, index) =>
    typeof node.type === "string" && /^h[1-6]$/.test(node.type)
      ? [{ index, level: Number(node.type[1]) }]
      : [],
  );
  // Keep an overall title above its lower-level sections. Peer headings are
  // content groups, not assertions that a task has succeeded or finished.
  const overallTitle =
    headings.length > 1 &&
    headings[0].index === 0 &&
    headings.slice(1).every((heading) => heading.level > headings[0].level);
  const candidates = overallTitle ? headings.slice(1) : headings;
  const level = Math.min(...candidates.map((heading) => heading.level));
  const starts = new Set(
    candidates
      .filter((heading) => heading.level === level)
      .map((heading) => heading.index),
  );
  if (starts.size >= 2) {
    const introduction = [];
    const sections = [];
    let current;
    content.forEach((node, index) => {
      if (starts.has(index)) {
        current = { key: node.key, nodes: [] };
        sections.push(current);
      }
      (current ? current.nodes : introduction).push(node);
    });
    return [
      ...introduction,
      <div className="agent-chat-timeline" key={`timeline:${sections[0].key}`}>
        {sections.map((section) => (
          <section className="agent-chat-timeline-section" key={section.key}>
            {section.nodes}
          </section>
        ))}
      </div>,
    ];
  }
  return content.map((node) => {
    if (node.type !== "ul") return node;
    const items = React.Children.toArray(node.props.children);
    const titled =
      items.length >= 2 &&
      items.every((item) => {
        if (item.props.className === "agent-chat-task-item") return false;
        const firstBlock = React.Children.toArray(item.props.children)[0];
        if (firstBlock?.type !== "p") return false;
        const firstInline = React.Children.toArray(
          firstBlock.props.children,
        ).find((child) => typeof child !== "string" || child.trim());
        return firstInline?.type === "strong";
      });
    return titled
      ? React.cloneElement(node, {
          className: "agent-chat-timeline-list",
          role: "list",
        })
      : node;
  });
}

export default function ChatMarkdown({ text, timeline = false }) {
  const content = useMemo(
    () =>
      blocks(
        String(text ?? "")
          .replace(/\r\n?/g, "\n")
          .split("\n"),
      ),
    [text],
  );
  return (
    <div className="agent-chat-markdown">
      {timeline ? timelineBlocks(content) : content}
    </div>
  );
}
