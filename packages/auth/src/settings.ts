import { env } from "@console/infra/env";

export type Signup = "open" | "invite";

export interface AuthSettings {
  github: { clientId: string; clientSecret: string } | undefined;
  email: boolean;
  signup: Signup;
}

export function readAuthSettings(): AuthSettings {
  const github = env.githubAuth;
  return {
    github: github && {
      clientId: github.GITHUB_CLIENT_ID,
      clientSecret: github.GITHUB_CLIENT_SECRET,
    },
    email: env.CONSOLE_EMAIL_AUTH,
    signup: env.CONSOLE_SIGNUP,
  };
}

export function assertSignInMethod(settings: AuthSettings): void {
  if (!settings.github && !settings.email) {
    throw new Error(
      "No sign-in method is enabled: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or CONSOLE_EMAIL_AUTH=true.",
    );
  }
}
