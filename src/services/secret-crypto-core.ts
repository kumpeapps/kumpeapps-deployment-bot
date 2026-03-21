import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const ENCRYPTED_PREFIX = "enc:v1:";

export function deriveKey(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

export function isEncryptedValue(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_PREFIX);
}

export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return `${ENCRYPTED_PREFIX}${payload}`;
}

export function decryptWithKey(stored: string, key: Buffer): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) {
    // Backward compatibility: legacy plaintext passthrough.
    return stored;
  }

  const data = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), "base64");
  if (data.length < 12 + 16) {
    throw new Error("Encrypted secret payload is malformed");
  }

  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encryptedData = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString("utf8");
}
