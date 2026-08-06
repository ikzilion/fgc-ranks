// app/ads.txt/route.ts
// AdSense site-verification file, required at the domain root once a real
// Publisher ID exists (https://support.google.com/adsense/answer/7532444).
// Derived from NEXT_PUBLIC_ADSENSE_CLIENT_ID (format ca-pub-XXXXXXXXXXXXXXXX)
// rather than a hardcoded/placeholder value, same "no real ID yet, no
// placeholder anywhere in code" rule as components/AdSlot.tsx -- this route
// starts serving the real line automatically the moment that env var is set
// in Vercel, no follow-up code change needed. 404s (not an empty 200) while
// unset, since "no ads.txt" and "empty ads.txt" mean different things to a
// crawler and there's nothing truthful to publish yet.
export async function GET() {
  const clientId = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID;
  if (!clientId) {
    return new Response("Not found", { status: 404 });
  }

  const pubId = clientId.replace(/^ca-/, "");
  const body = `google.com, ${pubId}, DIRECT, f08c47fec0942fa0\n`;
  return new Response(body, { headers: { "Content-Type": "text/plain" } });
}
