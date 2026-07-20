// components/EditProfileButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Props {
  playerId: string;
  currentTag: string;
  currentRegion: string;
  currentCharacters: string[];
  currentAvatarUrl?: string;
  currentTeam?: string;
}

export function EditProfileButton({ playerId, currentTag, currentRegion, currentCharacters, currentAvatarUrl, currentTeam }: Props) {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState(currentTag);
  const [region, setRegion] = useState(currentRegion || "");
  const [charactersInput, setCharactersInput] = useState(currentCharacters.join(", "));
  const [avatarUrl, setAvatarUrl] = useState(currentAvatarUrl || "");
  const [team, setTeam] = useState(currentTeam || "");
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Only show the edit button on your own profile
  const isOwnProfile = (session?.user as any)?.playerId === playerId;
  if (!isOwnProfile) return null;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();

      if (json.error) {
        setError(json.error);
      } else {
        setAvatarUrl(json.url);
      }
    } catch {
      setError("Failed to upload image. Try again.");
    }

    setUploading(false);
  }

  async function handleSubmit() {
    setLoading(true);
    setError("");

    const characters = charactersInput
      .split(",")
      .map(c => c.trim())
      .filter(Boolean);

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation UpdatePlayer($id: ID!, $tag: String, $region: String, $avatarUrl: String, $characters: [String!], $team: String) {
              updatePlayer(id: $id, tag: $tag, region: $region, avatarUrl: $avatarUrl, characters: $characters, team: $team) {
                id
                tag
                region
                avatarUrl
                characters
                team
              }
            }
          `,
          variables: { id: playerId, tag, region, avatarUrl, characters, team },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to update profile");
      } else {
        setOpen(false);
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
        className="text-[11px] font-semibold px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        Edit profile
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">Edit profile</h2>

            <div className="mb-4 flex items-center gap-3">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden font-rajdhani text-lg font-bold"
                style={{ background: "var(--blue-dim)", border: "2px solid rgba(79,142,247,0.4)", color: "var(--blue)" }}
              >
                {avatarUrl ? (
                  <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" />
                ) : (
                  tag.slice(0, 2).toUpperCase()
                )}
              </div>
              <label
                className="text-[12px] font-semibold px-3 py-2 rounded cursor-pointer"
                style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
              >
                {uploading ? "Uploading..." : "Change photo"}
                <input type="file" accept="image/*" onChange={handleFileChange} disabled={uploading} className="hidden" />
              </label>
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Player tag</label>
              <input
                type="text"
                value={tag}
                onChange={e => setTag(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Region</label>
              <input
                type="text"
                value={region}
                onChange={e => setRegion(e.target.value)}
                placeholder="e.g. Dominican Republic"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Team (optional)</label>
              <input
                type="text"
                value={team}
                onChange={e => setTeam(e.target.value)}
                placeholder="e.g. Team Liquid"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-6">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Characters (comma separated)</label>
              <input
                type="text"
                value={charactersInput}
                onChange={e => setCharactersInput(e.target.value)}
                placeholder="e.g. Ryu, Chun-Li"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
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
                {loading ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
