export type Scope =
  | "session:read"
  | "session:write"
  | "me:read"
  | "quotes:write"
  | "tx:read"
  | "tx:write"
  | "kyc:read"
  | "kyc:write"
  | "partner:webhooks"
  | "partner:admin";

export const RouteScopes: Record<string, { method: string; path: string; scopes: Scope[] }[]> = {};

export function requireScopes(method: string, path: string, scopes: Scope[]) {
  const key = `${method.toUpperCase()} ${path}`;
  RouteScopes[key] = RouteScopes[key] ?? [];
  RouteScopes[key].push({ method, path, scopes });
}

export function hasAllScopes(granted: Set<Scope>, required: Scope[]): boolean {
  return required.every((s) => granted.has(s));
}