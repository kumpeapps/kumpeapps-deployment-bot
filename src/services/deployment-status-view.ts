/**
 * Deployment status view helpers
 * 
 * Provides functions for rendering the public deployment status page,
 * including log filtering, status badge computation, and HTML generation.
 */

type DeploymentStatus = "success" | "failed" | "running" | "queued";

type Deployment = {
  id: number;
  status: string;
  environment: string;
  commitSha: string;
  startedAt: Date;
  finishedAt: Date | null;
  repository: {
    owner: string;
    name: string;
  };
  steps: Array<{
    stepName: string;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    logExcerpt: string | null;
  }>;
};

type StatusBadge = {
  emoji: string;
  color: string;
  label: string;
};

/**
 * HTML-escape a string to prevent XSS attacks
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Filter out command-line prompts and Docker build noise from log excerpts
 */
export function filterStepLogExcerpt(logExcerpt: string | null | undefined): string {
  if (!logExcerpt) return "";

  return logExcerpt
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();

      // Remove lines that look like shell prompts or commands
      if (
        trimmed.startsWith("$") ||
        trimmed.startsWith(">") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("+") ||
        trimmed.match(/^[\w-]+@[\w-]+:/) ||      // user@host:
        trimmed.match(/^[\w-]+:\/$/)             // prompt ending patterns
      ) return false;

      // Remove Docker buildx output noise
      if (
        trimmed.match(/^#\d+/) ||                // #9, #10 etc
        trimmed === "------" ||
        trimmed === "--------------------" ||
        trimmed.startsWith(">>>") ||
        trimmed.match(/^\[\w+-\w+\s+\d+\/\d+\]/) || // [stage-1 4/12]
        trimmed.startsWith("Dockerfile:") ||
        trimmed.match(/^> \[.*\]:$/)            // > [stage-1 4/12] RUN...:
      ) return false;

      // Remove npm notice lines
      if (
        trimmed.startsWith("npm notice") ||
        trimmed.startsWith("npm warn cleanup")
      ) return false;

      // Keep important error/warning lines
      return trimmed.length > 0;
    })
    .join("\n")
    .trim();
}

/**
 * Calculate storyboard image step and status badge for a deployment
 */
export function buildDeploymentStatusView(deployment: Deployment): {
  storyboardImage: string;
  status: StatusBadge;
} {
  const totalSteps = deployment.steps.length;
  const completedSteps = deployment.steps.filter(s => s.status === "success").length;

  let storyboardStep = 1;
  if (deployment.status === "success" || deployment.status === "failed") {
    storyboardStep = 7;
  } else if (totalSteps > 0) {
    const progressPercent = completedSteps / totalSteps;
    storyboardStep = Math.min(6, Math.floor(progressPercent * 6) + 1);
  }

  const storyboardImage = `/images/deployment_storyboards_fixed/deployment_storyboard_step_${storyboardStep}_fixed.png`;

  const statusConfig: Record<DeploymentStatus, StatusBadge> = {
    success: { emoji: "✅", color: "#7EDB28", label: "SUCCESS" },
    failed: { emoji: "❌", color: "#ff6b6b", label: "FAILED" },
    running: { emoji: "⏳", color: "#dbab09", label: "IN PROGRESS" },
    queued: { emoji: "⏸️", color: "#B7B7B7", label: "QUEUED" }
  };

  const status = statusConfig[deployment.status as DeploymentStatus] ?? statusConfig.queued;

  return { storyboardImage, status };
}

/**
 * Build HTML for deployment steps
 */
export function buildStepsHtml(steps: Deployment["steps"]): string {
  const stepStatusConfig = {
    success: { emoji: "✅", color: "#7EDB28" },
    failed: { emoji: "❌", color: "#ff6b6b" },
    running: { emoji: "⏳", color: "#dbab09" },
    queued: { emoji: "⏸️", color: "#666" }
  };

  return steps.map((step, index) => {
    const stepStatus = stepStatusConfig[step.status as keyof typeof stepStatusConfig] ?? stepStatusConfig.queued;

    const duration =
      step.finishedAt && step.startedAt
        ? `${Math.round((step.finishedAt.getTime() - step.startedAt.getTime()) / 1000)}s`
        : "...";

    const filteredLogs = filterStepLogExcerpt(step.logExcerpt);
    const escapedLogs = escapeHtml(filteredLogs);
    
    const logs = escapedLogs
      ? `
        <div class="logs-container">
          <div class="logs-header">Output</div>
          <pre class="logs">${escapedLogs}</pre>
        </div>
      `
      : "";

    return `
      <div class="step">
        <div class="step-header">
          <span class="step-number">${index + 1}</span>
          <span class="step-status" style="color: ${stepStatus.color}">${stepStatus.emoji}</span>
          <strong>${escapeHtml(step.stepName)}</strong>
          <span class="step-duration">${duration}</span>
        </div>
        ${logs}
      </div>
    `;
  }).join("");
}

/**
 * Build the complete deployment status HTML page
 */
