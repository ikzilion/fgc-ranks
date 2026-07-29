// components/DeleteNewsPostButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { isAdminOrAbove } from "@/lib/roles";

// canManage, when provided, is an Event post's creator/manager check —
// otherwise falls back to the original global-post ADMIN-only behavior.
export function DeleteNewsPostButton({ postId, canManage }: { postId: string; canManage?: boolean }) {
  const { data: session } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const role = (session?.user as any)?.role;
  const authorized = canManage !== undefined ? canManage : isAdminOrAbove(role);
  if (!authorized) return null;

  async function handleDelete() {
    if (!confirm("Delete this news post? This cannot be undone.")) return;

    setLoading(true);

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DeleteNewsPost($id: ID!) { deleteNewsPost(id: $id) }`,
          variables: { id: postId },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to delete news post");
      } else {
        router.refresh();
      }
    } catch {
      alert("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      className="text-[11px] font-semibold px-3 py-1.5 rounded"
      style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
    >
      {loading ? "..." : "Delete"}
    </button>
  );
}
