import { coordinateKey, type MatrixCell, type MatrixRow, type State, type Version } from "../model";
import { at } from "./memory-port";

const cell = (over: Partial<MatrixCell>): MatrixCell => ({
  folder: "",
  state: "optional",
  set: false,
  version: 0,
  ...over,
});

const row = (key: string, cells: MatrixCell[], over: Partial<MatrixRow> = {}): MatrixRow => ({
  key,
  class: "plain",
  cells,
  ...over,
});

const apps = [
  { name: "web", folder: "/web" },
  { name: "api", folder: "/api" },
];

const rows: MatrixRow[] = [
  row(
    "DATABASE_URL",
    [
      cell({
        state: "required",
        set: true,
        version: 3,
        overrides: [{ environment: "pr-12", version: 1 }],
      }),
    ],
    { class: "secret", description: "Postgres connection string" },
  ),
  row("SESSION_SECRET", [cell({ state: "required", set: true, version: 2 })], {
    class: "secret",
    description: "signs session cookies",
  }),
  row("LOG_LEVEL", [cell({ set: true, version: 1 })]),
  row(
    "SENTRY_DSN",
    [
      cell({ folder: "/web", set: true, version: 1 }),
      cell({ folder: "/api", set: true, version: 1 }),
    ],
    { class: "sensitive", scope: ["/web", "/api"] },
  ),
  row(
    "NEXT_PUBLIC_SITE_URL",
    [cell({ folder: "/web", state: "required", set: true, version: 4 })],
    { scope: ["/web"] },
  ),
  row("STRIPE_SECRET_KEY", [cell({ folder: "/api", state: "required", set: true, version: 2 })], {
    class: "secret",
    scope: ["/api"],
  }),
  row("STRIPE_WEBHOOK_SECRET", [cell({ folder: "/api", set: true, version: 1 })], {
    class: "secret",
    scope: ["/api"],
  }),
  row("GITHUB_CLIENT_ID", [cell({ state: "required" })], { group: "github" }),
  row("GITHUB_CLIENT_SECRET", [cell({ state: "required" })], {
    class: "secret",
    group: "github",
  }),
];

export const populated: State = {
  slug: "acme",
  tier: "preview",
  other: "production",
  environments: ["pr-12", "pr-15"],
  matrix: {
    columns: ["", "/web", "/api"],
    rows,
    groups: [{ key: "github", required: false, description: "sign in with GitHub" }],
    apps,
  },
};

export const values: Record<string, string> = {
  [coordinateKey(at("DATABASE_URL"))]: "postgres://acme:hunter2@db.internal:5432/acme",
  [coordinateKey(at("DATABASE_URL", "", "pr-12"))]:
    "postgres://acme:hunter2@db.internal:5432/pr_12",
  [coordinateKey(at("SESSION_SECRET"))]: "b3f1c0e2a9d84f7c9e5a1d2c3b4a5f6e",
  [coordinateKey(at("LOG_LEVEL"))]: "info",
  [coordinateKey(at("SENTRY_DSN", "/web"))]: "https://4f1e@o12.ingest.sentry.io/301",
  [coordinateKey(at("SENTRY_DSN", "/api"))]: "https://9a2c@o12.ingest.sentry.io/302",
  [coordinateKey(at("NEXT_PUBLIC_SITE_URL", "/web"))]: "https://preview.acme.dev",
  [coordinateKey(at("STRIPE_SECRET_KEY", "/api"))]: "sk_test_51Hx",
  [coordinateKey(at("STRIPE_WEBHOOK_SECRET", "/api"))]: "whsec_7Yq",
};

export const empty: State = {
  slug: "acme",
  tier: "preview",
  other: "production",
  environments: [],
  matrix: { columns: [""], rows: [], apps: [] },
};

export const readOnly: State = { ...populated, can: { write: false, reveal: false } };

const unfilledRows = rows.map((found) => {
  if (found.key === "SESSION_SECRET") {
    return { ...found, cells: [cell({ state: "required" })] };
  }
  if (found.key === "STRIPE_SECRET_KEY") {
    return { ...found, cells: [cell({ folder: "/api", state: "required" })] };
  }
  return found;
});

export const unfilled: State = {
  ...populated,
  matrix: { ...populated.matrix, rows: unfilledRows },
  recovery: {
    deploy: "dep_8c1f",
    missing: [
      { key: "SESSION_SECRET", folder: "" },
      { key: "STRIPE_SECRET_KEY", folder: "/api" },
    ],
  },
};

const faultyRows = rows.map((found) => {
  if (found.key === "NEXT_PUBLIC_SITE_URL") {
    return {
      ...found,
      cells: [
        cell({
          folder: "/web",
          state: "required",
          set: true,
          version: 5,
          problem: "expected a URL, got “preview.acme.dev”",
        }),
      ],
    };
  }
  return found;
});

export const faulty: State = { ...populated, matrix: { ...populated.matrix, rows: faultyRows } };

export const infisical = "infisical:acme/preview";

export const envSourced: State = {
  ...populated,
  matrix: {
    ...populated.matrix,
    rows: [
      ...rows.map((found) =>
        found.group
          ? found
          : { ...found, cells: found.cells.map((c) => ({ ...c, envSource: infisical })) },
      ),
      row("INFISICAL_CLIENT_SECRET", [cell({ state: "required", set: true, version: 1 })], {
        class: "secret",
        group: "env source",
      }),
    ],
    undeclared: [
      { key: "LEGACY_API_TOKEN", folder: "/api", envSource: infisical },
      { key: "OLD_SITE_URL", folder: "/web", envSource: infisical },
    ],
  },
  envSource: {
    id: infisical,
    canCreate: true,
    canUpdate: false,
    urls: {
      "": "https://app.infisical.com/project/acme/preview",
      "/web": "https://app.infisical.com/project/acme/preview/web",
      "/api": "https://app.infisical.com/project/acme/preview/api",
    },
    credentials: ["INFISICAL_CLIENT_SECRET"],
  },
};

const hour = 3600;
const now = 1_790_000_000;

export const history: Version[] = [
  { version: 3, createdAt: now - 2 * hour, size: 46 },
  { version: 2, createdAt: now - 26 * hour, size: 46 },
  { version: 1, createdAt: now - 24 * 9 * hour, size: 41 },
];

export const production = {
  tier: "production",
  values: [
    {
      ...at("LOG_LEVEL"),
      version: 2,
      class: "plain" as const,
      value: "warn",
    },
    {
      ...at("SENTRY_DSN", "/web"),
      version: 3,
      class: "sensitive" as const,
      value: "https://4f1e@o12.ingest.sentry.io/101",
    },
    {
      ...at("GITHUB_CLIENT_ID"),
      version: 1,
      class: "plain" as const,
      value: "Iv1.8a61f9b3a7aba766",
    },
    {
      ...at("STRIPE_SECRET_KEY", "/api"),
      version: 6,
      class: "secret" as const,
      error: "the production key store refused to decrypt this value",
    },
  ],
};
