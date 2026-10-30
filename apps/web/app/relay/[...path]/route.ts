import { readAnalytics, relayed } from "@/lib/analytics";

// PostHog through the console's own origin, so blockers that drop third-party analytics
// hosts still let events, replays and the recorder through.
async function relay(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const analytics = readAnalytics();
  if (!analytics) {
    return new Response(null, { status: 404 });
  }
  const upstream = await fetch(relayed(request, (await params).path, analytics));
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers });
}

export { relay as GET, relay as OPTIONS, relay as POST };
