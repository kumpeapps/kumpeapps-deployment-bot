import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryRateLimiter } from "./rate-limit.js";

describe("InMemoryRateLimiter", () => {
  it("allows requests until max and then blocks", () => {
    const limiter = new InMemoryRateLimiter(60_000);

    const first = limiter.consume("ip:1", 2);
    const second = limiter.consume("ip:1", 2);
    const third = limiter.consume("ip:1", 2);

    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
  });

  it("isolates counters by key", () => {
    const limiter = new InMemoryRateLimiter(60_000);

    const a = limiter.consume("ip:A", 1);
    const b = limiter.consume("ip:B", 1);
    const aBlocked = limiter.consume("ip:A", 1);

    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.equal(aBlocked.allowed, false);
  });

  it("returns reset timestamp at or after current time", () => {
    const limiter = new InMemoryRateLimiter(60_000);
    const now = Math.floor(Date.now() / 1000);

    const result = limiter.consume("ip:clock", 1);
    assert.ok(result.resetEpochSeconds >= now);
  });
});
