import { scrypt, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// OWASP scrypt configuration with bounded memory for the Workers runtime.
const options = { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
const derive = (password, salt) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 32, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(password, salt);
  return `scrypt$16384$8$5$${Buffer.from(salt).toString("hex")}$${key.toString("hex")}`;
}
const dummy = `scrypt$16384$8$5$${"00".repeat(16)}$${"00".repeat(32)}`;
export async function verifyPassword(password, encoded = dummy) {
  const match = /^scrypt\$16384\$8\$5\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(
    encoded,
  );
  if (!match) return false;
  const key = await derive(password, Buffer.from(match[1], "hex"));
  return timingSafeEqual(key, Buffer.from(match[2], "hex"));
}
