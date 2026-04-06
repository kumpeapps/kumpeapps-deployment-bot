import { prisma } from "../db.js";
import { appConfig } from "../config.js";
import { getGitHubToken } from "./github-app-auth.js";
import { triggerQueuePoll } from "./deployment-queue.js";

type CreateApprovalInput = {
  repositoryFullName: string;
  assignedUsername: string;
  vmHostname: string;
  environment: "dev" | "stage" | "prod";
  requestedBy: string;
  planName?: string;
  planDetails: {
    ram: string;
    disk: string;
    cores: string;
    ipPool: string;
  };
};

type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export async function createVmApprovalRequest(input: CreateApprovalInput): Promise<number> {
  const [owner, name] = input.repositoryFullName.split('/');
  
  // Find repository
  const repository = await prisma.repository.findUnique({
    where: { owner_name: { owner, name } }
  });
  
  if (!repository) {
    throw new Error(`Repository ${input.repositoryFullName} not found in database`);
  }
  
  // Ensure user exists
  await prisma.user.upsert({
    where: { githubUsername: input.assignedUsername },
    update: {},
    create: { githubUsername: input.assignedUsername }
  });
  
  // Check for existing pending approval for this VM/environment
  const existingApproval = await prisma.vmApprovalRequest.findUnique({
    where: {
      repositoryId_environment: {
        repositoryId: repository.id,
        environment: input.environment
      }
    }
  });
  
  if (existingApproval && existingApproval.status === "pending") {
    console.log(`[VM Approval] Existing pending approval found (issue #${existingApproval.githubIssueNumber})`);
    return existingApproval.githubIssueNumber;
  }
  
  // Create GitHub issue via REST API
  const token = await getGitHubToken(owner, name);
  
  const imageUrl = `${appConfig.APP_PUBLIC_BASE_URL.replace(/\/$/, "")}/images/requesting_authorization.webp`;
  const issueBody = `![Requesting Authorization](${imageUrl})

## VM Approval Request

A new virtual machine is requested for this repository.

**Assigned User:** @${input.assignedUsername}
**Environment:** ${input.environment}
**Hostname:** \`${input.vmHostname}\`
**Requested By:** ${input.requestedBy}${input.planName ? `\n**Plan:** ${input.planName}` : ''}

### VM Specifications
- **RAM:** ${input.planDetails.ram} MB
- **Disk:** ${input.planDetails.disk} GB
- **CPU Cores:** ${input.planDetails.cores}
- **IP Pool:** ${input.planDetails.ipPool}

---

@${input.assignedUsername}, please review this VM request. To approve, comment with:

\`\`\`
/approve
\`\`\`

**Note:** Only you (@${input.assignedUsername}) can approve this request. Bot admins may also override with \`/bot approve admin-override\`. The VM will be created automatically once approved.`;


  const issueResponse = await fetch(`https://api.github.com/repos/${owner}/${name}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: `[VM Approval] ${input.environment} VM for @${input.assignedUsername}`,
      body: issueBody,
      labels: ['vm-approval', 'task'],
      assignees: [input.assignedUsername]
    })
  });
  
  if (!issueResponse.ok) {
    const errorText = await issueResponse.text();
    throw new Error(`Failed to create GitHub issue: ${issueResponse.status} ${errorText}`);
  }
  
  const issue = await issueResponse.json() as { number: number; html_url: string };
  console.log(`[VM Approval] Created issue #${issue.number} for VM ${input.vmHostname}`);
  
  // Store approval request in database
  await prisma.vmApprovalRequest.upsert({
    where: {
      repositoryId_environment: {
        repositoryId: repository.id,
        environment: input.environment
      }
    },
    create: {
      repositoryId: repository.id,
      userId: (await prisma.user.findUnique({ where: { githubUsername: input.assignedUsername } }))!.id,
      vmHostname: input.vmHostname,
      environment: input.environment,
      githubIssueNumber: issue.number,
      status: "pending",
      requestedBy: input.requestedBy,
      metadata: {
        planDetails: input.planDetails,
        issueUrl: issue.html_url,
        createdAt: new Date().toISOString()
      }
    },
    update: {
      status: "pending",
      githubIssueNumber: issue.number,
      requestedBy: input.requestedBy,
      vmHostname: input.vmHostname,
      metadata: {
        planDetails: input.planDetails,
        issueUrl: issue.html_url,
        updatedAt: new Date().toISOString()
      }
    }
  });
  
  return issue.number;
}

export async function processApprovalComment(input: {
  repositoryFullName: string;
  issueNumber: number;
  commentAuthor: string;
  commentBody: string;
}): Promise<{ approved: boolean; message: string }> {
  const [owner, name] = input.repositoryFullName.split('/');
  
  // Find repository
  const repository = await prisma.repository.findUnique({
    where: { owner_name: { owner, name } }
  });
  
  if (!repository) {
    return { approved: false, message: 'Repository not found' };
  }
  
  // Find approval request by issue number
  const approvalRequest = await prisma.vmApprovalRequest.findFirst({
    where: {
      repositoryId: repository.id,
      githubIssueNumber: input.issueNumber,
      status: "pending"
    },
    include: {
      user: true
    }
  });
  
  if (!approvalRequest) {
    return { approved: false, message: 'No pending approval request found for this issue' };
  }
  
  // Check if comment is /approve or /bot approve admin-override
  const command = input.commentBody.trim().toLowerCase();

  // Admin override path
  if (command === '/bot approve admin-override') {
    const adminUsername = appConfig.ADMIN_GITHUB_USERNAME.trim().toLowerCase();
    if (!adminUsername || input.commentAuthor.toLowerCase() !== adminUsername) {
      return {
        approved: false,
        message: `Admin override attempted by @${input.commentAuthor} but they are not the configured bot admin`
      };
    }
    // Fall through to approval below with admin flag
  } else if (command === '/approve') {
    // Verify the comment author is the assigned user
    if (input.commentAuthor !== approvalRequest.user.githubUsername) {
      return { 
        approved: false, 
        message: `Only @${approvalRequest.user.githubUsername} can approve this VM request (comment by @${input.commentAuthor})` 
      };
    }
  } else {
    return { approved: false, message: 'Comment is not an approval command' };
  }

  const isAdminOverride = command === '/bot approve admin-override';
  
  // Update approval status
  await prisma.vmApprovalRequest.update({
    where: { id: approvalRequest.id },
    data: {
      status: "approved",
      approvedBy: input.commentAuthor,
      approvedAt: new Date()
    }
  });
  
  console.log(`[VM Approval] VM ${approvalRequest.vmHostname} approved by ${input.commentAuthor}${isAdminOverride ? ' (admin override)' : ''}`);
  
  // Trigger retry of deployment jobs waiting for this approval
  const updateResult = await prisma.deploymentJob.updateMany({
    where: {
      status: "pending_approval",
      errorMessage: { contains: `issue #${input.issueNumber}` }
    },
    data: {
      status: "queued",
      errorMessage: null,
      attempts: 0 // Reset attempts for fresh start
    }
  });
  console.log(`[VM Approval] Updated ${updateResult.count} pending approval job(s) for issue #${input.issueNumber}`);
  
  // Immediately wake up the queue to process the newly-cleared jobs
  if (updateResult.count > 0) {
    console.log(`[VM Approval] Triggering queue poll to process cleared jobs`);
    await triggerQueuePoll();
    console.log(`[VM Approval] Queue poll completed`);
  } else {
    console.log(`[VM Approval] No pending approval jobs found to retry`);
  }
  
  // Add comment to GitHub issue via REST API
  const token = await getGitHubToken(owner, name);
  
  const commentResponse = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${input.issueNumber}/comments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      body: `✅ **VM Approved${isAdminOverride ? ' (Admin Override)' : ''}**\n\nThe VM \`${approvalRequest.vmHostname}\` has been approved by @${input.commentAuthor}${isAdminOverride ? ' via admin override' : ''}. Deployment will resume automatically.`
    })
  });
  
  if (!commentResponse.ok) {
    console.warn(`Failed to post approval comment: ${commentResponse.status}`);
  }
  
  // Close the issue
  const updateResponse = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${input.issueNumber}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      state: 'closed',
      labels: ['vm-approval', 'task', 'approved']
    })
  });
  
  if (!updateResponse.ok) {
    console.warn(`Failed to close issue: ${updateResponse.status}`);
  }
  
  return { 
    approved: true, 
    message: `VM ${approvalRequest.vmHostname} approved successfully` 
  };
}

