/**
 * GitHub issue type helpers (pure; no app config / network).
 */

export type GitHubIssueType = {
  name: string;
  is_enabled?: boolean;
};

/**
 * Pick a preferred issue type name (default Task) when the repo/org exposes it.
 * Returns undefined when unavailable so callers can omit `type` on create.
 */
export function resolvePreferredIssueTypeName(
  availableTypes: GitHubIssueType[],
  preferredName = "Task"
): string | undefined {
  const preferred = preferredName.toLowerCase();
  const match = availableTypes.find(
    (t) => t.name.toLowerCase() === preferred && t.is_enabled !== false
  );
  return match?.name;
}
