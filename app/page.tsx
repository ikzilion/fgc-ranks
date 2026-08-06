// app/page.tsx — homepage
// Phase 2: full 3-column layout. Left = signed-in player's card (or a
// sign-in prompt when logged out), center = the Phase 1 news feed
// (unchanged, just repositioned), right = live/upcoming tournaments.
import { auth } from "@/lib/auth";
import { NewsPostForm } from "@/components/NewsPostForm";
import { DeleteNewsPostButton } from "@/components/DeleteNewsPostButton";
import { PlayerCard } from "@/components/PlayerCard";
import { LiveUpcomingTournaments } from "@/components/LiveUpcomingTournaments";
import { AdSlot } from "@/components/AdSlot";

export const dynamic = "force-dynamic";

const GET_NEWS_AND_TOURNAMENTS = `
  query GetNewsAndTournaments {
    newsPosts(limit: 20) {
      id
      title
      content
      createdAt
      updatedAt
      author {
        id
        tag
      }
    }
    tournaments(limit: 50) {
      id
      name
      game
      status
      entrantCount
      startDate
    }
  }
`;

const GET_HOME_PLAYER = `
  query GetHomePlayer($id: ID!) {
    player(id: $id) {
      id
      tag
      region
      team
      avatarUrl
      wins
      losses
      points
      winRate
      isLiveOnTwitch
      user { id isTO }
    }
  }
`;

async function getHomeData(playerId?: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const [feedRes, playerJson] = await Promise.all([
      fetch(`${baseUrl}/api/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: GET_NEWS_AND_TOURNAMENTS }),
        cache: "no-store",
      }).then(r => r.json()),
      playerId
        ? fetch(`${baseUrl}/api/graphql`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: GET_HOME_PLAYER, variables: { id: playerId } }),
            cache: "no-store",
          }).then(r => r.json())
        : Promise.resolve(null),
    ]);

    if (feedRes.errors) console.error("[home] GraphQL errors:", feedRes.errors);
    if (playerJson?.errors) console.error("[home] GraphQL player errors:", playerJson.errors);

    return {
      newsPosts: feedRes.data?.newsPosts ?? [],
      tournaments: feedRes.data?.tournaments ?? [],
      player: playerJson?.data?.player ?? null,
    };
  } catch (err) {
    console.error("[home] Fetch error:", err);
    return { newsPosts: [], tournaments: [], player: null };
  }
}

export default async function Home() {
  const session = await auth();
  const playerId = (session?.user as any)?.playerId ?? undefined;
  const { newsPosts: posts, tournaments, player } = await getHomeData(playerId);

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
        {/* LEFT — player card / sign-in prompt */}
        <div className="sm:col-span-1 order-1">
          <PlayerCard player={player} />
        </div>

        {/* CENTER — news feed (Phase 1, unchanged) */}
        <div className="sm:col-span-2 order-2">
          <div className="flex items-center justify-between mb-6">
            <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">News</h1>
            <NewsPostForm />
          </div>

          {posts.length === 0 && (
            <div className="fgc-card p-6">
              <p className="text-[var(--text-secondary)]">No news yet.</p>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {posts.map((post: any) => (
              <article key={post.id} className="fgc-card p-5">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h2 className="font-rajdhani text-lg font-bold text-[var(--text-primary)] leading-tight">{post.title}</h2>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <NewsPostForm post={post} />
                    <DeleteNewsPostButton postId={post.id} />
                  </div>
                </div>
                <p className="text-[13px] text-[var(--text-secondary)] whitespace-pre-wrap mb-3">{post.content}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {post.author?.tag ?? "Unknown"} · {new Date(post.createdAt).toLocaleDateString()}
                  {post.updatedAt !== post.createdAt && " (edited)"}
                </p>
              </article>
            ))}
          </div>
        </div>

        {/* RIGHT — live/upcoming tournaments */}
        <div className="sm:col-span-1 order-3">
          <LiveUpcomingTournaments tournaments={tournaments} viewAllHref="/tournaments" />
        </div>
      </div>

      <AdSlot className="mt-8" />
    </main>
  );
}
