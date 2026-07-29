// components/EditEventDetailsButton.tsx
// Post-creation editing for an Event's name/logo/location/Twitch link —
// creator-or-manager gated, same partial-update pattern as
// EditTournamentDetailsButton/updateTournamentDetails.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { maxUploadBytes, formatMaxSizeLabel } from "@/lib/uploadLimits";

interface Props {
  eventId: string;
  name: string;
  logoUrl?: string;
  isOnlineOnly: boolean;
  address?: string;
  twitchUrl?: string;
  description?: string;
  twitterUrl?: string;
  instagramUrl?: string;
  youtubeUrl?: string;
  discordUrl?: string;
  tiktokUrl?: string;
  otherLinkUrl?: string;
  otherLinkLabel?: string;
  canManage: boolean;
}

export function EditEventDetailsButton({
  eventId,
  name: savedName,
  logoUrl: savedLogoUrl,
  isOnlineOnly: savedIsOnlineOnly,
  address: savedAddress,
  twitchUrl: savedTwitchUrl,
  description: savedDescription,
  twitterUrl: savedTwitterUrl,
  instagramUrl: savedInstagramUrl,
  youtubeUrl: savedYoutubeUrl,
  discordUrl: savedDiscordUrl,
  tiktokUrl: savedTiktokUrl,
  otherLinkUrl: savedOtherLinkUrl,
  otherLinkLabel: savedOtherLinkLabel,
  canManage,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(savedName);
  const [logoUrl, setLogoUrl] = useState(savedLogoUrl || "");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [isOnlineOnly, setIsOnlineOnly] = useState(savedIsOnlineOnly);
  const [address, setAddress] = useState(savedAddress || "");
  const [twitchUrl, setTwitchUrl] = useState(savedTwitchUrl || "");
  const [description, setDescription] = useState(savedDescription || "");
  const [twitterUrl, setTwitterUrl] = useState(savedTwitterUrl || "");
  const [instagramUrl, setInstagramUrl] = useState(savedInstagramUrl || "");
  const [youtubeUrl, setYoutubeUrl] = useState(savedYoutubeUrl || "");
  const [discordUrl, setDiscordUrl] = useState(savedDiscordUrl || "");
  const [tiktokUrl, setTiktokUrl] = useState(savedTiktokUrl || "");
  const [otherLinkUrl, setOtherLinkUrl] = useState(savedOtherLinkUrl || "");
  const [otherLinkLabel, setOtherLinkLabel] = useState(savedOtherLinkLabel || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  function resetToSaved() {
    setName(savedName);
    setLogoUrl(savedLogoUrl || "");
    setIsOnlineOnly(savedIsOnlineOnly);
    setAddress(savedAddress || "");
    setTwitchUrl(savedTwitchUrl || "");
    setDescription(savedDescription || "");
    setTwitterUrl(savedTwitterUrl || "");
    setInstagramUrl(savedInstagramUrl || "");
    setYoutubeUrl(savedYoutubeUrl || "");
    setDiscordUrl(savedDiscordUrl || "");
    setTiktokUrl(savedTiktokUrl || "");
    setOtherLinkUrl(savedOtherLinkUrl || "");
    setOtherLinkLabel(savedOtherLinkLabel || "");
    setError("");
  }

  function closeWithoutSaving() {
    resetToSaved();
    setOpen(false);
  }

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const maxBytes = maxUploadBytes("event-logo");
    if (file.size > maxBytes) {
      setError(`Logo must be under ${formatMaxSizeLabel(maxBytes)}.`);
      e.target.value = "";
      return;
    }

    setUploadingLogo(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", "event-logo");

      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();

      if (json.error) {
        setError(json.error);
      } else {
        setLogoUrl(json.url);
      }
    } catch {
      setError("Failed to upload logo. Try again.");
    }

    setUploadingLogo(false);
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Event name is required.");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation UpdateEvent(
              $id: ID!
              $name: String
              $isOnlineOnly: Boolean
              $address: String
              $logoUrl: String
              $twitchUrl: String
              $description: String
              $twitterUrl: String
              $instagramUrl: String
              $youtubeUrl: String
              $discordUrl: String
              $tiktokUrl: String
              $otherLinkUrl: String
              $otherLinkLabel: String
            ) {
              updateEvent(
                id: $id
                name: $name
                isOnlineOnly: $isOnlineOnly
                address: $address
                logoUrl: $logoUrl
                twitchUrl: $twitchUrl
                description: $description
                twitterUrl: $twitterUrl
                instagramUrl: $instagramUrl
                youtubeUrl: $youtubeUrl
                discordUrl: $discordUrl
                tiktokUrl: $tiktokUrl
                otherLinkUrl: $otherLinkUrl
                otherLinkLabel: $otherLinkLabel
              ) { id }
            }
          `,
          variables: {
            id: eventId,
            name,
            isOnlineOnly,
            address: isOnlineOnly ? "" : address,
            logoUrl,
            twitchUrl,
            description,
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
        setError(json.errors[0]?.message ?? "Failed to save event details");
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
        onClick={() => { resetToSaved(); setOpen(true); }}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        Edit details
      </button>

      {open && (
        // overflow-y-auto + py-8 (not just items-center) -- the social-links
        // fields below made this modal tall enough that on a shorter
        // viewport the Save button could render below the fold with no way
        // to reach it (the old items-center-only wrapper never scrolled).
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4 py-8 overflow-y-auto"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={closeWithoutSaving}
        >
          <div className="fgc-card p-6 w-full max-w-lg my-auto" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">Edit event details</h2>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Event name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Logo</label>
              <div className="flex items-center gap-3">
                {logoUrl && (
                  <div className="w-12 h-12 rounded overflow-hidden flex-shrink-0" style={{ border: "1px solid var(--border-strong)" }}>
                    <img src={logoUrl} alt="Logo preview" className="w-full h-full object-cover" />
                  </div>
                )}
                <label
                  className="text-[12px] font-semibold px-3 py-2 rounded cursor-pointer"
                  style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
                >
                  {uploadingLogo ? "Uploading..." : logoUrl ? "Change" : "Upload"}
                  <input type="file" accept="image/*" onChange={handleLogoChange} disabled={uploadingLogo} className="hidden" />
                </label>
                {logoUrl && (
                  <button
                    type="button"
                    onClick={() => setLogoUrl("")}
                    className="text-[12px] font-semibold px-3 py-2 rounded"
                    style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: "pointer" }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Location</label>
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => setIsOnlineOnly(false)}
                  className="flex-1 py-2 rounded font-rajdhani text-[13px] font-bold"
                  style={{
                    background: !isOnlineOnly ? "var(--blue)" : "var(--navy-3)",
                    color: !isOnlineOnly ? "white" : "var(--text-secondary)",
                    border: "1px solid var(--border-strong)",
                    cursor: "pointer",
                  }}
                >
                  In-person
                </button>
                <button
                  type="button"
                  onClick={() => setIsOnlineOnly(true)}
                  className="flex-1 py-2 rounded font-rajdhani text-[13px] font-bold"
                  style={{
                    background: isOnlineOnly ? "var(--blue)" : "var(--navy-3)",
                    color: isOnlineOnly ? "white" : "var(--text-secondary)",
                    border: "1px solid var(--border-strong)",
                    cursor: "pointer",
                  }}
                >
                  Online only
                </button>
              </div>
              {!isOnlineOnly && (
                <input
                  type="text"
                  value={address}
                  onChange={e => setAddress(e.target.value)}
                  placeholder="e.g. 123 Main St, Portland, OR"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
              )}
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Twitch link</label>
              <input
                type="text"
                value={twitchUrl}
                onChange={e => setTwitchUrl(e.target.value)}
                placeholder="https://twitch.tv/..."
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            {/* Social links (settled July 28, 2026) — same fixed platform
                set + one generic slot as Player's own copy of these fields,
                see components/SocialLinks.tsx. Two-column grid (not one
                field per row like everything else here) since these are 5
                parallel simple URL inputs. */}
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
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Description (optional)</label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What is this event? Venue info, schedule notes, etc. Markdown supported — **bold**, [links](https://...), line breaks."
                rows={4}
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
                onClick={closeWithoutSaving}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={loading || uploadingLogo}
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
