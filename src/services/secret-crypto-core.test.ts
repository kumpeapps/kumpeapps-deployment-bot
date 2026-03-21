import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENCRYPTED_PREFIX,
  decryptWithKey,
  deriveKey,
  encryptWithKey,
  isEncryptedValue
} from "./secret-crypto-core.js";

const TEST_PASSPHRASE = "test-passphrase-for-unit-testing-only";
const DIFFERENT_PASSPHRASE = "completely-different-passphrase-for-tests";

describe("deriveKey", () => {
  it("returns a 32-byte Buffer", () => {
    const key = deriveKey(TEST_PASSPHRASE);
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key.length, 32);
  });

  it("returns the same key for the same passphrase", () => {
    assert.deepEqual(deriveKey(TEST_PASSPHRASE), deriveKey(TEST_PASSPHRASE));
  });

  it("returns different keys for different passphrases", () => {
    assert.notDeepEqual(deriveKey(TEST_PASSPHRASE), deriveKey(DIFFERENT_PASSPHRASE));
  });
});

describe("isEncryptedValue", () => {
  it("returns true for enc:v1: prefixed strings", () => {
    const key = deriveKey(TEST_PASSPHRASE);
    const encrypted = encryptWithKey("hello", key);
    assert.ok(isEncryptedValue(encrypted));
  });

  it("returns false for plaintext strings", () => {
    assert.ok(!isEncryptedValue("some-plain-value"));
  });

  it("returns false for empty string", () => {
    assert.ok(!isEncryptedValue(""));
  });
});

describe("encryptWithKey / decryptWithKey", () => {
  const key = deriveKey(TEST_PASSPHRASE);
  const plaintext = "my-super-secret-value-!@#$%^&*()";

  it("encrypted value starts with the expected prefix", () => {
    const encrypted = encryptWithKey(plaintext, key);
    assert.ok(
      encrypted.startsWith(ENCRYPTED_PREFIX),
      `Expected prefix ${ENCRYPTED_PREFIX}, got: ${encrypted.slice(0, 20)}`
    );
  });

  it("decrypts back to the original plaintext", () => {
    const encrypted = encryptWithKey(plaintext, key);
    const decrypted = decryptWithKey(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  it("produces a different ciphertext on each call (random IV)", () => {
    const a = encryptWithKey(plaintext, key);
    const b = encryptWithKey(plaintext, key);
    assert.notEqual(a, b, "Two encryptions of the same plaintext must differ");
  });

  it("encrypts and decrypts an empty string", () => {
    const encrypted = encryptWithKey("", key);
    assert.equal(decryptWithKey(encrypted, key), "");
  });

  it("encrypts and decrypts a unicode string", () => {
    const emoji = "🚀 deployment complete 🎉";
    const encrypted = encryptWithKey(emoji, key);
    assert.equal(decryptWithKey(encrypted, key), emoji);
  });

  it("passes through non-encrypted legacy plaintext unchanged", () => {
    const legacy = "plaintext-value-no-prefix";
    assert.equal(decryptWithKey(legacy, key), legacy);
  });

  it("throws when the GCM auth tag is tampered (wrong key)", () => {
    const encrypted = encryptWithKey(plaintext, key);
    const wrongKey = deriveKey(DIFFERENT_PASSPHRASE);
    assert.throws(() => decryptWithKey(encrypted, wrongKey));
  });

  it("throws when the ciphertext payload is too short", () => {
    const malformed = ENCRYPTED_PREFIX + Buffer.from("tooshort").toString("base64");
    assert.throws(() => decryptWithKey(malformed, key), /malformed/);
  });

  it("throws when the base64 payload is corrupted", () => {
    const encrypted = encryptWithKey(plaintext, key);
    // Flip the last few base64 characters to corrupt the tag/data.
    const tampered = encrypted.slice(0, -6) + "AAAAAA";
    assert.throws(() => decryptWithKey(tampered, key));
  });

  it("round-trips with a different key correctly derived", () => {
    const otherKey = deriveKey(DIFFERENT_PASSPHRASE);
    const encrypted = encryptWithKey("another-value", otherKey);
    assert.equal(decryptWithKey(encrypted, otherKey), "another-value");
  });
});
