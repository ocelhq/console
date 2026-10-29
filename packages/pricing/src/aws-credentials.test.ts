import { GetProductsCommand } from "@aws-sdk/client-pricing";
import { STSClient } from "@aws-sdk/client-sts";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_ID_TOKEN_URL,
  type IdentityHost,
  type PricingIdentity,
  pricingCredentials,
  ROLE_SESSION_NAME,
} from "./aws-credentials";
import { pricingClient } from "./aws-price-list";
import type { Fetch } from "./http";

const ROLE = "arn:aws:iam::210987654321:role/console-pricing";
const KEY = { accessKeyId: "AKIDVPSUSER", secretAccessKey: "vps-secret" };
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.google-signed.token";

type Sent = { headers: Record<string, string>; form: URLSearchParams };

function stsEndpoint(action: "AssumeRole" | "AssumeRoleWithWebIdentity") {
  const sent: Sent[] = [];
  const sts = (config: ConstructorParameters<typeof STSClient>[0] = {}) =>
    new STSClient({
      ...config,
      requestHandler: {
        handle: async (request: { headers: Record<string, string>; body?: unknown }) => {
          sent.push({ headers: request.headers, form: new URLSearchParams(String(request.body)) });
          const body = `<${action}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${action}Result><Credentials><AccessKeyId>ASIAASSUMED</AccessKeyId><SecretAccessKey>assumed-secret</SecretAccessKey><SessionToken>assumed-session</SessionToken><Expiration>2026-10-29T13:00:00Z</Expiration></Credentials></${action}Result><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></${action}Response>`;
          return {
            response: {
              statusCode: 200,
              headers: { "content-type": "text/xml" },
              body: new TextEncoder().encode(body),
            },
          };
        },
      },
    });
  return { sts, sent };
}

function metadataServer(answer: () => Response) {
  const asked: { url: string; headers: Headers }[] = [];
  const fetcher: Fetch = async (url, init) => {
    asked.push({ url, headers: new Headers(init?.headers) });
    return answer();
  };
  return { fetch: fetcher, asked };
}

const identity = (over: Partial<PricingIdentity> = {}): PricingIdentity => ({
  identity: "auto",
  audience: "sts.amazonaws.com",
  ...over,
});

function host(over: Partial<IdentityHost>): IdentityHost {
  return {
    fetch: async () => {
      throw new Error("no metadata server on this host");
    },
    sts: () => {
      throw new Error("STS was not expected");
    },
    onCloudRun: false,
    ...over,
  };
}

describe("pricingCredentials", () => {
  it("leaves the default AWS credential chain to the SDK when no role and no key are set", () => {
    expect(pricingCredentials(identity(), host({}))).toBeUndefined();
  });

  it("calls the API with an IAM user's key when no role is set", async () => {
    const provider = pricingCredentials(identity({ accessKey: KEY }), host({}));
    expect(await provider?.()).toEqual(KEY);
  });

  it("trades a Google ID token for the role on Cloud Run, unsigned", async () => {
    const metadata = metadataServer(() => new Response(`${ID_TOKEN}\n`));
    const sts = stsEndpoint("AssumeRoleWithWebIdentity");
    const provider = pricingCredentials(
      identity({ roleArn: ROLE, audience: "sts.amazonaws.com" }),
      host({ fetch: metadata.fetch, sts: sts.sts, onCloudRun: true }),
    );
    expect(await provider?.()).toEqual({
      accessKeyId: "ASIAASSUMED",
      secretAccessKey: "assumed-secret",
      sessionToken: "assumed-session",
      expiration: new Date("2026-10-29T13:00:00Z"),
    });
    expect(metadata.asked).toHaveLength(1);
    expect(metadata.asked[0]?.url).toBe(`${GOOGLE_ID_TOKEN_URL}?audience=sts.amazonaws.com`);
    expect(metadata.asked[0]?.headers.get("metadata-flavor")).toBe("Google");
    const [call] = sts.sent;
    expect(call?.form.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(call?.form.get("RoleArn")).toBe(ROLE);
    expect(call?.form.get("RoleSessionName")).toBe(ROLE_SESSION_NAME);
    expect(call?.form.get("WebIdentityToken")).toBe(ID_TOKEN);
    expect(call?.headers.authorization).toBeUndefined();
  });

  it("asks the metadata server for the configured audience when google is named off Cloud Run", async () => {
    const metadata = metadataServer(() => new Response(ID_TOKEN));
    const sts = stsEndpoint("AssumeRoleWithWebIdentity");
    await pricingCredentials(
      identity({ roleArn: ROLE, identity: "google", audience: "console-pricing" }),
      host({ fetch: metadata.fetch, sts: sts.sts }),
    )?.();
    expect(metadata.asked[0]?.url).toBe(`${GOOGLE_ID_TOKEN_URL}?audience=console-pricing`);
  });

  it("fails with the metadata server's answer when it gives no ID token", async () => {
    const metadata = metadataServer(() => new Response("forbidden", { status: 403 }));
    const provider = pricingCredentials(
      identity({ roleArn: ROLE, identity: "google" }),
      host({ fetch: metadata.fetch, sts: stsEndpoint("AssumeRoleWithWebIdentity").sts }),
    );
    await expect(provider?.()).rejects.toThrow(
      "the GCP metadata server answered 403 for an ID token",
    );
  });

  it("assumes the role with an IAM user's key off Cloud Run, signed by that key", async () => {
    const sts = stsEndpoint("AssumeRole");
    const metadata = metadataServer(() => new Response(ID_TOKEN));
    const provider = pricingCredentials(
      identity({ roleArn: ROLE, accessKey: KEY }),
      host({ fetch: metadata.fetch, sts: sts.sts }),
    );
    expect(await provider?.()).toMatchObject({ accessKeyId: "ASIAASSUMED" });
    expect(metadata.asked).toEqual([]);
    const [call] = sts.sent;
    expect(call?.form.get("Action")).toBe("AssumeRole");
    expect(call?.form.get("RoleArn")).toBe(ROLE);
    expect(call?.headers.authorization).toContain("Credential=AKIDVPSUSER/");
  });

  it("signs Price List API calls with the role's credentials", async () => {
    const sts = stsEndpoint("AssumeRole");
    const provider = pricingCredentials(
      identity({ roleArn: ROLE, identity: "aws", accessKey: KEY }),
      host({ sts: sts.sts }),
    );
    const signed: string[] = [];
    const client = pricingClient(provider);
    client.middlewareStack.add(
      (next) => async (args) => {
        signed.push(
          String((args.request as { headers: Record<string, string> }).headers.authorization),
        );
        return {
          response: {
            statusCode: 200,
            headers: { "content-type": "application/x-amz-json-1.1" },
            body: new TextEncoder().encode(
              JSON.stringify({ FormatVersion: "aws_v1", PriceList: [] }),
            ),
          },
          output: { $metadata: {}, PriceList: [] },
        } as Awaited<ReturnType<typeof next>>;
      },
      { step: "finalizeRequest", name: "answerLocally", priority: "low" },
    );
    await client.send(new GetProductsCommand({ ServiceCode: "AmazonEC2", MaxResults: 1 }));
    expect(signed[0]).toContain("Credential=ASIAASSUMED/");
  });
});
