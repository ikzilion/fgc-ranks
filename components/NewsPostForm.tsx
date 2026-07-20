// components/NewsPostForm.tsx
// Admin-only create/edit modal for news posts — mirrors CreateTournamentButton's
// modal pattern. Renders nothing for non-admins.
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Props {
  // When provided, the form edits this post instead of creating a new one.
  post?: { id: string; title: string; content: string };
  // When provided, this is an Event's own news section instead of the
  // global homepage feed — authorization switches from "must be ADMIN" to
  // the passed-in canManage (that Event's creator/managers), and new posts
  // are created scoped to this Event.
  eventId?: string;
  canManage?: boolean;
}

export function NewsPostForm({ post, eventId, canManage }: Props) {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(post?.title ?? "");
  const [content, setContent] = useState(post?.content ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const role = (session?.user as any)?.role;
  const authorized = eventId ? !!canManage : role === "ADMIN";
  if (!authorized) return null;

  const isEdit = !!post;

  async function handleSubmit() {
    if (!title.trim() || !content.trim()) {
      setError("Title and body are both required.");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit
            ? {
                query: `
                  mutation UpdateNewsPost($id: ID!, $title: String, $content: String) {
                    updateNewsPost(id: $id, title: $title, content: $content) { id }
                  }
                `,
                variables: { id: post!.id, title, content },
              }
            : {
                query: `
                  mutation CreateNewsPost($title: String!, $content: String!, $eventId: ID) {
                    createNewsPost(title: $title, content: $content, eventId: $eventId) { id }
                  }
                `,
                variables: { title, content, eventId },
              }
        ),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to save news post");
      } else {
        setOpen(false);
        if (!isEdit) {
          setTitle("");
          setContent("");
        }
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={isEdit ? "text-[11px] font-semibold px-3 py-1.5 rounded" : "font-rajdhani text-[13px] font-bold tracking-wide px-4 py-2 rounded"}
        style={
          isEdit
            ? { background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }
            : { background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }
        }
      >
        {isEdit ? "Edit" : "+ New post"}
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">
              {isEdit ? "Edit news post" : "New news post"}
            </h2>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Title</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Registration now open for CEO 2026"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-6">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Body</label>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Write the announcement..."
                rows={6}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)] resize-none"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            {error && (
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setOpen(false)}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
              >
                {loading ? "Saving..." : isEdit ? "Save" : "Post"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
