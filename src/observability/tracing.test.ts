import { describe, it, expect } from "vitest";
import { createTracing } from "./tracing.js";
import { createLogger } from "./logger.js";
import { DEFAULT_TEST_ENV, loadConfig } from "../config.js";

describe("tracing OTLP path", () => {
  it("creates tracing when endpoint set (best-effort shutdown)", async () => {
    const cfg = loadConfig({ ...DEFAULT_TEST_ENV, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:0" });
    const t = createTracing(cfg);
    expect(t.started).toBe(true);
    const span = t.startSpan("test");
    expect(span).toBeDefined();
    const injected = t.inject();
    expect(typeof injected).toBe("object");
    await expect(t.shutdown()).resolves.toBeUndefined();
  });
});

describe("logger pretty", () => {
  it("creates pretty logger in non-production TTY", async () => {
    const original = process.stdout.isTTY;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    try {
      const cfg = loadConfig({ ...DEFAULT_TEST_ENV, NODE_ENV: "development" });
      const log = createLogger(cfg);
      log.info("hi");
      expect(typeof log.info).toBe("function");
    } finally {
      (process.stdout as { isTTY: boolean }).isTTY = original;
    }
  });
});