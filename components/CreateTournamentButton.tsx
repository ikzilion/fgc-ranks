// components/CreateTournamentButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

export function CreateTournamentButton() {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [game, setGame] = useState("");
  const [startDate, setStartDate] = useState("");
  // Metadata batch — all optional, display/informational only.
  const [logoUrl, setLogoUrl] = useState("");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [isOnlineOnly, setIsOnlineOnly] = useState(false);
  const [address, setAddress] = useState("");
  const [twitchUrl, setTwitchUrl] = useState("");
  const [format, setFormat] = useState("");
  const [capacity, setCapacity] = useState("");
  const [entryFee, setEntryFee] = useState("");
  const [prizePot, setPrizePot] = useState("");
  // Event ID linking — TO types a human-readable Event ID, we look it up
  // and show a confirmation preview before actually linking. Once linked,
  // this tournament's own logo/location/Twitch inputs are hidden since
  // those will display the linked Event's current values instead (see the
  // Tournament.address/logoUrl/twitchUrl field-resolver overrides).
  const [eventIdInput, setEventIdInput] = useState("");
  const [linkedEvent, setLinkedEvent] = useState<{ id: string; displayId: string; name: string; logoUrl?: string } | null>(null);
  const [eventLookupLoading, setEventLookupLoading] = useState(false);
  const [eventLookupError, setEventLookupError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Any signed-in player can create a tournament — they become its first
  // organizer automatically (see createTournament resolver).
  if (!session) return null;

  function resetForm() {
    setName("");
    setGame("");
    setStartDate("");
    setLogoUrl("");
    setIsOnlineOnly(false);
    setAddress("");
    setTwitchUrl("");
    setFormat("");
    setCapacity("");
    setEntryFee("");
    setPrizePot("");
    setEventIdInput("");
    setLinkedEvent(null);
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

  async function handleSubmit() {
    if (!name.trim() || !game.trim() || !startDate) {
      setError("Tournament name, game, and start date are required.");
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
            mutation CreateTournament(
              $name: String!, $game: String!, $startDate: Date!,
              $logoUrl: String, $isOnlineOnly: Boolean, $address: String,
              $twitchUrl: String, $format: String, $capacity: Int,
              $entryFee: String, $prizePot: String, $eventId: ID
            ) {
              createTournament(
                name: $name, game: $game, startDate: $startDate,
                logoUrl: $logoUrl, isOnlineOnly: $isOnlineOnly, address: $address,
                twitchUrl: $twitchUrl, format: $format, capacity: $capacity,
                entryFee: $entryFee, prizePot: $prizePot, eventId: $eventId
              ) { id }
            }
          `,
          variables: {
            name,
            game,
            startDate,
            logoUrl: logoUrl || undefined,
            isOnlineOnly,
            address: isOnlineOnly ? "" : address,
            twitchUrl: twitchUrl || undefined,
            format: format || undefined,
            capacity: capacity ? Number(capacity) : undefined,
            entryFee: entryFee || undefined,
            prizePot: prizePot || undefined,
            eventId: linkedEvent?.id || undefined,
          },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to create tournament");
      } else {
        setOpen(false);
        resetForm();
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
        className="font-rajdhani text-[13px] font-bold tracking-wide px-4 py-2 rounded"
        style={{ background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }}
      >
        + New tournament
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-2xl flex flex-col" style={{ maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">Create tournament</h2>

            {/* Same flex-1 min-h-0 scroll-region pattern as the Stream
                Settings modal — lets this reflow into a compact multi-
                column layout on a wide viewport without the modal itself
                growing past 90vh and pushing Create/Cancel off-screen. */}
            <div className="overflow-y-auto pr-1 -mr-1 flex-1 min-h-0">
              <div className="mb-4">
                <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Tournament name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Combo Breaker 2026"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Game</label>
                  <input
                    type="text"
                    value={game}
                    onChange={e => setGame(e.target.value)}
                    placeholder="e.g. Street Fighter 6"
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Start date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)", colorScheme: "dark" }}
                  />
                </div>
              </div>

              <div className="mb-4">
                <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Event ID (optional)</label>
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
                    <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Logo (optional)</label>
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
                    <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Twitch link (optional)</label>
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
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Format (optional)</label>
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
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Capacity (optional)</label>
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
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Entry fee (optional)</label>
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
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Prize pot (optional)</label>
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
                onClick={() => setOpen(false)}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading || uploadingLogo}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
              >
                {loading ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
