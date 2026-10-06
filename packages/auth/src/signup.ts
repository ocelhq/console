import type { Signup } from "./settings";

export interface SignupStore {
  hasUsers(): Promise<boolean>;
  hasPendingInvitation(email: string): Promise<boolean>;
}

export async function maySignUp(email: string, signup: Signup, store: SignupStore) {
  if (signup === "open") return true;
  if (!(await store.hasUsers())) return true;
  return store.hasPendingInvitation(email);
}
