import pino, { type Logger } from "pino";
import type { AppConfig } from "../config.js";

export function createLogger(config: AppConfig): Logger {
  const pretty = config.NODE_ENV !== "production" && process.stdout.isTTY;
  return pino(
    {
      level: config.LOG_LEVEL,
      base: { service: config.OTEL_SERVICE_NAME },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-api-key']",
          "res.headers['x-internal-token']",
          "*.accessToken",
          "*.refreshToken",
          "*.token",
          "*.password",
          "*.email",
        ],
        censor: "[REDACTED]",
      },
      ...(pretty
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true },
            },
          }
        : {}),
    },
  );
}