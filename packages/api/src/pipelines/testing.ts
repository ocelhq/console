import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

export const AUDIENCE = "http://localhost:3000";
export const ISSUER = "https://token.actions.githubusercontent.com";

export async function githubActions() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const keys = { keys: [jwk] };

  function claims(over: JWTPayload = {}): JWTPayload {
    return {
      jti: crypto.randomUUID(),
      repository: "acme/web",
      repository_id: "1234",
      repository_owner: "acme",
      repository_owner_id: "42",
      job_workflow_ref: "acme/web/.github/workflows/preview.yml@refs/pull/7/merge",
      event_name: "pull_request",
      ref: "refs/pull/7/merge",
      head_ref: "feat/x",
      base_ref: "main",
      actor: "octocat",
      run_id: "9001",
      run_attempt: "2",
      ...over,
    };
  }

  async function sign(over: JWTPayload = {}, options: { audience?: string; issuer?: string } = {}) {
    return new SignJWT(claims(over))
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  const push = (branch: string, over: JWTPayload = {}) =>
    sign({
      event_name: "push",
      ref: `refs/heads/${branch}`,
      head_ref: "",
      job_workflow_ref: `acme/web/.github/workflows/deploy.yml@refs/heads/${branch}`,
      ...over,
    });

  return { keys, sign, push, privateKey };
}
