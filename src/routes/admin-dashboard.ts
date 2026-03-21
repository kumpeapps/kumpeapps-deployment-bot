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
  <title>Admin Login</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; }
    .card { width: min(420px, 92vw); background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 1.4rem; }
    p { margin: 0 0 16px; color: #94a3b8; }
    a.btn { display: inline-block; text-decoration: none; background: #2563eb; color: white; padding: 10px 14px; border-radius: 8px; font-weight: 600; }
    .msg { margin-top: 12px; color: #fca5a5; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Admin Sign In</h1>
    <p>Use GitHub login to access the deployment admin dashboard.</p>
    <a class="btn" href="/admin/auth/github">Sign in with GitHub</a>
    ${escaped ? `<div class="msg">${escaped}</div>` : ""}
  </main>
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
}
