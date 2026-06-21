import { PrismaClient } from "@prisma/client";
import { appConfig } from "./config.js";

function databaseUrlWithPoolLimit(databaseUrl: string, connectionLimit: number): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", String(connectionLimit));
  url.searchParams.set("pool_timeout", "20");
  return url.toString();
}

function defaultConnectionLimitForRole(): number {
  switch (appConfig.BOT_PROCESS_ROLE) {
    case "web":
      return Math.min(appConfig.DATABASE_CONNECTION_LIMIT, 8);
    case "worker":
      return Math.min(appConfig.DATABASE_CONNECTION_LIMIT, 8);
    default:
      return appConfig.DATABASE_CONNECTION_LIMIT;
  }
}

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrlWithPoolLimit(
        appConfig.DATABASE_URL,
        defaultConnectionLimitForRole()
      )
    }
  }
});
