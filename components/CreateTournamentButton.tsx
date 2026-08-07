// components/CreateTournamentButton.tsx
"use client";

import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { maxUploadBytes, formatMaxSizeLabel } from "@/lib/uploadLimits";
import { isAdminOrAbove } from "@/lib/roles";

// Sentinel dropdown value that reveals the free-text "type your own" input
// below the Game select — a custom-typed value is never auto-added as a
// curated Game (see createTournament's game: String! argument, unchanged),
// it just stays a plain Tournament.game string, same as the pre-existing
// "orphan" entries the games resolver already merges into the Games list.
const OTHER_GAME = "__other__";

// Per-format plain-language explanation, so a TO can compare "Standard
// Bracket" vs. "Pools + Bracket" without leaving the form. A native
// <select>'s own <option> elements can't host custom hover/tap content (no
// browser lets you style inside one), so this renders as its own small
// legend row right under the dropdown instead of literally inside it —
// same practical effect, one toggle per format name.
//
// FIX (real user testing, follow-up to commit 6df889c): the first cut
// rendered the explanation as normal in-flow content below the trigger,
// which grew that flex item's height and pushed every field below it down
// the page -- and the resulting reflow was very likely what caused "Pools +
// Bracket" to flicker open/closed on hover (its longer text pushed content
// under/near the cursor, plausibly re-triggering mouseenter/mouseleave).
// Rebuilt as a `position: fixed` overlay positioned from the trigger's own
// getBoundingClientRect(): fixed positioning is removed from the normal
// flow ENTIRELY by definition (zero layout shift is structurally
// guaranteed, not just avoided by convention), and -- unlike `absolute` --
// isn't clipped by the create-tournament modal's own `.fgc-card`
// (`overflow: hidden`, see app/globals.css) since a fixed box escapes to
// the viewport as its containing block rather than any scrollable/clipped
// ancestor (confirmed no ancestor here sets transform/filter/will-change,
// which is the one thing that would trap a fixed descendant instead).
// `pointer-events: none` on the bubble itself means the cursor can never
// actually enter it, which structurally rules out the "hovering the
// tooltip re-triggers the trigger's hover" failure mode entirely, rather
// than trying to patch around it.
//
// Deliberately does NOT track/close on page scroll while open (tried it,
// reverted it): Playwright's own auto-scroll-into-view before every
// `.click()` action fired a real "scroll" event mid-interaction, which a
// scroll-close listener picked up and used to clear `pinned` a moment
// before the click handler's own toggle ran -- net effect, a second real
// tap looked like it reopened the tooltip instead of closing it, an
// entirely self-inflicted bug from a feature this task never asked for.
// The tradeoff accepted instead: if the user scrolls the modal's content
// while the tooltip is open, it stays anchored to its last computed
// position rather than tracking the trigger -- a minor cosmetic
// "detachment," not a layout-shift or flicker bug, and hover/tap already
// closes it on the next interaction regardless.
//
// Hover (desktop) previews via real onMouseEnter/onMouseLeave, tracked
// separately from a click-driven `pinned` state (tap-to-toggle, for touch
// devices where hover doesn't apply) -- NOT plain CSS `:hover`, because a
// click while the mouse is still resting on the trigger needs to be able to
// close it even though the pointer hasn't moved (confirmed necessary: a
// CSS-hover-only version stayed visibly open after a same-position click
// toggled its own state off, since the hover rule alone kept it showing).
// A click always unconditionally flips `pinned` AND forces `hovering` false
// in the same handler, rather than branching on the current `visible` value
// -- confirmed via a real touch-emulated Playwright context that a browser
// synthesizes a full mouseenter/mousedown/mouseup/click sequence for each
// discrete tap, including a stray leftover `mouseleave` right as the NEXT
// tap begins (cleanup from the previous tap's synthetic hover). Critically,
// `onMouseLeave` here only clears `hovering`, never `pinned` -- an earlier
// version also cleared `pinned` on mouseleave, which meant that stray
// between-taps mouseleave silently closed a tap-opened tooltip a split
// second before the second tap's own click handler ran, making a real
// second tap look like it "reopened" it instead of closing it. Once a
// click has explicitly pinned it open, only another click should ever
// close it -- an incidental mouseleave (real or synthetic) shouldn't.
const FORMAT_INFO: Record<string, string> = {
  "Standard Bracket":
    "Every entrant goes straight into one double-elimination bracket. Best for smaller events — works well up to a few hundred entrants, but with a large field, everyone has to wait through many rounds before eliminations really thin out.",
  "Pools + Bracket":
    "Entrants are split into smaller pools first, each playing out as its own mini double-elimination bracket. The top 2 finishers from each pool then advance into a final bracket. This gets everyone playing matches faster in a large tournament, the same way major fighting game tournaments run big brackets.",
};

