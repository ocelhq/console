import { consoleOrigin } from "@console/auth";
import { configuredIssuer, type Issuer } from "@console/targets";

const CACHED = { "cache-control": "public, max-age=300" };

export function oidcRoutes(issuer: () => Promise<Issuer> | undefined) {
  async function serve(body: (issuer: Issuer) => Promise<unknown> | unknown): Promise<Response> {
    const configured = issuer();
    if (!configured) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    try {
      return Response.json(await body(await configured), { headers: CACHED });
    } catch {
      return Response.json(
        { error: "The issuer's key is unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  }

  return {
    configuration: () => serve((found) => found.discovery()),
    jwks: () => serve((found) => found.jwks()),
  };
}

const configured = oidcRoutes(() => configuredIssuer(consoleOrigin()));

export const oidcConfiguration = configured.configuration;
export const oidcJwks = configured.jwks;
