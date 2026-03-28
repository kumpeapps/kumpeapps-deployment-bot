import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appConfig } from "../config.js";
import { recordSshCommandAttempt, recordSshCommandFinalFailure, recordSshCommandSuccess } from "./ssh-health.js";

const execFileAsync = promisify(execFile);

type VmUserSyncInput = {
  repositoryOwner: string;
  repositoryName: string;
  vmIp: string;
  authorizedAdmins: string[];
  githubToken: string;
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  dryRun: boolean;
};

type RemoteCommandOptions = {
  sshUser: string;
  sshKeyPath: string;
  sshPort: number;
  host: string;
};

function commonSshArgs(input: { sshKeyPath: string; sshPort: number }): string[] {
  return [
    "-i",
    input.sshKeyPath,
    "-p",
    String(input.sshPort),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${appConfig.SSH_CONNECT_TIMEOUT_SECONDS}`,
    "-o",
    `StrictHostKeyChecking=${appConfig.SSH_STRICT_HOST_KEY_CHECKING}`,
    "-o",
    `UserKnownHostsFile=${appConfig.SSH_KNOWN_HOSTS_PATH}`
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as { code?: string; message?: string };
  if (err.code === "ETIMEDOUT") {
    return true;
  }

  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  return message.includes("timed out") || message.includes("timeout");
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string }> {
  let attempt = 0;
  let lastError: unknown;
  const maxAttempts = appConfig.SSH_COMMAND_RETRIES + 1;

  while (attempt < maxAttempts) {
    recordSshCommandAttempt({ isRetry: attempt > 0 });
    try {
      const { stdout } = await execFileAsync(command, args, {
        maxBuffer: 1024 * 1024,
        timeout: appConfig.SSH_CONNECT_TIMEOUT_SECONDS * 1000
      });
      recordSshCommandSuccess();
      return { stdout };
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  recordSshCommandFinalFailure({
    timedOut: isTimeoutError(lastError)
  });

  if (lastError instanceof Error) {
    const maybeStdout = "stdout" in lastError ? String((lastError as { stdout?: unknown }).stdout ?? "") : "";
    const maybeStderr = "stderr" in lastError ? String((lastError as { stderr?: unknown }).stderr ?? "") : "";
    
    // Build detailed error message with both stdout and stderr
    let errorMessage = lastError.message;
    if (maybeStdout.trim()) {
      errorMessage += ` | stdout: ${maybeStdout.trim()}`;
    }
    if (maybeStderr.trim()) {
      errorMessage += ` | stderr: ${maybeStderr.trim()}`;
    }
    
    throw new Error(errorMessage);
  }

  throw new Error("Command execution failed");
}

async function runRemoteSsh(input: RemoteCommandOptions, remoteCommand: string): Promise<{ stdout: string }> {
  return runCommand("ssh", [...commonSshArgs({ sshKeyPath: input.sshKeyPath, sshPort: input.sshPort }), `${input.sshUser}@${input.host}`, remoteCommand]);
}

/**
 * Generate a random password for new users
 */
function generateRandomPassword(length: number = 32): string {
  return randomBytes(length).toString("base64").slice(0, length);
}

/**
 * Fetch all collaborators for a GitHub repository
 */
async function fetchGitHubCollaborators(input: {
  owner: string;
  repo: string;
  githubToken: string;
}): Promise<string[]> {
  const collaborators: string[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/${input.owner}/${input.repo}/collaborators?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${input.githubToken}`,
          Accept: "application/vnd.github+json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch collaborators: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{ login: string }>;
    if (data.length === 0) {
      break;
    }

    collaborators.push(...data.map((user) => user.login));

    if (data.length < perPage) {
      break;
    }

    page += 1;
  }

  return collaborators;
}

/**
 * Fetch repository admins (users with admin permission)
 */