const TOOLTIP_WIDTH = 240;
const TOOLTIP_MARGIN = 8;
// Rough estimate of the rendered bubble's height, used only to decide
// whether it should open above or below the trigger before the real
// element has ever been painted -- doesn't need to be exact (an
// underestimate just means it occasionally opens downward with slightly
// less clearance than ideal, never a layout bug either way, since a fixed
// overlay never affects surrounding layout regardless of which side it's
// drawn on).
const TOOLTIP_EST_HEIGHT = 110;

function FormatInfoToggle({ label }: { label: string }) {
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const visible = hovering || pinned;

  // Computed fresh every time it opens (not just once) via the trigger's
  // OWN getBoundingClientRect(), so it's correct regardless of where the
  // trigger currently sits on the page.
  useLayoutEffect(() => {
    if (!visible || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    let left = rect.left;
    if (left + TOOLTIP_WIDTH > window.innerWidth - TOOLTIP_MARGIN) left = window.innerWidth - TOOLTIP_WIDTH - TOOLTIP_MARGIN;
    if (left < TOOLTIP_MARGIN) left = TOOLTIP_MARGIN;

    const opensBelow = rect.bottom + TOOLTIP_EST_HEIGHT + TOOLTIP_MARGIN <= window.innerHeight;
    const top = opensBelow ? rect.bottom + 6 : rect.top - TOOLTIP_EST_HEIGHT - 6;
    setCoords({ top, left });
  }, [visible]);

  function handleClick() {
    setPinned(v => !v);
    setHovering(false);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        aria-expanded={visible}
        aria-label={`What is ${label}?`}
        className="inline-flex items-center gap-1.5 text-[11px] w-fit"
        style={{ background: "none", border: "none", padding: 0, color: "var(--text-secondary)", cursor: "pointer" }}
      >
        <span
          className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0"
          style={{
            background: visible ? "var(--blue)" : "var(--navy-4)",
            color: visible ? "white" : "var(--text-muted)",
            border: "1px solid var(--border-strong)",
            lineHeight: 1,
          }}
        >
          i
        </span>
        {label}
      </button>
      {visible && coords && (
        <div
          role="tooltip"
          className="fixed z-[70] pointer-events-none text-[11px] leading-relaxed"
          style={{
            top: coords.top,
            left: coords.left,
            width: TOOLTIP_WIDTH,
            background: "var(--navy-3)",
            border: "1px solid var(--border-strong)",
            color: "var(--text-secondary)",
            borderRadius: 8,
            padding: 12,
            boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
          }}
        >
          {FORMAT_INFO[label]}
        </div>
      )}
    </>
  );
}

export function CreateTournamentButton() {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [game, setGame] = useState("");
  const [customGame, setCustomGame] = useState("");
  // Curated Games list for the dropdown below — fetched once on mount
  // rather than gated behind `open`, so the dropdown is ready the instant
  // the modal opens instead of showing an empty flash first.
  const [games, setGames] = useState<{ id: string; name: string }[]>([]);
  const [startDate, setStartDate] = useState("");
  // Metadata batch — all optional, display/informational only.
  const [logoUrl, setLogoUrl] = useState("");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [isOnlineOnly, setIsOnlineOnly] = useState(false);
  const [address, setAddress] = useState("");
  const [twitchUrl, setTwitchUrl] = useState("");
  // First time `format` actually changes tournament behavior (previously
  // display-only free text) — see the Pool play + top-cut Implementation
  // Plan. "Standard Bracket" keeps today's exact existing behavior.
  const [format, setFormat] = useState("Standard Bracket");
  // Pool format Model A/B/C — only meaningful when format is "Pools +
  // Bracket" (see the picker below). "C" is the existing/default model, so
  // this defaulting to it keeps every other format's behavior unchanged.
  const [poolModel, setPoolModel] = useState<"A" | "B" | "C">("C");
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

  useEffect(() => {
    fetch("/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query GetGamesForDropdown { games { id name } }` }),
    })
      .then(res => res.json())
      .then(json => setGames(json.data?.games ?? []))
      .catch(() => {});
  }, []);

  // Any signed-in player can create a tournament — they become its first
  // organizer automatically (see createTournament resolver).
  if (!session) return null;

  function resetForm() {
    setName("");
    setGame("");
    setCustomGame("");
    setStartDate("");
    setLogoUrl("");
    setIsOnlineOnly(false);
    setAddress("");
    setTwitchUrl("");
    setFormat("");
    setPoolModel("C");
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

    const maxBytes = maxUploadBytes("tournament-logo");
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
    // The dropdown's OTHER_GAME sentinel is never itself a valid game value
    // — the actual value to persist is whatever was typed into the reveal
    // input below it. Tournament.game stays a plain string either way; a
    // custom-typed one is never turned into a curated Game document (see
    // createTournament's game: String! argument, unchanged).
    const effectiveGame = game === OTHER_GAME ? customGame.trim() : game;
    if (!name.trim() || !effectiveGame || !startDate) {
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
              $entryFee: String, $prizePot: String, $eventId: ID,
              $poolModel: PoolModel
            ) {
              createTournament(
                name: $name, game: $game, startDate: $startDate,
                logoUrl: $logoUrl, isOnlineOnly: $isOnlineOnly, address: $address,
                twitchUrl: $twitchUrl, format: $format, capacity: $capacity,
                entryFee: $entryFee, prizePot: $prizePot, eventId: $eventId,
                poolModel: $poolModel
              ) { id }
            }
          `,
          variables: {
            name,
            game: effectiveGame,
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
            poolModel: format === "Pools + Bracket" ? poolModel : undefined,
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
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Create tournament</h2>

            {/* TO permission overhaul — informs the creator up front rather
                than surprising them after creation. Reads straight off the
                session (already fetched via useSession above) — isTO/role
                are carried through the JWT the same way, no extra query. */}
            {!isAdminOrAbove((session?.user as any)?.role) && !(session?.user as any)?.isTO && (
              <p className="text-[12px] mb-4" style={{ color: "var(--text-muted)" }}>
                You don't have TO status yet, so this tournament will be created private (invite-only), without stream background/sponsor banner options, and its matches won't count toward ranking points. Request TO status from your profile to remove these restrictions on future tournaments.
              </p>
            )}

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
                  <select
                    value={game}
                    onChange={e => setGame(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  >
                    <option value="">Select a game…</option>
                    <option value={OTHER_GAME}>Other (type your own)</option>
                    {games.map(g => (
                      <option key={g.id} value={g.name}>{g.name}</option>
                    ))}
                  </select>
                  {/* Not added as a curated Game — stays a plain
                      Tournament.game string, same as any pre-existing
                      un-curated value (see the games resolver's "orphan"
                      entries). An admin can still curate it later from
                      /admin/games if they choose to. */}
                  {game === OTHER_GAME && (
                    <input
                      type="text"
                      value={customGame}
                      onChange={e => setCustomGame(e.target.value)}
                      placeholder="Type the game name"
                      autoFocus
                      className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)] mt-2"
                      style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                    />
                  )}
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
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Format</label>
                  <select
                    value={format}
                    onChange={e => setFormat(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  >
                    <option value="Standard Bracket">Standard Bracket</option>
                    <option value="Pools + Bracket">Pools + Bracket</option>
                  </select>
                  <div className="flex flex-wrap gap-4 mt-1.5">
                    <FormatInfoToggle label="Standard Bracket" />
                    <FormatInfoToggle label="Pools + Bracket" />
                  </div>
                  {format === "Pools + Bracket" && (
                    <p className="text-[11px] text-[var(--text-secondary)] mt-1.5">
                      Entrants play in pools first — the top 2 per pool advance to a main bracket once every pool finishes. Pick how the pool stage itself works below.
                    </p>
                  )}
                </div>
              </div>

              {/* Pool format Model A/B/C — only shown once "Pools + Bracket"
                  is picked above. Each option gets its own plain-language
                  explanation since the three models have real gameplay
                  tradeoffs a TO can't tell from the name alone. Model B needs
                  a large field (128+ entrants) to be worth its extra
                  complexity — see models/Tournament.ts's PoolModel enum. */}
              {format === "Pools + Bracket" && (
                <div className="mb-4">
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Pool stage model</label>
                  <div className="flex flex-col gap-2">
                    {(
                      [
                        {
                          value: "A" as const,
                          label: "Model A — Round-robin pools",
                          description: "Every entrant plays every other pool member once. Fair and simple, but a pool loss carries no consequence into the main bracket — everyone gets a clean restart. Best for smaller or faster-moving events.",
                        },
                        {
                          value: "B" as const,
                          label: "Model B — Continuous carry-over",
                          description: "Massive-scale continuous double-elimination pools: pool results carry over into fresh, re-grouped pools across several rounds instead of resetting once. Needs at least 128 entrants — for anything smaller, Model A or C already give you the same result more simply.",
                        },
                        {
                          value: "C" as const,
                          label: "Model C — Double-elim pools (default)",
                          description: "Each pool is its own mini double-elimination bracket, so pools have real stakes — a 2nd loss eliminates you from the pool. Still a clean slate once you reach the main bracket.",
                        },
                      ]
                    ).map(option => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setPoolModel(option.value)}
                        className="text-left px-3 py-2.5 rounded-md"
                        style={{
                          background: poolModel === option.value ? "var(--blue-dim)" : "var(--navy-3)",
                          border: poolModel === option.value ? "1px solid var(--blue)" : "1px solid var(--border-strong)",
                          cursor: "pointer",
                        }}
                      >
                        <p className="font-rajdhani text-[14px] font-bold" style={{ color: "var(--text-primary)" }}>
                          {option.label}
                        </p>
                        <p className="text-[11px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{option.description}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

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
