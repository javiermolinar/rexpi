import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { parseLayoutSpec, type LayoutNode, type LayoutSpec } from "./layouts.ts";

export interface PreviewOptions { width?: number; height?: number }
function clip(value: string, width: number): string {
  return stripVTControlCharacters(truncateToWidth(value, width, "…"));
}
function leafLabel(node: LayoutNode): string {
  if (node.type !== "terminal") return "";
  return (node.focus ? "● " : "") + node.title + (node.role === "pi" ? " · current Pi" : "");
}
function box(node: LayoutNode, width: number, height: number): string[] | undefined {
  if (width < 8 || height < 3) return undefined;
  if (node.type === "terminal") {
    const inner = width - 2;
    const lines = ["┌" + "─".repeat(inner) + "┐"];
    for (let row = 1; row < height - 1; row++) {
      const content = row === 1 ? clip(leafLabel(node), inner) : "";
      lines.push("│" + content + " ".repeat(Math.max(0, inner - visibleWidth(content))) + "│");
    }
    lines.push("└" + "─".repeat(inner) + "┘");
    return lines;
  }
  if (node.direction === "row") {
    const leftWidth = Math.floor((width - 1) * node.ratio), rightWidth = width - 1 - leftWidth;
    const left = box(node.before, leftWidth, height), right = box(node.after, rightWidth, height);
    if (!left || !right) return undefined;
    return left.map((line, index) => line + " " + right[index]);
  }
  const beforeHeight = Math.floor(height * node.ratio), afterHeight = height - beforeHeight;
  const before = box(node.before, width, beforeHeight), after = box(node.after, width, afterHeight);
  if (!before || !after) return undefined;
  return [...before, ...after];
}
function tree(node: LayoutNode, prefix = ""): string[] {
  if (node.type === "terminal") return [prefix + leafLabel(node)];
  const label = node.direction === "row" ? "Row" : "Column";
  return [prefix + label + " " + Math.round(node.ratio * 100) + "%",
    ...tree(node.before, prefix + "  ├─ "), ...tree(node.after, prefix + "  └─ ")];
}
/** Read-only text presentation. The same renderer serves overlays and tool responses. */
export function renderLayoutPreview(name: string, value: LayoutSpec, options: PreviewOptions = {}): string {
  const spec = parseLayoutSpec(value);
  const width = Math.max(1, Math.min(160, Math.floor(options.width ?? 80)));
  const height = Math.max(1, Math.min(40, Math.floor(options.height ?? 20)));
  const header = clip("Layout: " + name, width);
  if (height === 1) return header;
  const grid = width < 32 || height < 5 ? undefined : box(spec.root, width, height - 1);
  const body = grid ?? tree(spec.root).map(line => clip(line, width));
  return [header, ...body.slice(0, height - 1)].join("\n");
}