export function buildDeploymentStatusHtml(params: {
  deployment: Deployment;
  storyboardImage: string;
  status: StatusBadge;
  stepsHtml: string;
}): string {
  const { deployment, storyboardImage, status, stepsHtml } = params;

  // Meta refresh tag only for running deployments
  const metaRefresh = deployment.status === "running"
    ? '<meta http-equiv="refresh" content="5">'
    : "";

  return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Deployment #${deployment.id} - ${escapeHtml(deployment.repository.owner)}/${escapeHtml(deployment.repository.name)}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        ${metaRefresh}
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg: #060606;
            --panel: #111111;
            --panel-2: #181818;
            --text: #F5F5F5;
            --muted: #B7B7B7;
            --green: #7EDB28;
            --border: #262626;
            --radius: 22px;
            --shadow: 0 18px 40px rgba(0,0,0,.32);
          }
          * { box-sizing: border-box; }
          body { 
            margin: 0;
            font-family: Inter, ui-sans-serif, system-ui, sans-serif; 
            background: var(--bg);
            color: var(--text);
            padding: 20px;
          }
          .container { 
            max-width: 1100px; 
            margin: 0 auto;
          }
          .panel {
            background: linear-gradient(180deg, var(--panel), var(--panel-2));
            border: 1px solid var(--border);
            border-radius: var(--radius);
            box-shadow: var(--shadow);
            padding: 32px;
            margin-bottom: 20px;
          }
          .hero {
            padding: 0;
          }
          .hero-content {
            padding: 32px;
          }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 14px;
            font-weight: 700;
            font-size: 14px;
            letter-spacing: 0.02em;
            background: ${status.color};
            color: #000;
          }
          .kicker {
            color: var(--green);
            text-transform: uppercase;
            letter-spacing: 0.14em;
            font-size: 11px;
            font-weight: 700;
            margin-bottom: 8px;
          }
          h1 {
            font-size: 32px;
            font-weight: 800;
            line-height: 1.1;
            margin: 0 0 12px;
            letter-spacing: -0.02em;
          }
          .meta {
            color: var(--muted);
            font-size: 14px;
            line-height: 1.6;
          }
          .meta code {
            background: #1a1a1a;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: "JetBrains Mono", ui-monospace, monospace;
            font-size: 13px;
          }
          .storyboard {
            width: 100%;
            padding: 32px;
            background: #0a0a0a;
            border-top: 1px solid var(--border);
            display: flex;
            justify-content: center;
            align-items: center;
          }
          .storyboard img {
            width: 100%;
            max-width: 100%;
            height: auto;
            border-radius: 12px;
            filter: drop-shadow(0 0 20px rgba(126, 219, 40, 0.15));
          }
          .section-title {
            color: var(--green);
            font-size: 18px;
            font-weight: 700;
            margin: 0 0 20px;
            text-transform: uppercase;
            letter-spacing: 0.02em;
          }
          .step {
            border-bottom: 1px solid var(--border);
            padding: 20px 0;
          }
          .step:last-child {
            border-bottom: none;
          }
          .step-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 8px;
          }
          .step-number {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            background: #1a1a1a;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 700;
            color: var(--muted);
          }
          .step-status {
            font-size: 20px;
          }
          .step-duration {
            margin-left: auto;
            color: var(--muted);
            font-size: 13px;
            font-family: "JetBrains Mono", ui-monospace, monospace;
          }
          .logs-container {
            margin-top: 12px;
          }
          .logs-header {
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 6px;
          }
          .logs {
            background: #0a0a0a;
            color: #dcdcdc;
            padding: 16px;
            border-radius: 12px;
            overflow-x: auto;
            font-size: 13px;
            font-family: "JetBrains Mono", ui-monospace, Consolas, monospace;
            margin: 0;
            border: 1px solid #1a1a1a;
            line-height: 1.5;
          }
          .refresh-notice {
            text-align: center;
            color: var(--muted);
            font-size: 13px;
            margin-top: 20px;
            padding: 12px;
            background: var(--panel);
            border-radius: 12px;
            border: 1px solid var(--border);
          }
          @media (max-width: 900px) {
            .panel { padding: 24px; }
            .hero-content { padding: 24px; }
            h1 { font-size: 26px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="panel hero">
            <div class="hero-content">
              <div class="kicker">Deployment Status</div>
              <h1>${escapeHtml(deployment.repository.owner)}/${escapeHtml(deployment.repository.name)}</h1>
              <div style="margin: 16px 0">
                <span class="status-badge">${status.emoji} ${status.label}</span>
              </div>
              <div class="meta">
                <strong>Environment:</strong> ${escapeHtml(deployment.environment)}<br>
                <strong>Deployment:</strong> #${deployment.id}<br>
                <strong>Commit:</strong> <code>${escapeHtml(deployment.commitSha.substring(0, 7))}</code><br>
                <strong>Started:</strong> ${deployment.startedAt.toLocaleString()}<br>
                ${deployment.finishedAt ? `<strong>Finished:</strong> ${deployment.finishedAt.toLocaleString()}` : ''}
              </div>
            </div>
            <div class="storyboard">
              <img src="${storyboardImage}" alt="Deployment progress" />
            </div>
          </div>
          
          <div class="panel">
            <div class="section-title">Deployment Steps</div>
            ${stepsHtml || '<p style="color: var(--muted)">No steps recorded yet...</p>'}
          </div>
          
          ${deployment.status === 'running' ? '<div class="refresh-notice">⏳ Deployment in progress • Page refreshes automatically every 5 seconds</div>' : ''}
        </div>
      </body>
      </html>
    `;
}

/**
 * Build 404 Not Found HTML page
 */
export function buildNotFoundHtml(deploymentId: number): string {
  return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Deployment Not Found</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { 
              font-family: Inter, ui-sans-serif, system-ui, sans-serif; 
              background: #060606; 
              color: #F5F5F5; 
              max-width: 800px; 
              margin: 50px auto; 
              padding: 20px; 
            }
            .error { color: #ff6b6b; }
          </style>
        </head>
        <body>
          <h1 class="error">Deployment Not Found</h1>
          <p style="color: #B7B7B7">Deployment ID ${deploymentId} does not exist.</p>
        </body>
        </html>
      `;
}
