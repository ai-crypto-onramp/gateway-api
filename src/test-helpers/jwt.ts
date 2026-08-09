import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JwtVerifier } from "../auth/index.js";
import type { Scope } from "../domain/scopes.js";

export async function makeTestJwtVerifier(scopes: Scope[] = ["me:read", "tx:read", "tx:write", "quotes:write", "kyc:read", "kyc:write"]): Promise<{ verifier: JwtVerifier; token: string; userId: string }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  jwk.kid = "test-kid";
  const userId = "user-test-1";
  const token = await new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid", typ: "JWT" })
    .setIssuer("https://auth.example.com")
    .setAudience("onramp-sdk")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  const jwks = { keys: [jwk] };
  const verifier: JwtVerifier = {
    async verify(t) {
      const { jwtVerify, createLocalJWKSet } = await import("jose");
      const { payload } = await jwtVerify(t, createLocalJWKSet(jwks), {
        issuer: "https://auth.example.com",
        audience: "onramp-sdk",
      });
      return payload as never;
    },
    refreshCount() {
      return 0;
    },
  };
  return { verifier, token, userId };
}

export async function makeExpiredTokenVerifier(): Promise<{ verifier: JwtVerifier; token: string }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  jwk.kid = "test-kid";
  const token = await new SignJWT({ scope: "me:read" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer("https://auth.example.com")
    .setAudience("onramp-sdk")
    .setSubject("expired-user")
    .setIssuedAt(Date.now() / 1000 - 3600)
    .setExpirationTime(Date.now() / 1000 - 60)
    .sign(privateKey);
  const jwks = { keys: [jwk] };
  const verifier: JwtVerifier = {
    async verify(t) {
      const { jwtVerify, createLocalJWKSet } = await import("jose");
      await jwtVerify(t, createLocalJWKSet(jwks), {
        issuer: "https://auth.example.com",
        audience: "onramp-sdk",
      });
      return {} as never;
    },
    refreshCount() {
      return 0;
    },
  };
  return { verifier, token };
}