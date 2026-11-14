// Bound the separately delivered final answer without charging it against the
// command/progress log budget. Leave an explicit marker when a response is cut.
export function boundedFinalOutput(text: string): string {
  const marker = "\n\n[输出过长，已截断]";
  return text.length <= 32000 ? text : text.slice(0, 32000 - marker.length) + marker;
}
