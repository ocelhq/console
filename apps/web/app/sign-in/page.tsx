import { readAuthSettings } from "@console/auth/settings";
import { callbackPath } from "./callback";
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
    />
  );
}
