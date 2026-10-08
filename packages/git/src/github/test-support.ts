import { createHmac, generateKeyPairSync } from "node:crypto";
import type { WebhookRequest } from "../provider";

export const WEBHOOK_SECRET = "whsec_test";

export const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export function delivery(event: string, payload: unknown, secret = WEBHOOK_SECRET): WebhookRequest {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: new Headers({
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    }),
  };
}

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

interface FakeComment {
  id: number;
  body: string;
  user: { type: "Bot" | "User" };
}

interface FakeDeployment {
  id: number;
  environment: string;
  sha: string;
}

export function fakeGithub() {
  const calls: Call[] = [];
  const deployments: FakeDeployment[] = [];
  const comments: FakeComment[] = [];
  const repositories: { id: number; full_name: string }[] = [];
  let nextId = 1;

  function reply(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const call = { method, path: url.pathname, query: url.searchParams, body };
    calls.push(call);
    const at = `${method} ${url.pathname}`;

    if (/^POST \/app\/installations\/\d+\/access_tokens$/.test(at)) {
      return reply(
        {
          token: "ghs_installation",
          expires_at: "2030-01-01T00:00:00Z",
          permissions: body.permissions ?? {},
          repository_selection: body.repositories ? "selected" : "all",
        },
        201,
      );
    }
    if (at === "GET /installation/repositories") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("per_page") ?? "30");
      return reply({
        total_count: repositories.length,
        repositories: repositories.slice((page - 1) * size, page * size),
      });
    }
    if (/^POST \/repos\/[^/]+\/[^/]+\/statuses\/\w+$/.test(at)) return reply({ id: nextId++ }, 201);
    if (/^GET \/repos\/[^/]+\/[^/]+\/deployments$/.test(at)) {
      const environment = url.searchParams.get("environment");
      const sha = url.searchParams.get("sha");
      return reply(
        deployments.filter(
          (deployment) =>
            deployment.environment === environment && (!sha || deployment.sha === sha),
        ),
      );
    }
    if (/^POST \/repos\/[^/]+\/[^/]+\/deployments$/.test(at)) {
      const deployment = {
        id: nextId++,
        environment: String(body.environment),
        sha: String(body.ref),
      };
      deployments.push(deployment);
      return reply(deployment, 201);
    }
    if (/^POST \/repos\/[^/]+\/[^/]+\/deployments\/\d+\/statuses$/.test(at)) {
      return reply({ id: nextId++ }, 201);
    }
    if (/^GET \/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(at)) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("per_page") ?? "30");
      return reply(comments.slice((page - 1) * size, page * size));
    }
    if (/^POST \/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(at)) {
      const comment = { id: nextId++, body: String(body.body), user: { type: "Bot" as const } };
      comments.push(comment);
      return reply(comment, 201);
    }
    const patched = at.match(/^PATCH \/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/);
    if (patched) {
      const comment = comments.find((candidate) => candidate.id === Number(patched[1]));
      if (!comment) return reply({ message: "Not Found" }, 404);
      comment.body = String(body.body);
      return reply(comment);
    }
    return reply({ message: `unfaked ${at}` }, 404);
  };

  return {
    fetch: fetchFake,
    calls,
    deployments,
    comments,
    repositories,
    callsTo(method: string, pattern: RegExp) {
      return calls.filter((call) => call.method === method && pattern.test(call.path));
    },
  };
}
