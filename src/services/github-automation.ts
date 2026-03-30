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

import { appConfig } from "../config.js";
import { getGitHubToken, getInstallationTokenById } from "./github-app-auth.js";
import { recordAuditEvent } from "./audit.js";

interface CreateIssueInput {
  repositoryOwner: string;
  repositoryName: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
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
  assignees?: string[];
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
      // Note: assignees assigned separately to handle pending invitations
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Note: This is error message construction, not SQL. Using template literals for clarity.
    throw new Error(`Failed to create issue: HTTP ${response.status} - ${errorText}`);
  }

  const issue = await response.json() as CreateIssueResponse;

  // Try to assign issue if assignees were provided (non-fatal if it fails due to pending invitations)
  if (input.assignees && input.assignees.length > 0) {
    try {
      const assignUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/${issue.number}`;
      const assignResponse = await fetch(assignUrl, {
        method: "PATCH",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "kumpeapps-deployment-bot",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          assignees: input.assignees
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!assignResponse.ok) {
        const errorText = await assignResponse.text();
        console.warn(`Failed to assign issue: HTTP ${assignResponse.status} - ${errorText}`);
      }
    } catch (error) {
      console.warn(`Failed to assign issue:`, error);
    }
  }

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
 * Returns the comment ID for later updates
 */
export async function addGitHubComment(input: CreateCommentInput): Promise<number> {
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

  const commentData = await response.json() as { id: number };

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.comment.added",
    resourceType: "github_issue",
    resourceId: String(input.issueNumber),
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      issueNumber: input.issueNumber,
      commentId: commentData.id
    }
  });

  return commentData.id;
}

/**
 * Update an existing GitHub comment
 */
export async function updateGitHubComment(input: {
  repositoryOwner: string;
  repositoryName: string;
  commentId: number;
  body: string;
}): Promise<void> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/comments/${input.commentId}`;

  const response = await fetch(url, {
    method: "PATCH",
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
    throw new Error(`Failed to update comment: HTTP ${response.status} - ${errorText}`);
  }

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.comment.updated",
    resourceType: "github_comment",
    resourceId: String(input.commentId),
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      commentId: input.commentId
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
      // Note: assignees assigned separately to handle pending invitations
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Note: This is error message construction, not SQL. Using template literals for clarity.
    throw new Error(`Failed to create pull request: HTTP ${response.status} - ${errorText}`);
  }

  const pr = await response.json() as CreatePullRequestResponse;

  // Try to assign PR if assignees were provided (non-fatal if it fails due to pending invitations)
  if (input.assignees && input.assignees.length > 0) {
    try {
      const assignUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/issues/${pr.number}`;
      const assignResponse = await fetch(assignUrl, {
        method: "PATCH",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "kumpeapps-deployment-bot",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          assignees: input.assignees
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!assignResponse.ok) {
        const errorText = await assignResponse.text();
        console.warn(`Failed to assign pull request: HTTP ${assignResponse.status} - ${errorText}`);
      }
    } catch (error) {
      console.warn(`Failed to assign pull request:`, error);
    }
  }

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
 * Create multiple files in a single commit using Git Tree API
 */
export async function createMultipleFilesInSingleCommit(input: {
  repositoryOwner: string;
  repositoryName: string;
  branch: string;
  files: Array<{ path: string; content: string }>;
  message: string;
}): Promise<void> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  // Get the current commit SHA of the branch
  const refUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/git/refs/heads/${encodeURIComponent(input.branch)}`;
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
  const currentCommitSha = refData.object.sha;

  // Get the tree SHA of the current commit
  const commitUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/git/commits/${currentCommitSha}`;
  const commitResponse = await fetch(commitUrl, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!commitResponse.ok) {
    throw new Error(`Failed to get commit: HTTP ${commitResponse.status}`);
  }

  const commitData = await commitResponse.json() as { tree: { sha: string } };
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for each file
  const treeItems = await Promise.all(
    input.files.map(async (file) => {
      const blobUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/git/blobs`;
      const blobResponse = await fetch(blobUrl, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "kumpeapps-deployment-bot",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: file.content,
          encoding: "utf-8"
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!blobResponse.ok) {
        throw new Error(`Failed to create blob for ${file.path}: HTTP ${blobResponse.status}`);
      }

      const blobData = await blobResponse.json() as { sha: string };
      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobData.sha
      };
    })
  );

  // Create a new tree
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/git/trees`;
  const treeResponse = await fetch(treeUrl, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!treeResponse.ok) {
    const errorText = await treeResponse.text();
    throw new Error(`Failed to create tree: HTTP ${treeResponse.status} - ${errorText}`);
  }

  const treeData = await treeResponse.json() as { sha: string };
  const newTreeSha = treeData.sha;

  // Create a new commit
  const newCommitUrl = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/git/commits`;
  const newCommitResponse = await fetch(newCommitUrl, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: input.message,
      tree: newTreeSha,
      parents: [currentCommitSha]
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!newCommitResponse.ok) {
    const errorText = await newCommitResponse.text();
    throw new Error(`Failed to create commit: HTTP ${newCommitResponse.status} - ${errorText}`);
  }

  const newCommitData = await newCommitResponse.json() as { sha: string };
  const newCommitSha = newCommitData.sha;

  // Update the branch reference
  const updateRefResponse = await fetch(refUrl, {
    method: "PATCH",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sha: newCommitSha,
      force: false
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!updateRefResponse.ok) {
    const errorText = await updateRefResponse.text();
    throw new Error(`Failed to update branch ref: HTTP ${updateRefResponse.status} - ${errorText}`);
  }

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.files.created_batch",
    resourceType: "github_commit",
    resourceId: newCommitSha,
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      branch: input.branch,
      filesCount: input.files.length,
      message: input.message
    }
  });
}

