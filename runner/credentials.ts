import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RunnerError } from "./errors";
export interface CredentialStore {
  read(target: string): Promise<string | null>;
  write(target: string, secret: string): Promise<void>;
  delete(target: string): Promise<void>;
}
const prefix = "QingdanRunner/v1/";
export function validateServerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RunnerError("VALIDATION_ERROR", "Invalid Runner server origin.");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new RunnerError(
      "VALIDATION_ERROR",
      "Runner server requires HTTPS or an explicit loopback HTTP origin.",
    );
  return url.origin;
}
export function credentialTarget(serverOrigin: string, runnerId: string) {
  const origin = validateServerOrigin(serverOrigin);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      runnerId,
    )
  )
    throw new RunnerError("VALIDATION_ERROR", "Invalid Runner identity.");
  return `${prefix}${createHash("sha256").update(origin).digest("hex")}/${runnerId.toLowerCase()}`;
}
type VaultRequest = {
  operation: "read" | "write" | "delete";
  target: string;
  secret?: string;
};
/** Test injection receives the stdin payload, never shell command text. */
export class WindowsCredentialManager implements CredentialStore {
  private platform: string;
  private invoke: (request: VaultRequest) => Promise<string | null>;
  constructor(
    options: {
      platform?: string;
      invoke?: (request: VaultRequest) => Promise<string | null>;
    } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.invoke = options.invoke ?? ((request) => this.run(request));
  }
  validateTarget(target: string) {
    if (
      !/^QingdanRunner\/v1\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        target,
      )
    )
      throw new RunnerError(
        "ACCESS_DENIED",
        "Credential target is outside the Runner namespace.",
      );
  }
  private async operation(request: VaultRequest) {
    this.validateTarget(request.target);
    if (this.platform !== "win32")
      throw new RunnerError(
        "CREDENTIAL_STORAGE_UNAVAILABLE",
        "Windows Credential Manager is required.",
      );
    return this.invoke(request);
  }
  async read(target: string) {
    return this.operation({ operation: "read", target });
  }
  async write(target: string, secret: string) {
    if (!secret || Buffer.byteLength(secret, "utf16le") > 2560)
      throw new RunnerError("VALIDATION_ERROR", "Invalid credential length.");
    await this.operation({ operation: "write", target, secret });
  }
  async delete(target: string) {
    await this.operation({ operation: "delete", target });
  }
  private run(request: VaultRequest): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const helper = fileURLToPath(
        new URL("./credential-helper.ps1", import.meta.url),
      );
      const child = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helper,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "";
      let size = 0;
      const timeout = setTimeout(() => {
        child.kill();
        reject(
          new RunnerError(
            "CREDENTIAL_STORAGE_FAILED",
            "Credential Manager timed out.",
          ),
        );
      }, 15000);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16000) {
          child.kill();
          return;
        }
        out += chunk.toString("utf8");
      });
      child.stderr.on("data", () => {});
      child.on("error", () => {
        clearTimeout(timeout);
        reject(
          new RunnerError(
            "CREDENTIAL_STORAGE_FAILED",
            "Unable to start Credential Manager helper.",
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0)
          return reject(
            new RunnerError(
              "CREDENTIAL_STORAGE_FAILED",
              "Credential Manager operation failed.",
            ),
          );
        try {
          const result = JSON.parse(out);
          resolve(result.secret ?? null);
        } catch {
          reject(
            new RunnerError(
              "CREDENTIAL_STORAGE_FAILED",
              "Credential Manager returned an invalid response.",
            ),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }
}
export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  async read(target: string) {
    return this.values.get(target) ?? null;
  }
  async write(target: string, secret: string) {
    this.values.set(target, secret);
  }
  async delete(target: string) {
    this.values.delete(target);
  }
}
