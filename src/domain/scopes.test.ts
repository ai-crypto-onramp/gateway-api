import { describe, it, expect } from "vitest";
import { requireScopes, hasAllScopes, RouteScopes, type Scope } from "./scopes.js";

describe("scopes", () => {
  it("hasAllScopes returns true when all granted", () => {
    expect(hasAllScopes(new Set<Scope>(["me:read", "tx:write"]), ["me:read"])).toBe(true);
    expect(hasAllScopes(new Set<Scope>(["me:read"]), ["tx:write"])).toBe(false);
  });
  it("requireScopes registers route requirements", () => {
    requireScopes("GET", "/v1/me", ["me:read"]);
    expect(Object.keys(RouteScopes)).toContain("GET /v1/me");
  });
});