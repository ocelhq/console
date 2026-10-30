import { readAuthSettings } from "@console/auth/settings";
import { env } from "@console/infra/env";
import { callbackPath } from "./callback";
import { Inside } from "./inside";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  const settings = readAuthSettings();

  return (
    <SignInForm
      github={settings.github !== undefined}
      email={settings.email}
      callbackURL={callbackPath(redirect)}
      waitlist={settings.signup === "invite" ? env.CONSOLE_WAITLIST_URL : undefined}
      aside={<Inside />}
    />
  );
}
