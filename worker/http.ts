export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function check(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new HttpError(status, message);
}
export const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
export function failure(error: unknown) {
  if (error instanceof HttpError)
    return json({ error: error.message }, error.status);
  console.error(
    "Request failed",
    error instanceof Error ? error.message : "Unknown error",
  );
  return json({ error: "服务暂时不可用，请稍后重试。" }, 500);
}
export async function limitedBytes(request: Request, limit: number) {
  check(
    Number(request.headers.get("Content-Length") || 0) <= limit,
    "文件或请求超过大小限制。",
    413,
  );
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "文件或请求超过大小限制。");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  check(
    request.headers.get("Content-Type")?.split(";")[0] === "application/json",
    "需要 JSON 请求。",
    415,
  );
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder().decode(await limitedBytes(request, 16384)),
    );
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "JSON 格式无效。");
  }
  check(
    input && typeof input === "object" && !Array.isArray(input),
    "请求格式无效。",
  );
  return input as Record<string, unknown>;
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  check(
    !origin || origin === new URL(request.url).origin,
    "不允许跨站请求。",
    403,
  );
  check(
    request.headers.get("Sec-Fetch-Site") !== "cross-site",
    "不允许跨站请求。",
    403,
  );
}
export const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
