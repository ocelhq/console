const PEM = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/;

export function privateKey(raw: string): string {
  const unescaped = raw.replace(/\\n/g, "\n").trim();
  const match = PEM.exec(unescaped);
  if (!match) return unescaped;
  const [, label, body = ""] = match;
  const lines = body.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`, ""].join("\n");
}
