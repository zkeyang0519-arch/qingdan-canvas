import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  AcceptanceCriterion,
  JsonSchema,
  VerificationResult,
} from "../shared/agent/contracts";

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const limit = 1024 * 1024;
class CheckError extends Error {
  constructor(
    readonly kind: "access_denied" | "unsupported" | "error",
    message: string,
  ) {
    super(message);
  }
}
const key = (value: string) =>
  process.platform === "win32" ? value.toLowerCase() : value;
const same = (
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
) => a.dev === b.dev && a.ino === b.ino;

/** Never follows a project symlink/junction, and never returns raw content to the server. */
async function artifact(root: string, relative: string, content: boolean) {
  const parts = relative.split(/[\\/]/);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    /[\x00-\x1f<>:"|?*]/.test(relative) ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new CheckError("access_denied", "验收路径必须位于当前项目内。");
  root = path.resolve(root);
  const identity = await lstat(root);
  if (
    identity.isSymbolicLink() ||
    !identity.isDirectory() ||
    key(await realpath(root)) !== key(root)
  )
    throw new CheckError("access_denied", "项目目录已变化。");
  const guard = async () => {
    if (
      !same(identity, await lstat(root)) ||
      key(await realpath(root)) !== key(root)
    )
      throw new CheckError("access_denied", "验收期间项目目录已变化。");
  };
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        await guard();
        return { exists: false, hash: hash(`absent:${relative}`), text: "" };
      }
      throw error;
    }
    if (info.isSymbolicLink() || key(await realpath(target)) !== key(target))
      throw new CheckError(
        "access_denied",
        "不能通过符号链接或目录联接验收文件。",
      );
  }
  const before = await lstat(target);
  if (!content) {
    await guard();
    const after = await lstat(target);
    if (
      !same(before, after) ||
      after.isSymbolicLink() ||
      key(await realpath(target)) !== key(target)
    )
      throw new CheckError("access_denied", "验收期间文件路径已变化。");
    return {
      exists: true,
      hash: hash(
        JSON.stringify({
          relative,
          dev: before.dev,
          ino: before.ino,
          size: before.size,
          mtime: before.mtimeMs,
        }),
      ),
      text: "",
    };
  }
  if (!before.isFile() || before.nlink > 1)
    throw new CheckError(
      "access_denied",
      "内容验收仅接受项目中的普通文件，不接受硬链接。",
    );
  if (before.size > limit)
    throw new CheckError("unsupported", "文件超过 1 MiB 的本机验收大小上限。");
  const handle = await open(target, "r");
  try {
    if (!same(before, await handle.stat()))
      throw new CheckError("access_denied", "验收文件已被替换。");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat(),
      named = await lstat(target);
    await guard();
    if (
      length !== before.size ||
      !same(before, after) ||
      !same(after, named) ||
      named.isSymbolicLink() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      key(await realpath(target)) !== key(target)
    )
      throw new CheckError("access_denied", "验收期间文件已变化，请重新验收。");
    const bytes = buffer.subarray(0, length);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CheckError("unsupported", "内容验收仅支持 UTF-8 文本。");
    }
    return { exists: true, hash: hash(bytes), text };
  } finally {
    await handle.close();
  }
}