/**
 * Fetch file content from a GitHub repository
 */
export async function fetchFileFromGitHub(input: {
  repositoryOwner: string;
  repositoryName: string;
  path: string;
  ref?: string; // branch, tag, or commit SHA (defaults to default branch)
}): Promise<string> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/contents/${encodeURIComponent(input.path)}${input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ''}`;

  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch file ${input.path}: HTTP ${response.status} - ${errorText}`);
  }

  const fileData = await response.json() as { content: string; encoding: string; type: string };
  
  if (fileData.type !== 'file') {
    throw new Error(`Path ${input.path} is not a file`);
  }

  if (fileData.encoding !== 'base64') {
    throw new Error(`Unexpected encoding: ${fileData.encoding}`);
  }

  // Decode base64 content
  const content = Buffer.from(fileData.content, 'base64').toString('utf-8');

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.file.fetched",
    resourceType: "github_file",
    resourceId: input.path,
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      path: input.path,
      ref: input.ref,
      sizeBytes: content.length
    }
  });

  return content;
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

/**
 * Add a collaborator to a repository
 * Uses GitHub App installation token to create the invitation
 * For kumpeapps-bot-deploy, the invitation is then accepted via acceptRepositoryInvitation()
 * 
 * @param token - Optional GitHub token. If not provided, will look up installation token from database.
 */
export async function addRepositoryCollaborator(input: {
  repositoryOwner: string;
  repositoryName: string;
  username: string;
  permission?: "pull" | "push" | "admin" | "maintain" | "triage"; // defaults to push
  token?: string; // Optional token to avoid database lookup
}): Promise<void> {
  const token = input.token ?? await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/collaborators/${encodeURIComponent(input.username)}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "kumpeapps-deployment-bot",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      permission: input.permission ?? "push"
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to add collaborator: HTTP ${response.status} - ${errorText}`);
  }

  await recordAuditEvent({
    actorType: "system",
    actorId: "github-automation",
    action: "github.collaborator.added",
    resourceType: "github_repository",
    resourceId: `${input.repositoryOwner}/${input.repositoryName}`,
    payload: {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      username: input.username,
      permission: input.permission ?? "push"
    }
  });
}

/**
 * Accept a pending repository invitation for a user account
 * Used to auto-accept collaborator invitations for the bot user account
 */
export async function acceptRepositoryInvitation(input: {
  repositoryOwner: string;
  repositoryName: string;
}): Promise<boolean> {
  const { BOT_USER_TOKEN } = appConfig;

  if (!BOT_USER_TOKEN) {
    console.warn("BOT_USER_TOKEN not configured - cannot auto-accept invitation");
    return false;
  }

  try {
    // List pending invitations for the user
    const listUrl = "https://api.github.com/user/repository_invitations";
    const listResponse = await fetch(listUrl, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${BOT_USER_TOKEN}`,
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.warn(`Failed to list invitations: HTTP ${listResponse.status} - ${errorText}`);
      return false;
    }

    const invitations = await listResponse.json() as Array<{
      id: number;
      repository: {
        full_name: string;
        owner: { login: string };
        name: string;
      };
    }>;

    // Find the invitation for this specific repository
    const repoFullName = `${input.repositoryOwner}/${input.repositoryName}`;
    const invitation = invitations.find(inv => inv.repository.full_name === repoFullName);

    if (!invitation) {
      console.warn(`No pending invitation found for ${repoFullName}`);
      return false;
    }

    // Accept the invitation
    const acceptUrl = `https://api.github.com/user/repository_invitations/${invitation.id}`;
    const acceptResponse = await fetch(acceptUrl, {
      method: "PATCH",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${BOT_USER_TOKEN}`,
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!acceptResponse.ok) {
      const errorText = await acceptResponse.text();
      console.warn(`Failed to accept invitation: HTTP ${acceptResponse.status} - ${errorText}`);
      return false;
    }

    await recordAuditEvent({
      actorType: "system",
      actorId: "github-automation",
      action: "github.invitation.accepted",
      resourceType: "github_repository",
      resourceId: `${input.repositoryOwner}/${input.repositoryName}`,
      payload: {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        invitationId: invitation.id
      }
    });

    return true;
  } catch (error) {
    console.warn(`Error accepting repository invitation:`, error);
    return false;
  }
}

/**
 * Remove a collaborator from a repository using the bot user token
 * Used during repository cleanup to remove kumpeapps-bot-deploy from collaborators list
 */
export async function removeRepositoryCollaborator(input: {
  repositoryOwner: string;
  repositoryName: string;
  username: string;
}): Promise<{ success: boolean; error?: string }> {
  const { BOT_USER_TOKEN } = appConfig;

  if (!BOT_USER_TOKEN) {
    return {
      success: false,
      error: "BOT_USER_TOKEN not configured"
    };
  }

  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/collaborators/${encodeURIComponent(input.username)}`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${BOT_USER_TOKEN}`,
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(15000)
    });

    // GitHub returns 204 on success, 404 if not a collaborator
    if (response.ok || response.status === 404) {
      await recordAuditEvent({
        actorType: "system",
        actorId: "github-automation",
        action: "github.collaborator.removed",
        resourceType: "github_repository",
        resourceId: `${input.repositoryOwner}/${input.repositoryName}`,
        payload: {
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          username: input.username,
          statusCode: response.status
        }
      });

      return { success: true };
    }

    const errorText = await response.text();
    return {
      success: false,
      error: `HTTP ${response.status} - ${errorText}`
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Check if a directory exists in a GitHub repository
 * @param input Repository details and directory path
 * @returns true if directory exists, false otherwise
 */
export async function checkDirectoryExists(input: {
  repositoryOwner: string;
  repositoryName: string;
  directoryPath: string;
  ref?: string;
}): Promise<boolean> {
  try {
    const installationToken = await getGitHubToken(
      input.repositoryOwner,
      input.repositoryName
    );

    const ref = input.ref ?? "HEAD";
    const url = `https://api.github.com/repos/${input.repositoryOwner}/${input.repositoryName}/contents/${input.directoryPath}?ref=${ref}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${installationToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(15000)
    });

    // 200 = directory exists
    // 404 = directory doesn't exist
    return response.ok;
  } catch (error) {
    console.warn(`Error checking directory existence:`, error);
    return false;
  }
}

