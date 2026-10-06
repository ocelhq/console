export function callbackPath(redirect: string | undefined): string {
  if (!redirect?.startsWith("/") || redirect.startsWith("//") || redirect.startsWith("/\\")) {
    return "/";
  }
  return redirect;
}
