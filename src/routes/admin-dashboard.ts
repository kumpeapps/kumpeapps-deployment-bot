import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { appConfig } from "../config.js";
import {
  clearOauthStateCookieHeader,
  clearSessionCookieHeader,
  createOauthStateCookieHeader,
  createSessionCookieHeader,
  getGithubAdminSessionUsername,
  readOauthStateFromRequest
} from "../services/admin-github-session.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

async function exchangeCodeForAccessToken(code: string): Promise<string | null> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: appConfig.GITHUB_OAUTH_CLIENT_ID,
      client_secret: appConfig.GITHUB_OAUTH_CLIENT_SECRET,
      code
    })
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { access_token?: string };
  return payload.access_token ?? null;
}

async function fetchGithubUsername(accessToken: string): Promise<string | null> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kumpeapps-deployment-bot"
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { login?: string };
  return payload.login ?? null;
}

function loginPageHtml(message?: string): string {
  const escaped = message ? message.replace(/[<>&]/g, "") : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Login - Kumpe Deployment Bot</title>
  <style>
    :root {
      --bg: #060606;
      --panel: #111111;
      --panel-2: #181818;
      --text: #F5F5F5;
      --muted: #B7B7B7;
      --green: #7EDB28;
      --green-2: #9df14a;
      --border: #262626;
      --radius-md: 22px;
      --radius-sm: 14px;
      --shadow: 0 18px 40px rgba(0, 0, 0, .32);
      --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
    }
    .login-container {
      width: 100%;
      max-width: 480px;
    }
    .logo-section {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo {
      width: 160px;
      height: 160px;
      filter: drop-shadow(0 0 24px rgba(126, 219, 40, .18));
      margin-bottom: 20px;
    }
    .logo-text {
      color: var(--green);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .card {
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 40px 32px;
      box-shadow: var(--shadow);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    p {
      margin: 0 0 28px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.6;
    }
    .btn {
      display: block;
      width: 100%;
      text-decoration: none;
      background: var(--green);
      color: #000;
      padding: 16px 24px;
      border-radius: var(--radius-sm);
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 0.02em;
      text-align: center;
      transition: all 0.2s;
      border: none;
      cursor: pointer;
    }
    .btn:hover {
      background: var(--green-2);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(126, 219, 40, 0.3);
    }
    .msg {
      margin-top: 20px;
      padding: 14px 18px;
      background: rgba(220, 38, 38, 0.1);
      border: 1px solid #dc2626;
      border-radius: var(--radius-sm);
      color: #fca5a5;
      font-size: 14px;
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      color: var(--muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="logo-section">
      <img src="/logo.webp" alt="Kumpe Apps" class="logo">
      <div class="logo-text">Admin Dashboard</div>
    </div>
    <main class="card">
      <h1>Sign In</h1>
      <p>Authenticate with GitHub to access the deployment admin dashboard.</p>
      <a class="btn" href="/admin/auth/github">Sign in with GitHub</a>
      ${escaped ? `<div class="msg">${escaped}</div>` : ""}
    </main>
    <div class="footer">
      KumpeApps Deployment Bot
    </div>
  </div>
</body>
</html>`;
}

export async function registerAdminDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/login", async (_request, reply) => {
    if (!appConfig.ADMIN_GITHUB_USERNAME.trim()) {
      return reply
        .code(500)
        .type("text/html")
        .send(loginPageHtml("ADMIN_GITHUB_USERNAME is not configured."));
    }

    if (!appConfig.GITHUB_OAUTH_CLIENT_ID.trim() || !appConfig.GITHUB_OAUTH_CLIENT_SECRET.trim()) {
      return reply
        .code(500)
        .type("text/html")
        .send(loginPageHtml("GitHub OAuth is not configured."));
    }

    return reply.type("text/html").send(loginPageHtml());
  });

  app.get("/admin/auth/github", async (_request, reply) => {
    if (!appConfig.GITHUB_OAUTH_CLIENT_ID.trim() || !appConfig.GITHUB_OAUTH_CLIENT_SECRET.trim()) {
      return reply.code(500).send({ error: "GitHub OAuth is not configured" });
    }

    const state = randomBytes(24).toString("hex");
    const redirectUri = `${appConfig.APP_PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/auth/github/callback`;
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", appConfig.GITHUB_OAUTH_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "read:user");
    authorizeUrl.searchParams.set("state", state);

    reply.header("set-cookie", createOauthStateCookieHeader(state));
    return reply.redirect(authorizeUrl.toString());
  });

  app.get("/admin/auth/github/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const expectedState = readOauthStateFromRequest(request);
    if (!query.code || !query.state || !expectedState || query.state !== expectedState) {
      reply.header("set-cookie", clearOauthStateCookieHeader());
      return reply.code(400).type("text/html").send(loginPageHtml("OAuth state validation failed."));
    }

    const accessToken = await exchangeCodeForAccessToken(query.code);
    if (!accessToken) {
      reply.header("set-cookie", clearOauthStateCookieHeader());
      return reply.code(401).type("text/html").send(loginPageHtml("Failed to exchange GitHub OAuth code."));
    }

    const githubUsername = await fetchGithubUsername(accessToken);
    const adminUsername = appConfig.ADMIN_GITHUB_USERNAME.trim().toLowerCase();
    if (!githubUsername || githubUsername.toLowerCase() !== adminUsername) {
      reply.header("set-cookie", clearOauthStateCookieHeader());
      return reply.code(403).type("text/html").send(loginPageHtml("GitHub account is not authorized for admin access."));
    }

    reply.headers({
      "set-cookie": [
        clearOauthStateCookieHeader(),
        createSessionCookieHeader(githubUsername)
      ]
    });
    return reply.redirect("/admin");
  });

  app.post("/admin/logout", async (_request, reply) => {
    reply.header("set-cookie", clearSessionCookieHeader());
    return reply.send({ loggedOut: true });
  });

  app.get("/admin/session", async (request, reply) => {
    const username = getGithubAdminSessionUsername(request);
    if (!username) {
      return reply.code(401).send({ authenticated: false });
    }
    return reply.send({ authenticated: true, username });
  });

  // Serve admin dashboard HTML
  app.get("/admin", async (request, reply) => {
    if (!getGithubAdminSessionUsername(request)) {
      return reply.redirect("/admin/login");
    }

    try {
      const htmlPath = join(currentDir, "..", "..", "public", "admin", "index.html");
      const html = await readFile(htmlPath, "utf-8");
      return reply.type("text/html").send(html);
    } catch (error) {
      return reply.code(404).send({ error: "Admin dashboard not found" });
    }
  });

  // Redirect /admin/ to /admin
  app.get("/admin/", async (request, reply) => {
    return reply.redirect("/admin");
  });

  // Serve logo for admin dashboard
  app.get("/logo.webp", async (_request, reply) => {
    try {
      const logoPath = join(currentDir, "..", "..", "public", "logo.webp");
      const logo = await readFile(logoPath);
      return reply.type("image/webp").send(logo);
    } catch (error) {
      return reply.code(404).send({ error: "Logo not found" });
    }
  });
}
