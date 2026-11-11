import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  WindowsCredentialManager,
  credentialTarget,
} from "../runner/dist/index.js";

// Only this freshly generated Runner target is read/written/deleted. No secrets
// are printed, placed on the command line, or saved alongside the verification.
const target = credentialTarget(
  "https://vault-check.qingdan.invalid",
  randomUUID(),
);
const vault = new WindowsCredentialManager();
const secret = randomBytes(32).toString("base64url");
assert.equal(await vault.read(target), null);
try {
  await vault.write(target, secret);
  assert.equal(await vault.read(target), secret);
} finally {
  await vault.delete(target);
}
assert.equal(await vault.read(target), null);
console.log(
  "Windows Credential Manager round trip passed; temporary Runner credential removed.",
);
