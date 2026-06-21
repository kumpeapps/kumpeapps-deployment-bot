import { appConfig } from "../config.js";

export function shouldRunWebServer(): boolean {
  return appConfig.BOT_PROCESS_ROLE === "all" || appConfig.BOT_PROCESS_ROLE === "web";
}

export function shouldRunBackgroundWorkers(): boolean {
  return appConfig.BOT_PROCESS_ROLE === "all" || appConfig.BOT_PROCESS_ROLE === "worker";
}
