import { z } from "zod";
import { McpBusinessError } from "./errors";

const cursorSchema = z.strictObject({
  v: z.literal(1),
  canvas: z.string().min(1).max(256),
  filter: z.string().regex(/^[0-9a-f]{16}$/),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type CursorBinding = Omit<z.infer<typeof cursorSchema>, "v" | "offset">;

// This binds pagination state, not authorization. Tokens are intentionally not
// credentials; each page still requires its own grant/membership validation.
export function filterDigest(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(value)))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}
export function encodeCursor(binding: CursorBinding, offset: number): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ v: 1, ...binding, offset }),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function decodeCursor(
  cursor: string | undefined,
  binding: CursorBinding,
): number {
  if (!cursor) return 0;
  let parsed;
  try {
    if (
      cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor) ||
      cursor.length % 4 === 1
    )
      throw Error();
    const binary = atob(
      cursor.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (cursor.length % 4)) % 4),
    );
    parsed = cursorSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        ),
      ),
    );
    if (
      encodeCursor(
        {
          canvas: parsed.canvas,
          filter: parsed.filter,
          sequence: parsed.sequence,
          ...(parsed.revision !== undefined
            ? { revision: parsed.revision }
            : {}),
        },
        parsed.offset,
      ) !== cursor
    )
      throw Error();
  } catch {
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Invalid pagination cursor.",
    );
  }
  if (parsed.canvas !== binding.canvas || parsed.filter !== binding.filter)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Cursor does not match this canvas and query.",
    );
  if (
    parsed.sequence !== binding.sequence ||
    parsed.revision !== binding.revision
  )
    throw new McpBusinessError(
      "STALE_CURSOR",
      "Content changed; restart pagination.",
    );
  return parsed.offset;
}
export const serializedBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function boundedPage<T>(
  items: readonly T[],
  limit: number,
  cursor: string | undefined,
  binding: CursorBinding,
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  const offset = decodeCursor(cursor, binding);
  if (offset > items.length)
    throw new McpBusinessError(
      "VALIDATION_ERROR",
      "Cursor position is outside this result.",
    );
  const page: T[] = [];
  for (const item of items.slice(offset, offset + limit)) {
    const candidate = [...page, item];
    if (
      serializedBytes({
        ...envelope,
        items: candidate,
        next_cursor: encodeCursor(binding, offset + candidate.length),
      }) > 256000
    )
      break;
    page.push(item);
  }
  if (!page.length && offset < items.length)
    throw new McpBusinessError(
      "LIMIT_EXCEEDED",
      "Content exceeds the page size limit; request this task separately.",
    );
  const next = offset + page.length;
  const result = {
    ...envelope,
    items: page,
    next_cursor: next < items.length ? encodeCursor(binding, next) : null,
  };
  if (serializedBytes(result) > 256000)
    throw new McpBusinessError(
      "LIMIT_EXCEEDED",
      "Result exceeds the response size limit.",
    );
  return result;
}
