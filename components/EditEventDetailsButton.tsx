// components/EditEventDetailsButton.tsx
// Post-creation editing for an Event's name/logo/location/Twitch link —
// creator-or-manager gated, same partial-update pattern as
// EditTournamentDetailsButton/updateTournamentDetails.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  eventId: string;
  name: string;
  logoUrl?: string;
  isOnlineOnly: boolean;
  address?: string;
  twitchUrl?: string;
  canManage: boolean;
}

export function EditEventDetailsButton({
  eventId,
  name: savedName,
  logoUrl: savedLogoUrl,
  isOnlineOnly: savedIsOnlineOnly,
  address: savedAddress,
  twitchUrl: savedTwitchUrl,
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  function resetToSaved() {
    setName(savedName);
    setLogoUrl(savedLogoUrl || "");
    setIsOnlineOnly(savedIsOnlineOnly);
    setAddress(savedAddress || "");
    setTwitchUrl(savedTwitchUrl || "");
    setError("");
  }

  function closeWithoutSaving() {
    resetToSaved();
    setOpen(false);
  }

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

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
            mutation UpdateEvent($id: ID!, $name: String, $isOnlineOnly: Boolean, $address: String, $logoUrl: String, $twitchUrl: String) {
              updateEvent(id: $id, name: $name, isOnlineOnly: $isOnlineOnly, address: $address, logoUrl: $logoUrl, twitchUrl: $twitchUrl) { id }
            }
          `,
          variables: {
            id: eventId,
            name,
            isOnlineOnly,
            address: isOnlineOnly ? "" : address,
            logoUrl,
            twitchUrl,
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
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={closeWithoutSaving}
        >
          <div className="fgc-card p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
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

            <div className="mb-6">
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
