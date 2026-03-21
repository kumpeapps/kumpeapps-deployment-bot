import type { FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appConfig } from "../config.js";

const SESSION_COOKIE = "admin_session";
const OAUTH_STATE_COOKIE = "admin_oauth_state";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function parseCookies(request: FastifyRequest): Record<string, string> {
  const raw = request.headers.cookie;
  if (!raw) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) {
      continue;
    }
    out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function sessionSecret(): string {
  const candidate = appConfig.ADMIN_SESSION_SECRET.trim();
  if (candidate.length >= 16) {
    return candidate;
  }
  return appConfig.SECRET_ENCRYPTION_KEY;
}

function signPayload(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload, "utf8").digest("hex");
}

export function createAdminSessionToken(username: string, nowMs = Date.now()): string {
  const normalized = username.trim().toLowerCase();
  const expiresAt = nowMs + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `${normalized}:${expiresAt}`;
  const signature = signPayload(payload);
  return `${payload}:${signature}`;
}

export function verifyAdminSessionToken(token: string, nowMs = Date.now()): { username: string } | null {
  const parts = token.split(":");
  if (parts.length !== 3) {
    return null;
  }

  const [username, expiresRaw, providedSignature] = parts;
  const expiresAt = Number(expiresRaw);
  if (!username || !Number.isFinite(expiresAt)) {
    return null;
  }

  if (nowMs > expiresAt) {
    return null;
  }

  const payload = `${username}:${expiresAt}`;
  const expectedSignature = signPayload(payload);

  const provided = Buffer.from(providedSignature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");
  if (provided.length !== expected.length) {
    return null;
  }

  if (!timingSafeEqual(provided, expected)) {
    return null;
  }

  return { username };
}

export function getGithubAdminSessionUsername(request: FastifyRequest): string | null {
  const adminUsername = appConfig.ADMIN_GITHUB_USERNAME.trim().toLowerCase();
  if (!adminUsername) {
    return null;
  }

  const cookies = parseCookies(request);
  const sessionToken = cookies[SESSION_COOKIE];
  if (!sessionToken) {
    return null;
  }

  const parsed = verifyAdminSessionToken(sessionToken);
  if (!parsed) {
    return null;
  }

  if (parsed.username.toLowerCase() !== adminUsername) {
    return null;
  }

  return parsed.username;
}

export function createSessionCookieHeader(username: string): string {
  const token = createAdminSessionToken(username);
  const secure = appConfig.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

export function clearSessionCookieHeader(): string {
  const secure = appConfig.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function createOauthStateCookieHeader(state: string): string {
  const secure = appConfig.NODE_ENV === "production" ? "; Secure" : "";
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
}

export function clearOauthStateCookieHeader(): string {
  const secure = appConfig.NODE_ENV === "production" ? "; Secure" : "";
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function readOauthStateFromRequest(request: FastifyRequest): string | null {
  const cookies = parseCookies(request);
  return cookies[OAUTH_STATE_COOKIE] ?? null;
}
