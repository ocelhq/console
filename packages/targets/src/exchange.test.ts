import { describe, expect, it } from "vitest";
import { exchangeToken } from "./exchange";

type Call = { url: string; init: RequestInit };

function fetcher(...answers: Response[]) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers.shift();
    if (!answer) throw new Error("no more answers");
    return answer;
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const aws = {
  vendor: "aws" as const,
  identity: {
    identityProvider: "arn:aws:iam::123456789012:oidc-provider/console.example.com/oidc",
    principal: "arn:aws:iam::123456789012:role/ocel-deploy-production",
  },
  token: "header.payload.signature",
  sessionName: "ocel-0f8fad5b-d9c",
};

const gcp = {
  vendor: "gcp" as const,
  identity: {
    identityProvider:
      "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/ocel/providers/console",
    principal: "ocel-deploy@shop-prod-4821.iam.gserviceaccount.com",
  },
  token: "header.payload.signature",
  sessionName: "ocel-0f8fad5b-d9c",
};

describe("exchanging a tier token on AWS", () => {
  it("assumes the role with the token, unsigned, and reports the session it got", async () => {
    const { calls, fetch } = fetcher(
      new Response(
        `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/ocel-deploy-production/ocel-0f8fad5b-d9c</Arn></AssumedRoleUser><Credentials><SecretAccessKey>secret</SecretAccessKey></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
      ),
    );

    const result = await exchangeToken(aws, fetch);

    expect(result).toEqual({
      ok: true,
      detail:
        "assumed arn:aws:sts::123456789012:assumed-role/ocel-deploy-production/ocel-0f8fad5b-d9c",
    });
    expect(calls[0]?.url).toBe("https://sts.amazonaws.com/");
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(Object.fromEntries(body)).toMatchObject({
      Action: "AssumeRoleWithWebIdentity",
      RoleArn: aws.identity.principal,
      RoleSessionName: aws.sessionName,
      WebIdentityToken: aws.token,
    });
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
  });

  it("reports STS's refusal", async () => {
    const { fetch } = fetcher(
      new Response(
        "<ErrorResponse><Error><Code>InvalidIdentityToken</Code><Message>No OpenIDConnect provider found in your account for https://console.example.com/oidc</Message></Error></ErrorResponse>",
        { status: 400 },
      ),
    );

    expect(await exchangeToken(aws, fetch)).toEqual({
      ok: false,
      error:
        "AWS STS refused the token: InvalidIdentityToken: No OpenIDConnect provider found in your account for https://console.example.com/oidc",
    });
  });
});

describe("exchanging a tier token on GCP", () => {
  it("trades it at STS, then impersonates the service account with what STS gave", async () => {
    const { calls, fetch } = fetcher(
      Response.json({ access_token: "federated", token_type: "Bearer" }),
      Response.json({ accessToken: "sa-token", expireTime: "2026-10-27T00:10:00Z" }),
    );

    const result = await exchangeToken(gcp, fetch);

    expect(result).toEqual({
      ok: true,
      detail: "impersonated ocel-deploy@shop-prod-4821.iam.gserviceaccount.com",
    });
    expect(calls[0]?.url).toBe("https://sts.googleapis.com/v1/token");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      audience: gcp.identity.identityProvider,
      subjectToken: gcp.token,
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    });
    expect(calls[1]?.url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/ocel-deploy%40shop-prod-4821.iam.gserviceaccount.com:generateAccessToken",
    );
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer federated");
  });

  it("reports STS's refusal", async () => {
    const { fetch } = fetcher(
      Response.json(
        { error: "invalid_grant", error_description: "The audience in ID Token does not match" },
        { status: 400 },
      ),
    );

    expect(await exchangeToken(gcp, fetch)).toEqual({
      ok: false,
      error: "Google STS refused the token: invalid_grant: The audience in ID Token does not match",
    });
  });

  it("reports a refused impersonation", async () => {
    const { fetch } = fetcher(
      Response.json({ access_token: "federated" }),
      Response.json(
        { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied" } },
        { status: 403 },
      ),
    );

    expect(await exchangeToken(gcp, fetch)).toEqual({
      ok: false,
      error:
        "Google refused to impersonate ocel-deploy@shop-prod-4821.iam.gserviceaccount.com: PERMISSION_DENIED: Permission denied",
    });
  });
});

const vps = {
  vendor: "vps" as const,
  identity: { identityProvider: "https://box.example.com", principal: "" },
  token: "header.payload.signature",
  sessionName: "ocel-0f8fad5b-d9c",
};

describe("exchanging a tier token on a VPS box", () => {
  it("asks the box's endpoint for an SSH certificate with the token, and reports its principal", async () => {
    const { calls, fetch } = fetcher(
      Response.json({
        certificate: "ssh-ed25519-cert-v01@openssh.com AAAA",
        principal: "ocel-deploy",
      }),
    );

    const result = await exchangeToken(vps, fetch);

    expect(result).toEqual({ ok: true, detail: "got a certificate for ocel-deploy" });
    expect(calls[0]?.url).toBe(
      "https://box.example.com/endpoint.v1.SshCertificateService/IssueUserCertificate",
    );
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${vps.token}`);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/);
  });

  it("follows no redirect, so the token reaches only the box the account names", async () => {
    const { calls, fetch } = fetcher(Response.json({ certificate: "c", principal: "p" }));

    await exchangeToken(vps, fetch);

    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("reports the box's refusal", async () => {
    const { fetch } = fetcher(
      Response.json(
        { code: "permission_denied", message: "the credential is for another target" },
        { status: 403 },
      ),
    );

    expect(await exchangeToken(vps, fetch)).toEqual({
      ok: false,
      error: "The box refused the token: permission_denied: the credential is for another target",
    });
  });
});
