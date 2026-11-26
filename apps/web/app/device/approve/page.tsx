import { getViewer, requireOrganization } from "@/lib/access";
import { ApproveDevice } from "./approve-device";

export default async function DeviceApprovalPage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) {
  const session = await requireOrganization();
  const [{ user_code }, viewer] = await Promise.all([searchParams, getViewer(session.userId)]);

  return <ApproveDevice userCode={user_code ?? ""} signedInAs={viewer?.email ?? ""} />;
}
