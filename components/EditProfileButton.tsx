// components/EditProfileButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { maxUploadBytes, formatMaxSizeLabel } from "@/lib/uploadLimits";

interface Props {
  playerId: string;
  currentTag: string;
  currentRegion: string;
  currentCharacters: string[];
  currentAvatarUrl?: string;
  currentTeam?: string;
  currentTwitchUrl?: string;
  currentTwitterUrl?: string;
  currentInstagramUrl?: string;
  currentYoutubeUrl?: string;
  currentDiscordUrl?: string;
  currentTiktokUrl?: string;
  currentOtherLinkUrl?: string;
  currentOtherLinkLabel?: string;
}

export function EditProfileButton({
  playerId,
  currentTag,
  currentRegion,
  currentCharacters,
  currentAvatarUrl,
  currentTeam,
  currentTwitchUrl,
  currentTwitterUrl,
  currentInstagramUrl,
  currentYoutubeUrl,
  currentDiscordUrl,
  currentTiktokUrl,
  currentOtherLinkUrl,
  currentOtherLinkLabel,
}: Props) {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState(currentTag);
  const [region, setRegion] = useState(currentRegion || "");
  const [charactersInput, setCharactersInput] = useState(currentCharacters.join(", "));
  const [avatarUrl, setAvatarUrl] = useState(currentAvatarUrl || "");
  const [team, setTeam] = useState(currentTeam || "");
  const [twitchUrl, setTwitchUrl] = useState(currentTwitchUrl || "");
  const [twitterUrl, setTwitterUrl] = useState(currentTwitterUrl || "");
  const [instagramUrl, setInstagramUrl] = useState(currentInstagramUrl || "");
  const [youtubeUrl, setYoutubeUrl] = useState(currentYoutubeUrl || "");
  const [discordUrl, setDiscordUrl] = useState(currentDiscordUrl || "");
  const [tiktokUrl, setTiktokUrl] = useState(currentTiktokUrl || "");
  const [otherLinkUrl, setOtherLinkUrl] = useState(currentOtherLinkUrl || "");
  const [otherLinkLabel, setOtherLinkLabel] = useState(currentOtherLinkLabel || "");
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Only show the edit button on your own profile
  const isOwnProfile = (session?.user as any)?.playerId === playerId;
  if (!isOwnProfile) return null;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const maxBytes = maxUploadBytes("avatar");
    if (file.size > maxBytes) {
      setError(`Image must be under ${formatMaxSizeLabel(maxBytes)}.`);
      e.target.value = "";
      return;
    }

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
            mutation UpdatePlayer(
              $id: ID!
              $tag: String
              $region: String
              $avatarUrl: String
              $characters: [String!]
              $team: String
              $twitchUrl: String
              $twitterUrl: String
              $instagramUrl: String
              $youtubeUrl: String
              $discordUrl: String
              $tiktokUrl: String
              $otherLinkUrl: String
              $otherLinkLabel: String
            ) {
              updatePlayer(
                id: $id
                tag: $tag
                region: $region
                avatarUrl: $avatarUrl
                characters: $characters
                team: $team
                twitchUrl: $twitchUrl
                twitterUrl: $twitterUrl
                instagramUrl: $instagramUrl
                youtubeUrl: $youtubeUrl
                discordUrl: $discordUrl
                tiktokUrl: $tiktokUrl
                otherLinkUrl: $otherLinkUrl
                otherLinkLabel: $otherLinkLabel
              ) {
                id
                tag
                region
                avatarUrl
                characters
                team
                twitchUrl
                twitterUrl
                instagramUrl
                youtubeUrl
                discordUrl
                tiktokUrl
                otherLinkUrl
                otherLinkLabel
              }
            }
          `,
          variables: {
            id: playerId,
            tag,
            region,
            avatarUrl,
            characters,
            team,
            twitchUrl,
            twitterUrl,
            instagramUrl,
            youtubeUrl,
            discordUrl,
            tiktokUrl,
            otherLinkUrl,
            otherLinkLabel,
          },
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
        // overflow-y-auto + py-8 (not just items-center) -- the social-links
        // fields below made this modal tall enough that on a shorter
        // viewport the Save button could render below the fold with no way
        // to reach it (the old items-center-only wrapper never scrolled).
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4 py-8 overflow-y-auto"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm my-auto" onClick={e => e.stopPropagation()}>
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
            {/* Server auto-resizes/compresses every avatar (lib/avatarImage.ts)
                regardless of the original photo's dimensions/size, so this is
                purely informational, not a hard limit the user needs to work around. */}
            <p className="text-[11px] text-[var(--text-muted)] -mt-2 mb-4">Photos are automatically resized and compressed.</p>

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
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Twitch channel (optional)</label>
              <input
                type="text"
                value={twitchUrl}
                onChange={e => setTwitchUrl(e.target.value)}
                placeholder="https://twitch.tv/yourname"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            {/* Social links (settled July 28, 2026) — same fixed platform
                set + one generic slot as Event's own copy of these fields,
                see components/SocialLinks.tsx. Two-column grid (not one
                field per row like everything else above) since these are 5
                parallel simple URL inputs — keeps the already-long modal
                from growing taller than it needs to. */}
            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Social links (all optional)</label>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input
                  type="text"
                  value={twitterUrl}
                  onChange={e => setTwitterUrl(e.target.value)}
                  placeholder="X / Twitter URL"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
                <input
                  type="text"
                  value={instagramUrl}
                  onChange={e => setInstagramUrl(e.target.value)}
                  placeholder="Instagram URL"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
                <input
                  type="text"
                  value={youtubeUrl}
                  onChange={e => setYoutubeUrl(e.target.value)}
                  placeholder="YouTube URL"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
                <input
                  type="text"
                  value={discordUrl}
                  onChange={e => setDiscordUrl(e.target.value)}
                  placeholder="Discord URL"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
                <input
                  type="text"
                  value={tiktokUrl}
                  onChange={e => setTiktokUrl(e.target.value)}
                  placeholder="TikTok URL"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
              </div>
              {/* Generic "website/other" slot — one only. otherLinkLabel is
                  only meaningful once otherLinkUrl is also set. */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={otherLinkUrl}
                  onChange={e => setOtherLinkUrl(e.target.value)}
                  placeholder="Other link URL"
                  className="flex-1 min-w-0 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
                <input
                  type="text"
                  value={otherLinkLabel}
                  onChange={e => setOtherLinkLabel(e.target.value)}
                  placeholder="Label (e.g. Linktree)"
                  className="w-36 flex-shrink-0 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
              </div>
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