async function fetchGitHubAdmins(input: {
  owner: string;
  repo: string;
  githubToken: string;
}): Promise<string[]> {
  const admins: string[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/${input.owner}/${input.repo}/collaborators?permission=admin&per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${input.githubToken}`,
          Accept: "application/vnd.github+json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch repository admins: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{ login: string }>;
    if (data.length === 0) {
      break;
    }

    admins.push(...data.map((user) => user.login));

    if (data.length < perPage) {
      break;
    }

    page += 1;
  }

  return admins;
}

/**
 * Fetch organization team members
 * 
 * Note: Requires GitHub App to have "Organization: Members" read permission
 * or a personal access token with org:read scope. Repository-scoped tokens
 * will return 404 even if the team exists.
 */
async function fetchGitHubTeamMembers(input: {
  org: string;
  teamSlug: string;
  githubToken: string;
}): Promise<string[]> {
  const members: string[] = [];
  
  console.log(`[VM User Management] Attempting to access team: ${input.org}/${input.teamSlug}`);
  console.log(`[VM User Management] Using token: ${input.githubToken.substring(0, 10)}...${input.githubToken.substring(input.githubToken.length - 4)}`);
  
  // First, try to list all teams to help with debugging
  try {
    const teamsListResponse = await fetch(
      `https://api.github.com/orgs/${input.org}/teams?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${input.githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      }
    );
    
    if (teamsListResponse.ok) {
      const teams = await teamsListResponse.json() as Array<{ slug: string; name: string; privacy: string }>;
      console.log(`[VM User Management] Available teams in ${input.org}:`, 
        teams.map(t => `${t.slug} (${t.name}, ${t.privacy})`).join(', ') || 'none');
      
      // Check if the requested team exists with different casing
      const matchingTeam = teams.find(t => t.slug.toLowerCase() === input.teamSlug.toLowerCase());
      if (matchingTeam && matchingTeam.slug !== input.teamSlug) {
        console.warn(`[VM User Management] Team slug case mismatch: requested "${input.teamSlug}" but found "${matchingTeam.slug}"`);
      }
    } else {
      console.warn(`[VM User Management] Failed to list teams: ${teamsListResponse.status} ${teamsListResponse.statusText}`);
      console.warn(`[VM User Management] This usually means: (1) Token lacks org:read or members:read permission, (2) GitHub App installation token has repository scope only (not org-wide), (3) Organization doesn't exist`);
    }
  } catch (error) {
    console.warn(`[VM User Management] Could not list teams (request failed):`, error);
  }
  
  // Try to get team info to verify access
  const teamInfoResponse = await fetch(
    `https://api.github.com/orgs/${input.org}/teams/${input.teamSlug}`,
    {
      headers: {
        Authorization: `Bearer ${input.githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );

  if (!teamInfoResponse.ok) {
    if (teamInfoResponse.status === 404) {
      throw new Error(
        `Failed to access team ${input.org}/${input.teamSlug}: 404 Not Found. ` +
        `Possible causes: (1) Team doesn't exist or slug is incorrect (check available teams in logs above), ` +
        `(2) Team is "Secret" and GitHub App is not a member of the team, ` +
        `(3) GitHub App lacks "Organization: Members" read permission. ` +
        `To fix: Verify team exists at https://github.com/orgs/${input.org}/teams/${input.teamSlug}, ` +
        `ensure GitHub App installation has "Members" permission, and if team is Secret, add the app as a team member.`
      );
    }
    throw new Error(`Failed to access team ${input.org}/${input.teamSlug}: ${teamInfoResponse.status} ${teamInfoResponse.statusText}`);
  }

  const teamInfo = await teamInfoResponse.json() as { id: number; slug: string; name: string; privacy: string };
  console.log(`[VM User Management] Successfully accessed team: ${teamInfo.name} (${teamInfo.slug}, ${teamInfo.privacy})`);

  // Now fetch members using pagination
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `https://api.github.com/orgs/${input.org}/teams/${input.teamSlug}/members?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${input.githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch team members for ${input.org}/${input.teamSlug}: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{ login: string }>;
    if (data.length === 0) {
      break;
    }

    members.push(...data.map((user) => user.login));

    if (data.length < perPage) {
      break;
    }

    page += 1;
  }
  
  console.log(`[VM User Management] Found ${members.length} members in team ${input.org}/${input.teamSlug}`);

  return members;
}

/**
 * Expand smart groups like "github.repo.collaborators", "github.repo.admins", and "github.org.team.*" into actual usernames
 * 
 * If a smart group fails to expand (e.g., permission denied, team not found), the error is logged as a warning
 * and that group is skipped, but processing continues for other groups. This ensures partial failures don't
 * block the entire deployment.
 */
async function expandSmartGroups(input: {
  authorizedAdmins: string[];
  repositoryOwner: string;
  repositoryName: string;
  githubToken: string;
}): Promise<string[]> {
  const expandedUsers = new Set<string>();

  for (const entry of input.authorizedAdmins) {
    const trimmed = entry.trim();
    
    try {
      if (trimmed === "github.repo.collaborators") {
        // Expand to all repository collaborators
        const collaborators = await fetchGitHubCollaborators({
          owner: input.repositoryOwner,
          repo: input.repositoryName,
          githubToken: input.githubToken
        });
        collaborators.forEach((username) => expandedUsers.add(username));
      } else if (trimmed === "github.repo.admins") {
        // Expand to repository admins only
        const admins = await fetchGitHubAdmins({
          owner: input.repositoryOwner,
          repo: input.repositoryName,
          githubToken: input.githubToken
        });
        admins.forEach((username) => expandedUsers.add(username));
      } else if (trimmed.startsWith("github.org.")) {
        // Expand to organization team members
        // Supports two patterns:
        //   1. github.org.team.TEAM_SLUG (uses repository owner as org)
        //   2. github.org.ORG_NAME.team.TEAM_SLUG (explicitly specifies org)
        const afterOrg = trimmed.substring("github.org.".length);
        
        let org: string;
        let teamSlug: string;
        
        if (afterOrg.startsWith("team.")) {
          // Pattern 1: github.org.team.TEAM_SLUG
          org = input.repositoryOwner;
          teamSlug = afterOrg.substring("team.".length);
        } else {
          // Pattern 2: github.org.ORG_NAME.team.TEAM_SLUG
          const parts = afterOrg.split(".team.");
          if (parts.length >= 2) {
            org = parts[0];
            teamSlug = parts.slice(1).join(".team."); // Support team slugs with ".team." in them
          } else {
            continue; // Invalid pattern, skip
          }
        }
        
        if (org && teamSlug) {
          const teamMembers = await fetchGitHubTeamMembers({
            org,
            teamSlug,
            githubToken: input.githubToken
          });
          teamMembers.forEach((username) => expandedUsers.add(username));
        }
      } else {
        // Regular username
        expandedUsers.add(trimmed);
      }
    } catch (error) {
      // Log warning but continue processing other groups
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.warn(`[VM User Management] Failed to expand smart group "${trimmed}": ${errorMessage}`);
      console.warn(`[VM User Management] Skipping group and continuing with others...`);
    }
  }

  return Array.from(expandedUsers);
}

/**
 * Check if a user exists on the VM
 */
async function checkUserExists(input: RemoteCommandOptions & { username: string }): Promise<boolean> {
  try {
    await runRemoteSsh(input, `id ${shellQuote(input.username)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a group exists on the VM
 */
async function checkGroupExists(input: RemoteCommandOptions & { groupName: string }): Promise<boolean> {
  try {
    await runRemoteSsh(input, `getent group ${shellQuote(input.groupName)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a group on the VM
 */
async function createGroup(input: RemoteCommandOptions & { groupName: string }): Promise<void> {
  await runRemoteSsh(input, `sudo groupadd ${shellQuote(input.groupName)}`);
}

/**
 * Create a user on the VM with a random password
 */
async function createUser(input: RemoteCommandOptions & { username: string; password: string }): Promise<void> {
  const escapedPassword = shellQuote(input.password);
  const escapedUsername = shellQuote(input.username);
  
  // Create user with home directory and bash shell
  await runRemoteSsh(
    input,
    `sudo useradd -m -s /bin/bash ${escapedUsername}`
  );
  
  // Set the password
  await runRemoteSsh(
    input,
    `echo ${escapedUsername}:${escapedPassword} | sudo chpasswd`
  );
}

/**
 * Check if a user is in a specific group
 */
async function checkUserInGroup(input: RemoteCommandOptions & { username: string; groupName: string }): Promise<boolean> {
  try {
    // Use `id -nG` for reliable group list parsing across different systems
    const { stdout } = await runRemoteSsh(
      input,
      `id -nG ${shellQuote(input.username)}`
    );
    
    const groups = stdout.trim().split(/\s+/);
    return groups.includes(input.groupName);
  } catch {
    return false;
  }
}

/**
 * Add a user to a group
 */
async function addUserToGroup(input: RemoteCommandOptions & { username: string; groupName: string }): Promise<void> {
  await runRemoteSsh(
    input,
    `sudo usermod -a -G ${shellQuote(input.groupName)} ${shellQuote(input.username)}`
  );
}

/**
 * Remove a user from a group
 */
async function removeUserFromGroup(input: RemoteCommandOptions & { username: string; groupName: string }): Promise<void> {
  await runRemoteSsh(
    input,
    `sudo gpasswd -d ${shellQuote(input.username)} ${shellQuote(input.groupName)}`
  );
}

/**
 * Get all members of a group
 */
async function getGroupMembers(input: RemoteCommandOptions & { groupName: string }): Promise<string[]> {
  try {
    const { stdout } = await runRemoteSsh(
      input,
      `getent group ${shellQuote(input.groupName)}`
    );
    
    // Group entry format: groupname:password:gid:user1,user2,user3
    const parts = stdout.trim().split(':');
    if (parts.length >= 4 && parts[3]) {
      return parts[3].split(',').filter(u => u.trim().length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Sync authorized admins to VM - ensure users exist and are in bot-admin group
 * 
 * Supports smart groups:
 * - github.repo.collaborators: Expands to all repository collaborators
 * - github.repo.admins: Expands to repository admins only
 * - github.org.team.TEAM_SLUG: Expands to members of team in the repository owner's org
 * - github.org.ORG_NAME.team.TEAM_SLUG: Expands to members of team in the specified org
 */
export async function syncAuthorizedAdminsToVm(input: VmUserSyncInput): Promise<{
  usersProcessed: number;
  usersCreated: number;
  usersAddedToGroup: number;
  usersRemovedFromGroup: number;
}> {
  if (input.dryRun) {
    console.log("(dry run — no VM user management commands executed)");
    return {
      usersProcessed: 0,
      usersCreated: 0,
      usersAddedToGroup: 0,
      usersRemovedFromGroup: 0
    };
  }

  // Expand smart groups to actual usernames
  const expandedUsers = await expandSmartGroups({
    authorizedAdmins: input.authorizedAdmins,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    githubToken: input.githubToken
  });

  if (expandedUsers.length === 0) {
    return {
      usersProcessed: 0,
      usersCreated: 0,
      usersAddedToGroup: 0,
      usersRemovedFromGroup: 0
    };
  }

  const sshOptions: RemoteCommandOptions = {
    sshUser: input.sshUser,
    sshKeyPath: input.sshKeyPath,
    sshPort: input.sshPort,
    host: input.vmIp
  };

  const groupName = "bot-admin";
  let usersCreated = 0;
  let usersAddedToGroup = 0;
  let usersRemovedFromGroup = 0;

  // Ensure bot-admin group exists
  const groupExists = await checkGroupExists({ ...sshOptions, groupName });
  if (!groupExists) {
    await createGroup({ ...sshOptions, groupName });
  }

  // Process each user
  for (const username of expandedUsers) {
    // Check if user exists
    const userExists = await checkUserExists({ ...sshOptions, username });
    
    if (!userExists) {
      // Create user with random password
      const randomPassword = generateRandomPassword();
      await createUser({ ...sshOptions, username, password: randomPassword });
      usersCreated += 1;
    }

    // Check if user is in bot-admin group
    const inGroup = await checkUserInGroup({ ...sshOptions, username, groupName });
    
    if (!inGroup) {
      // Add user to bot-admin group
      await addUserToGroup({ ...sshOptions, username, groupName });
      usersAddedToGroup += 1;
    }
  }

  // Remove users from bot-admin group who are no longer authorized
  const currentGroupMembers = await getGroupMembers({ ...sshOptions, groupName });
  const expandedUsersSet = new Set(expandedUsers);
  
  for (const currentMember of currentGroupMembers) {
    if (!expandedUsersSet.has(currentMember)) {
      await removeUserFromGroup({ ...sshOptions, username: currentMember, groupName });
      usersRemovedFromGroup += 1;
    }
  }

  return {
    usersProcessed: expandedUsers.length,
    usersCreated,
    usersAddedToGroup,
    usersRemovedFromGroup
  };
}
