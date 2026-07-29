import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePreferredIssueTypeName } from "./github-issue-types.js";

describe("resolvePreferredIssueTypeName", () => {
  it("returns the canonical Task name when enabled", () => {
    assert.equal(
      resolvePreferredIssueTypeName([
        { name: "Bug", is_enabled: true },
        { name: "Task", is_enabled: true },
        { name: "Feature", is_enabled: true }
      ]),
      "Task"
    );
  });

  it("matches preferred name case-insensitively", () => {
    assert.equal(
      resolvePreferredIssueTypeName([{ name: "task", is_enabled: true }], "Task"),
      "task"
    );
  });

  it("returns undefined when Task is missing or disabled", () => {
    assert.equal(
      resolvePreferredIssueTypeName([{ name: "Bug", is_enabled: true }, { name: "Feature", is_enabled: true }]),
      undefined
    );
    assert.equal(
      resolvePreferredIssueTypeName([{ name: "Task", is_enabled: false }]),
      undefined
    );
  });
});
