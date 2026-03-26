/**
 * GitHub Automation Service
 * 
 * Provides helper functions for automating GitHub operations:
 * - Creating issues
 * - Adding comments
 * - Creating branches
 * - Creating/updating files
 * - Creating pull requests
 */

import { getGitHubToken } from "./github-app-auth.js";
import { recordAuditEvent } from "./audit.js";

interface CreateIssueInput {
  repositoryOwner: string;
  repositoryName: string;
  title: string;
  body: string;
  labels?: string[];
}

interface CreateIssueResponse {
  number: number;
  html_url: string;
  node_id: string;
}

interface CreateCommentInput {
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  body: string;
}

interface CreateBranchInput {
  repositoryOwner: string;
  repositoryName: string;
  branchName: string;
  fromRef?: string; // defaults to default branch
}

interface CreateOrUpdateFileInput {
  repositoryOwner: string;
  repositoryName: string;
  path: string;
  content: string;
  message: string;
  branch: string;
}

interface CreatePullRequestInput {
  repositoryOwner: string;
  repositoryName: string;
  title: string;
  body: string;
  head: string; // branch name
  base?: string; // defaults to default branch
}

interface CreatePullRequestResponse {
  number: number;
  html_url: string;
}

/**
 * Create a GitHub issue
 */
export async function createGitHubIssue(input: CreateIssueInput): Promise<CreateIssueResponse> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      labels: input.labels ?? []
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Note: This is error message construction, not SQL. Using template literals for clarity.
    throw new Error(`Failed to create issue: HTTP ${response.status} - ${errorText}`);
  }

  const issue = await response.json() as CreateIssueResponse;

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.issue.created",
    resourceType: "github_issue",
    resourceId: String(issue.number),
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      issueNumber: issue.number,
      title: input.title
    }
  });

  return issue;
}

/**
 * Add a comment to a GitHub issue
 */
export async function addGitHubComment(input: CreateCommentInput): Promise<void> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/${input.issueNumber}/comments`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      body: input.body
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to add comment: HTTP ${response.status} - ${errorText}`);
  }

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.comment.added",
    resourceType: "github_issue",
    resourceId: String(input.issueNumber),
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      issueNumber: input.issueNumber
    }
  });
}

/**
 * Get the default branch SHA
 */
async function getDefaultBranchSha(
  repositoryOwner: string,
  repositoryName: string,
  token: string,
  branch?: string
): Promise<{ sha: string; ref: string }> {
  // Get repository info to find default branch if not specified
  let targetBranch = branch;
  if (!targetBranch) {
    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}`;
    const repoResponse = await fetch(repoUrl, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!repoResponse.ok) {
      throw new Error(`Failed to get repository info: HTTP ${repoResponse.status}`);
    }

    const repoData = await repoResponse.json() as { default_branch: string };
    targetBranch = repoData.default_branch;
  }

  // Get the ref SHA
  const refUrl = `https://api.github.com/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/git/refs/heads/${targetBranch}`;
  const refResponse = await fetch(refUrl, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!refResponse.ok) {
    throw new Error(`Failed to get branch ref: HTTP ${refResponse.status}`);
  }

  const refData = await refResponse.json() as { object: { sha: string } };
  return { sha: refData.object.sha, ref: targetBranch };
}

/**
 * Create a new branch
 */
export async function createGitHubBranch(input: CreateBranchInput): Promise<void> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  // Get the SHA of the branch to fork from
  const { sha } = await getDefaultBranchSha(
    input.repositoryOwner,
    input.repositoryName,
    token,
    input.fromRef
  );

  // Create the new branch
  const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/git/refs`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ref: `refs/heads/${input.branchName}`,
      sha
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create branch: HTTP ${response.status} - ${errorText}`);
  }

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.branch.created",
    resourceType: "github_branch",
    resourceId: input.branchName,
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      branchName: input.branchName,
      fromRef: input.fromRef
    }
  });
}

/**
 * Create or update a file in a repository
 */
