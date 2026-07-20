// components/EditTournamentDetailsButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface LinkedEvent {
  id: string;
  displayId: string;
  name: string;
  logoUrl?: string;
}

interface Props {
  tournamentId: string;
  logoUrl?: string;
  isOnlineOnly: boolean;
  address?: string;
  twitchUrl?: string;
  format?: string;
  capacity?: number | null;
  entryFee?: string;
  prizePot?: string;
  event?: LinkedEvent | null;
  canManage: boolean;
}

// Post-creation editing for the metadata batch (logo, location, Twitch,
// format, capacity, entry fee/prize pot) — CreateTournamentButton only
// covers these at creation time; this is the TO's way to change them
// afterward, same isOrganizer-gated partial-update pattern as
// StreamAssetsButton/updateTournamentStreamAssets.
export function EditTournamentDetailsButton({
  tournamentId,
  logoUrl: savedLogoUrl,
  isOnlineOnly: savedIsOnlineOnly,
  address: savedAddress,
  twitchUrl: savedTwitchUrl,
  format: savedFormat,
  capacity: savedCapacity,
  entryFee: savedEntryFee,
  prizePot: savedPrizePot,
  event: savedEvent,
  canManage,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [logoUrl, setLogoUrl] = useState(savedLogoUrl || "");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [isOnlineOnly, setIsOnlineOnly] = useState(savedIsOnlineOnly);
  const [address, setAddress] = useState(savedAddress || "");
  const [twitchUrl, setTwitchUrl] = useState(savedTwitchUrl || "");
  const [format, setFormat] = useState(savedFormat || "");
  const [capacity, setCapacity] = useState(savedCapacity != null ? String(savedCapacity) : "");
  const [entryFee, setEntryFee] = useState(savedEntryFee || "");
  const [prizePot, setPrizePot] = useState(savedPrizePot || "");
  // Event ID linking — same lookup+confirmation UX as CreateTournamentButton,
  // seeded from the currently linked event (if any) on open.
  const [eventIdInput, setEventIdInput] = useState("");
  const [linkedEvent, setLinkedEvent] = useState<LinkedEvent | null>(savedEvent ?? null);
  const [eventLookupLoading, setEventLookupLoading] = useState(false);
  const [eventLookupError, setEventLookupError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  function resetToSaved() {
    setLogoUrl(savedLogoUrl || "");
    setIsOnlineOnly(savedIsOnlineOnly);
    setAddress(savedAddress || "");
    setTwitchUrl(savedTwitchUrl || "");
    setFormat(savedFormat || "");
    setCapacity(savedCapacity != null ? String(savedCapacity) : "");
    setEntryFee(savedEntryFee || "");
    setPrizePot(savedPrizePot || "");
    setEventIdInput("");
    setLinkedEvent(savedEvent ?? null);
    setEventLookupError("");
    setError("");
  }

  async function handleEventLookup() {
    if (!eventIdInput.trim()) return;
    setEventLookupLoading(true);
    setEventLookupError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            query LookupEvent($displayId: String!) {
              eventByDisplayId(displayId: $displayId) { id displayId name logoUrl }
            }
          `,
          variables: { displayId: eventIdInput.trim() },
        }),
      });
      const json = await res.json();
      if (json.errors || !json.data?.eventByDisplayId) {
        setEventLookupError("No event found with that ID.");
        setLinkedEvent(null);
      } else {
        setLinkedEvent(json.data.eventByDisplayId);
      }
    } catch {
      setEventLookupError("Something went wrong. Try again.");
    }

    setEventLookupLoading(false);
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
      formData.append("type", "tournament-logo");

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
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation UpdateTournamentDetails(
              $id: ID!, $logoUrl: String, $isOnlineOnly: Boolean, $address: String,
              $twitchUrl: String, $format: String, $capacity: Int,
              $entryFee: String, $prizePot: String, $eventId: ID
            ) {
              updateTournamentDetails(
                id: $id, logoUrl: $logoUrl, isOnlineOnly: $isOnlineOnly, address: $address,
                twitchUrl: $twitchUrl, format: $format, capacity: $capacity,
                entryFee: $entryFee, prizePot: $prizePot, eventId: $eventId
              ) { id }
            }
          `,
          variables: {
            id: tournamentId,
            logoUrl,
            isOnlineOnly,
            address: isOnlineOnly ? "" : address,
            twitchUrl,
            format,
            capacity: capacity ? Number(capacity) : null,
            entryFee,
            prizePot,
            eventId: linkedEvent?.id || "",
          },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to save tournament details");
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
          <div className="fgc-card p-6 w-full max-w-2xl flex flex-col" style={{ maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Tournament details</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              Logo, location, stream link, format, capacity, entry fee/prize pot — all display-only, shown on the detail page.
            </p>

            <div className="overflow-y-auto pr-1 -mr-1 flex-1 min-h-0">
              <div className="mb-4">
                <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Event ID</label>
                {linkedEvent ? (
                  <div className="flex items-center gap-3 px-3 py-2.5 rounded-md" style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}>
                    {linkedEvent.logoUrl && (
                      <div className="w-8 h-8 rounded overflow-hidden flex-shrink-0" style={{ border: "1px solid var(--border-strong)" }}>
                        <img src={linkedEvent.logoUrl} alt="" className="w-full h-full object-cover" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{linkedEvent.name}</p>
                      <p className="text-[10px] font-mono text-[var(--text-muted)]">{linkedEvent.displayId}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setLinkedEvent(null); setEventIdInput(""); }}
                      className="text-[11px] font-semibold px-2 py-1 rounded flex-shrink-0"
                      style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: "pointer" }}
                    >
                      Unlink
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={eventIdInput}
                        onChange={e => { setEventIdInput(e.target.value); setEventLookupError(""); }}
                        placeholder="e.g. EVT-000001"
                        className="flex-1 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                        style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                      />
                      <button
                        type="button"
                        onClick={handleEventLookup}
                        disabled={eventLookupLoading || !eventIdInput.trim()}
                        className="text-[12px] font-semibold px-3 py-2 rounded"
                        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: eventLookupLoading ? "not-allowed" : "pointer" }}
                      >
                        {eventLookupLoading ? "Looking up..." : "Look up"}
                      </button>
                    </div>
                    {eventLookupError && <p className="text-[12px] mt-1" style={{ color: "var(--coral)" }}>{eventLookupError}</p>}
                    <p className="text-[11px] text-[var(--text-muted)] mt-1">Link to a venue/series event to share its logo, location, and Twitch link.</p>
                  </>
                )}
              </div>

              {!linkedEvent && (
                <>
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
                </>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                {!linkedEvent && (
                  <div>
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
                )}
                <div>
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Format</label>
                  <input
                    type="text"
                    value={format}
                    onChange={e => setFormat(e.target.value)}
                    placeholder="e.g. Double Elimination"
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-2">
                <div>
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Capacity</label>
                  <input
                    type="number"
                    min={1}
                    value={capacity}
                    onChange={e => setCapacity(e.target.value)}
                    placeholder="e.g. 32"
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Entry fee</label>
                  <input
                    type="text"
                    value={entryFee}
                    onChange={e => setEntryFee(e.target.value)}
                    placeholder="e.g. $10"
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Prize pot</label>
                  <input
                    type="text"
                    value={prizePot}
                    onChange={e => setPrizePot(e.target.value)}
                    placeholder="e.g. $200"
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  />
                </div>
              </div>
            </div>

            {error && (
              <p className="text-[12px] mt-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2 mt-4">
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