export async function checkVmApprovalStatus(input: {
  repositoryFullName: string;
  environment: string;
}): Promise<{ status: ApprovalStatus; issueNumber?: number }> {
  const [owner, name] = input.repositoryFullName.split('/');
  
  const repository = await prisma.repository.findUnique({
    where: { owner_name: { owner, name } }
  });
  
  if (!repository) {
    throw new Error(`Repository ${input.repositoryFullName} not found`);
  }
  
  const approvalRequest = await prisma.vmApprovalRequest.findUnique({
    where: {
      repositoryId_environment: {
        repositoryId: repository.id,
        environment: input.environment
      }
    }
  });
  
  if (!approvalRequest) {
    return { status: "cancelled" }; // No approval request exists
  }
  
  return { 
    status: approvalRequest.status as ApprovalStatus, 
    issueNumber: approvalRequest.githubIssueNumber 
  };
}

export function buildVmHostname(input: {
  assignedUsername: string;
  environment: string;
  customHostname: string;
}): string {
  // Clean inputs
  const cleanUsername = input.assignedUsername.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanEnv = input.environment.toLowerCase();
  let hostname = input.customHostname.toLowerCase().replace(/[^a-z0-9-]/g, '');
  
  // Remove leading/trailing hyphens
  hostname = hostname.replace(/^-+|-+$/g, '');
  
  // Check if hostname already starts with username
  const startsWithUsername = hostname.startsWith(`${cleanUsername}-`);
  
  // Check if hostname contains environment prefix
  const envPrefixes = ['dev-', 'stage-', 'prod-'];
  const hasEnvPrefix = envPrefixes.some(prefix => hostname.includes(prefix));
  
  // Build the hostname intelligently
  if (startsWithUsername && hasEnvPrefix) {
    // Already has both username and env: justinkumpe-dev-sandbox
    return hostname;
  } else if (startsWithUsername && !hasEnvPrefix) {
    // Has username but not env: justinkumpe-sandbox → justinkumpe-dev-sandbox
    const afterUsername = hostname.slice(cleanUsername.length + 1); // +1 for the hyphen
    return `${cleanUsername}-${cleanEnv}-${afterUsername}`;
  } else if (!startsWithUsername && hasEnvPrefix) {
    // Has env but not username: dev-sandbox → justinkumpe-dev-sandbox
    return `${cleanUsername}-${hostname}`;
  } else {
    // Has neither: sandbox → justinkumpe-dev-sandbox
    return `${cleanUsername}-${cleanEnv}-${hostname}`;
  }
}

