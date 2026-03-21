import { appConfig } from "../config.js";
import {
  ENCRYPTED_PREFIX,
  decryptWithKey,
  deriveKey,
  encryptWithKey,
  isEncryptedValue
} from "./secret-crypto-core.js";

function getEncryptionKey(): Buffer {
  const raw = appConfig.SECRET_ENCRYPTION_KEY;
  if (!raw || raw.trim().length < 16) {
    throw new Error("SECRET_ENCRYPTION_KEY must be set to at least 16 characters");
  }
  return deriveKey(raw);
}

function keyFromPassphrase(passphrase: string): Buffer {
  if (!passphrase || passphrase.trim().length < 16) {
    throw new Error("Encryption passphrase must be at least 16 characters");
  }
  return deriveKey(passphrase);
}

export function encryptSecretValue(plaintext: string): string {
  return encryptWithKey(plaintext, getEncryptionKey());
}

export function decryptSecretValue(stored: string): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) {
    // Backward compatibility for legacy plaintext rows.
    return stored;
  }

  const keys: Buffer[] = [getEncryptionKey()];
  if (appConfig.SECRET_ENCRYPTION_PREVIOUS_KEYS.trim().length > 0) {
    const previous = appConfig.SECRET_ENCRYPTION_PREVIOUS_KEYS.split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map(keyFromPassphrase);
    keys.push(...previous);
  }

  for (const key of keys) {
    try {
      return decryptWithKey(stored, key);
    } catch {
      // Continue trying fallback keys.
    }
  }

  throw new Error("Unable to decrypt secret with configured keys");
}

export function decryptSecretValueWithPassphrase(stored: string, passphrase: string): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) {
    return stored;
  }

  return decryptWithKey(stored, keyFromPassphrase(passphrase));
}

export function encryptSecretValueWithPassphrase(plaintext: string, passphrase: string): string {
  return encryptWithKey(plaintext, keyFromPassphrase(passphrase));
}

export function isEncryptedSecretValue(stored: string): boolean {
  return isEncryptedValue(stored);
}
