// app/tournaments/[id]/stream/page.tsx
// Broadcast/OBS browser-source view — no site chrome (see components/Navbar.tsx,
// which hides itself on this route), full-bleed, publicly viewable, read-only.
// Same tournament-visibility rules as the normal detail page (none added here).

import { notFound } from "next/navigation";
import { StreamBracket } from "@/components/StreamBracket";

export const dynamic = "force-dynamic";

const GET_STREAM_TOURNAMENT = `
  query GetStreamTournament($id: ID!) {
    tournament(id: $id) {
      id
      name
      game
      status
      streamBackgroundUrl
      sponsorBannerUrl
      bracket {
        id
        seedingMethod
        size
        matches {
          id
          round
          status
          bracketSide
          bracketRound
          bracketPosition
          player1Score
          player2Score
          player1 { id tag }
          player2 { id tag }
          winner { id tag }
        }
      }
    }
  }
`;

async function getStreamTournament(id: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_STREAM_TOURNAMENT, variables: { id } }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[tournament/stream] GraphQL errors:", json.errors);
      return null;
    }
    return json.data?.tournament ?? null;
  } catch (err) {
    console.error("[tournament/stream] Fetch error:", err);
    return null;
  }
}

export default async function TournamentStreamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getStreamTournament(id);
  if (!tournament) notFound();

  return <StreamBracket tournamentId={id} initialTournament={tournament} />;
}