export async function createOrUpdateGitHubFile(input: CreateOrUpdateFileInput): Promise<void> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/contents/${input.path}`;

  // Check if file exists to get SHA for update
  let fileSha: string | undefined;
  try {
    const checkResponse = await fetch(`${url}?ref=${encodeURIComponent(input.branch)}`, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (checkResponse.ok) {
      const fileData = await checkResponse.json() as { sha: string };
      fileSha = fileData.sha;
    }
  } catch {
    // File doesn't exist, will create new
  }

  // Create or update the file
  const content = Buffer.from(input.content, "utf-8").toString("base64");

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: input.message,
      content,
      branch: input.branch,
      ...(fileSha ? { sha: fileSha } : {})
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create/update file: HTTP ${response.status} - ${errorText}`);
  }

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: fileSha ? "github.file.updated" : "github.file.created",
    resourceType: "github_file",
    resourceId: input.path,
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      path: input.path,
      branch: input.branch
    }
  });
}

/**
 * Create a pull request
 */
export async function createGitHubPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResponse> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  // Get default branch if not specified
  let baseBranch = input.base;
  if (!baseBranch) {
    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}`;
    const repoResponse = await fetch(repoUrl, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!repoResponse.ok) {
      throw new Error(`Failed to get repository info: HTTP ${repoResponse.status}`);
    }

    const repoData = await repoResponse.json() as { default_branch: string };
    baseBranch = repoData.default_branch;
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/pulls`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: baseBranch
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Note: This is error message construction, not SQL. Using template literals for clarity.
    throw new Error(`Failed to create pull request: HTTP ${response.status} - ${errorText}`);
  }

  const pr = await response.json() as CreatePullRequestResponse;

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.pr.created",
    resourceType: "github_pr",
    resourceId: String(pr.number),
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      prNumber: pr.number,
      title: input.title,
      head: input.head,
      base: baseBranch
    }
  });

  return pr;
}

/**
 * Link an issue to a branch (using development branch GraphQL API)
 */
export async function linkIssueToBranch(input: {
  repositoryOwner: string;
  repositoryName: string;
  issueNodeId: string;
  branchName: string;
}): Promise<void> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  // Note: This uses GraphQL to create the development link
  const query = `
    mutation LinkBranch($issueId: ID!, $repositoryId: ID!, $branchRef: String!) {
      createLinkedBranch(input: {
        issueId: $issueId
        repositoryId: $repositoryId
        ref: $branchRef
      }) {
        linkedBranch {
          id
        }
      }
    }
  `;

  // First get repository ID
  const repoQuery = `
    query GetRepo($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
      }
    }
  `;

  const repoResponse = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "kumpeapps-deployment-bot"
    },
    body: JSON.stringify({
      query: repoQuery,
      variables: {
        owner: input.repositoryOwner,
        name: input.repositoryName
      }
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!repoResponse.ok) {
    throw new Error(`Failed to get repository ID: HTTP ${repoResponse.status}`);
  }

  const repoData = await repoResponse.json() as { data: { repository: { id: string } } };
  const repositoryId = repoData.data.repository.id;

  // Link the branch
  const linkResponse = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "kumpeapps-deployment-bot"
    },
    body: JSON.stringify({
      query,
      variables: {
        issueId: input.issueNodeId,
        repositoryId,
        branchRef: `refs/heads/${input.branchName}`
      }
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!linkResponse.ok) {
    // Non-fatal error - log but don't fail
    console.warn(`Failed to link branch to issue: HTTP ${linkResponse.status}`);
    await recordAuditEvent({
      actorType: "system",
      actorId: "github-automation",
      action: "github.branch.link_failed",
      resourceType: "github_issue",
      resourceId: input.issueNodeId,
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        branchName: input.branchName,
        error: `HTTP ${linkResponse.status}`
      }
    });
    return;
  }

  // Parse response and check for GraphQL errors
  const linkData = await linkResponse.json() as { data?: unknown; errors?: Array<{ message: string }> };
  if (linkData.errors && linkData.errors.length > 0) {
    // GraphQL returned errors - log but don't fail
    const errorMessages = linkData.errors.map(e => e.message).join(', ');
    console.warn(`Failed to link branch to issue: ${errorMessages}`);
    await recordAuditEvent({
      actorType: "system",
      actorId: "github-automation",
      action: "github.branch.link_failed",
      resourceType: "github_issue",
      resourceId: input.issueNodeId,
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        branchName: input.branchName,
        error: errorMessages
      }
    });
    return;
  }

  // Success - record audit event
  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.branch.linked",
    resourceType: "github_issue",
    resourceId: input.issueNodeId,
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      branchName: input.branchName
    }
  });
}
