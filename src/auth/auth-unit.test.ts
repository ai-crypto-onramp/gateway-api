import { describe, it, expect } from "vitest";
import { createInternalTokenIssuer, parseScopes, createJwtVerifier } from "./index.js";
import { DEFAULT_TEST_ENV, loadConfig } from "../config.js";

describe("internal token issuer", () => {
  it("issues a JWT", async () => {
    const issuer = createInternalTokenIssuer("secret");
    const token = await issuer.issue({ sub: "api-gateway" });
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(3);
  });
});

describe("parseScopes", () => {
  it("parses space-separated scopes", () => {
    const s = parseScopes("me:read tx:write");
    expect(s.has("me:read")).toBe(true);
    expect(s.has("tx:write")).toBe(true);
    expect(s.size).toBe(2);
  });
  it("returns empty set for undefined", () => {
    expect(parseScopes(undefined).size).toBe(0);
  });
});

describe("createJwtVerifier", () => {
  it("creates a verifier with refreshCount", () => {
    const cfg = loadConfig(DEFAULT_TEST_ENV);
    const v = createJwtVerifier(cfg);
    expect(v.refreshCount()).toBe(0);
  });
});