// app/page.tsx — homepage
// Phase 1: news feed only, rendered directly here for now. Phase 2 will
// rebuild this into the full 3-column layout (player card / feed / tournament
// sidebars) around this same feed.
import { NewsPostForm } from "@/components/NewsPostForm";
import { DeleteNewsPostButton } from "@/components/DeleteNewsPostButton";

export const dynamic = "force-dynamic";

const GET_NEWS_POSTS = `
  query GetNewsPosts {
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
  }
`;

async function getNewsPosts() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_NEWS_POSTS }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[news] GraphQL errors:", json.errors);
      return [];
    }
    return json.data?.newsPosts ?? [];
  } catch (err) {
    console.error("[news] Fetch error:", err);
    return [];
  }
}

export default async function Home() {
  const posts = await getNewsPosts();

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
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
    </main>
  );
}
