/** Clip presentation text without splitting UTF-8 code points; an ellipsis marks truncation. */
export function clippedText(value: string, maxBytes = 512): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let text = "", bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes - 3) break;
    text += character; bytes += size;
  }
  return text + "…";
}

/** Full evidence remains in details; model-visible text gets an independent hard bound. */
export function boundedJson(value: unknown, maxBytes: number, label: string): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > maxBytes) throw new Error(label + " presentation byte bound exceeded");
  return text;
}
