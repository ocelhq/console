import { requireOrganization } from "@/lib/access";
import { EnterCode } from "./enter-code";

export default async function DeviceVerificationPage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) {
  await requireOrganization();
  const { user_code } = await searchParams;

  return <EnterCode initialCode={user_code ?? ""} />;
}
