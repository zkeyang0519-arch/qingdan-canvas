import { makeBlock } from "./model.js";
export function parsePlainList(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const checked = line.match(/^\s*(?:[-*+]\s+)?\[([ xX])\]\s+(.*)$/);
      if (checked)
        return makeBlock(checked[2], checked[1].toLowerCase() === "x");
      return makeBlock(
        line.replace(/^(\s*)(?:[-*+•]\s+|\d{1,3}[.)、]\s+)/, "$1"),
      );
    });
}
export function parseClipboard(text, html = "") {
  if (html && globalThis.DOMParser) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const items = [...doc.querySelectorAll("li")];
    if (items.length)
      return items.map((li) => {
        const copy = li.cloneNode(true);
        copy
          .querySelectorAll("ul,ol,script,style,img")
          .forEach((n) => n.remove());
        copy.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
        const depth = Math.max(
          0,
          [
            ...(function* (node) {
              while (node.parentElement) {
                node = node.parentElement;
                if (node.tagName === "LI") yield node;
              }
            })(li),
          ].length,
        );
        return makeBlock(
          "  ".repeat(depth) + (copy.textContent || "").trim(),
          li.querySelector("input[type=checkbox]")?.hasAttribute("checked") ||
            false,
        );
      });
  }
  return parsePlainList(text);
}