/**
 * List all repositories accessible to a GitHub App installation
 * Used when app is installed with "All repositories" access
 */
export async function listInstallationRepositories(input: {
  installationId: bigint;
}): Promise<Array<{ owner: string; name: string; defaultBranch: string }>> {
  const installationToken = await getInstallationTokenById(input.installationId);
  if (!installationToken) {
    throw new Error("No installation token available");
  }

  const repositories: Array<{ owner: string; name: string; defaultBranch: string }> = [];
  let page = 1;
  const perPage = 100;

  try {
    while (true) {
      const url = `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${installationToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "kumpeapps-deployment-bot"
        },
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to list installation repositories: HTTP ${response.status} - ${errorText}`);
      }

      const data = await response.json() as {
        total_count: number;
        repositories: Array<{
          full_name: string;
          default_branch: string;
        }>;
      };

      for (const repo of data.repositories) {
        const [owner, name] = repo.full_name.split("/");
        if (owner && name) {
          repositories.push({
            owner,
            name,
            defaultBranch: repo.default_branch || "main"
          });
        }
      }

      // Check if we've fetched all repositories
      if (data.repositories.length < perPage) {
        break;
      }

      page++;
    }

    return repositories;
  } catch (error) {
    console.error("Error listing installation repositories:", error);
    throw error;
  }
}

/**
 * Check if a user is a collaborator on a repository
 * Returns true if user has any permission level (read, triage, write, maintain, admin)
 */
export async function isUserCollaborator(input: {
  repositoryOwner: string;
  repositoryName: string;
  username: string;
}): Promise<boolean> {
  const token = await getGitHubToken(input.repositoryOwner, input.repositoryName);
  if (!token) {
    throw new Error("No GitHub token available");
  }

  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.repositoryOwner)}/${encodeURIComponent(input.repositoryName)}/collaborators/${encodeURIComponent(input.username)}/permission`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kumpeapps-deployment-bot"
      },
      signal: AbortSignal.timeout(10000)
    });

    if (response.status === 404) {
      // User is not a collaborator
      return false;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to check collaborator status: HTTP ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      permission: string; // "admin" | "write" | "read" | "none" | "maintain" | "triage"
      user: { login: string };
    };

    // Any permission except "none" means they are a collaborator
    return data.permission !== "none";
  } catch (error) {
    console.error(`Error checking if ${input.username} is collaborator:`, error);
    throw error;
  }
}