const keywords = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "title",
  "description",
]);
const types = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
function supported(schema: JsonSchema, depth = 0, count = { value: 0 }): void {
  if (depth > 12 || ++count.value > 500)
    throw new CheckError("unsupported", "JSON Schema 超过本机结构验收上限。");
  if (typeof schema === "boolean") return;
  if (
    !schema ||
    Array.isArray(schema) ||
    typeof schema !== "object" ||
    Object.keys(schema).some((k) => !keywords.has(k))
  )
    throw new CheckError(
      "unsupported",
      "JSON Schema 含尚不支持的关键字；不会跳过这些约束。",
    );
  if (
    schema.type !== undefined &&
    (typeof schema.type !== "string" || !types.has(schema.type))
  )
    throw new CheckError(
      "unsupported",
      "当前 JSON Schema type 仅支持单个标准类型。",
    );
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length)
  )
    throw new CheckError("unsupported", "JSON Schema enum 无效。");
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((v) => typeof v !== "string"))
  )
    throw new CheckError("unsupported", "JSON Schema required 无效。");
  for (const name of ["minItems", "maxItems", "minLength", "maxLength"]) {
    const n = schema[name];
    if (
      n !== undefined &&
      (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    )
      throw new CheckError("unsupported", `JSON Schema ${name} 无效。`);
  }
  for (const name of ["minimum", "maximum"])
    if (
      schema[name] !== undefined &&
      (typeof schema[name] !== "number" || !Number.isFinite(schema[name]))
    )
      throw new CheckError("unsupported", `JSON Schema ${name} 无效。`);
  if (schema.properties !== undefined) {
    if (
      !schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties)
    )
      throw new CheckError("unsupported", "JSON Schema properties 无效。");
    for (const child of Object.values(schema.properties))
      supported(child as JsonSchema, depth + 1, count);
  }
  for (const name of ["items", "additionalProperties"])
    if (schema[name] !== undefined)
      supported(schema[name] as JsonSchema, depth + 1, count);
}
function equal(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 100)
    throw new CheckError("unsupported", "JSON 值嵌套层数超过本机验收上限。");
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (k) =>
        Object.hasOwn(b, k) && equal((a as any)[k], (b as any)[k], depth + 1),
    )
  );
}
function matches(value: unknown, schema: JsonSchema, depth = 0): boolean {
  if (depth > 100)
    throw new CheckError("unsupported", "JSON 文件嵌套层数超过本机验收上限。");
  if (typeof schema === "boolean") return schema;
  const object =
    value !== null && typeof value === "object" && !Array.isArray(value);
  const type = schema.type;
  if (
    type &&
    !(type === "object"
      ? object
      : type === "array"
        ? Array.isArray(value)
        : type === "null"
          ? value === null
          : type === "integer"
            ? Number.isInteger(value)
            : typeof value === type)
  )
    return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => equal(value, v)))
    return false;
  if (Object.hasOwn(schema, "const") && !equal(value, schema.const))
    return false;
  if (
    typeof value === "number" &&
    ((typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum))
  )
    return false;
  if (typeof value === "string") {
    const length = [...value].length;
    if (
      (typeof schema.minLength === "number" && length < schema.minLength) ||
      (typeof schema.maxLength === "number" && length > schema.maxLength)
    )
      return false;
  }
  if (Array.isArray(value)) {
    if (
      (typeof schema.minItems === "number" && value.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    )
      return false;
    if (
      schema.items !== undefined &&
      !value.every((v) => matches(v, schema.items as JsonSchema, depth + 1))
    )
      return false;
  }
  if (object) {
    const data = value as Record<string, unknown>;
    if (
      Array.isArray(schema.required) &&
      schema.required.some((k) => !Object.hasOwn(data, k as string))
    )
      return false;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const name of Object.keys(data)) {
      const child = Object.hasOwn(properties, name)
        ? properties[name]
        : schema.additionalProperties;
      if (
        child !== undefined &&
        !matches(data[name], child as JsonSchema, depth + 1)
      )
        return false;
    }
  }
  return true;
}

/** Native observations only. Command labels do not authorize execution of argv. */
export async function verifyAcceptance(
  root: string,
  criteria: AcceptanceCriterion[],
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const criterion of criteria) {
    const result: VerificationResult = {
      criterionId: criterion.id,
      status: "needs_input",
      evidenceRefs: [],
    };
    if (criterion.kind === "human") result.message = "等待人工确认验收。";
    else if (criterion.kind === "command") {
      result.failureKind = "unsupported";
      result.message =
        "此版本尚未配置本机固定命令及停止验证，请人工核验此命令检查。";
    } else
      try {
        const predicate = criterion.predicate;
        if (predicate.type === "jsonSchema") supported(predicate.schema);
        const observed = await artifact(
          root,
          criterion.relativePath,
          predicate.type !== "exists",
        );
        result.outputHash = observed.hash;
        result.evidenceRefs = [
          `native:artifact:${hash(criterion.relativePath)}`,
        ];
        let pass = observed.exists;
        if (pass && predicate.type === "textContains")
          pass = observed.text.includes(predicate.text);
        if (pass && predicate.type === "jsonSchema") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(observed.text);
          } catch {
            pass = false;
          }
          if (pass) pass = matches(parsed, predicate.schema);
        }
        result.status = pass ? "passed" : "failed";
        result.message = pass
          ? "本机文件验收通过。"
          : "实际文件未满足指定验收条件。";
        if (!pass) result.failureKind = "predicate";
      } catch (error) {
        result.failureKind = error instanceof CheckError ? error.kind : "error";
        result.message =
          error instanceof CheckError
            ? error.message
            : "本机无法读取验收文件，请人工处理后重试。";
      }
    results.push(result);
  }
  return results;
}
