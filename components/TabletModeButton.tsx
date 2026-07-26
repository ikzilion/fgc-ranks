// components/TabletModeButton.tsx
// "Tablet/Phone Mode" — a touch-optimized live-event view for TOs, with two
// modes: Report match (scan both players' Player ID QR codes to find their
// real PENDING match, then report it via large touch targets — optionally
// through a Queue mode showing every ready-to-play match instead of
// scanning) and Add player (the former standalone ScanToAddPlayerButton,
// folded in here so a TO never has to leave the mode to seat a late
// walk-up entrant — see the removal note below). Both share ONE QR-camera
// implementation via lib/useQrScanner.ts instead of each rolling their own.
//
// No new backend logic anywhere: match-finding and the ready-to-play queue
// are pure client-side filters over the EXISTING matches(tournamentId)
// query (already returns every match for a tournament — standard bracket,
// pool matches, and pool-format main bracket alike, all keyed by the same
// tournamentId, no per-format branching needed); match-reporting reuses
// reportResult verbatim (same mutation ReportMatchButton calls); adding a
// player reuses addEntrantByOrganizer verbatim (same mutation the removed
// ScanToAddPlayerButton called). ReportMatchButton.tsx and the rest of the
// non-tablet UI are completely untouched.
//
// ScanToAddPlayerButton.tsx removed (not just superseded) now that its
// exact capability lives inside Tablet/Phone Mode: keeping both would mean
// two maintained UI entry points for the identical mutation and near-
// identical scan UX, in an already-crowded organizer button row, with the
// new in-overlay version being the more discoverable one anyway (it's part
// of the same "run your live event from here" surface as match-reporting).
//
// The scanner container below is rendered in exactly ONE place, shared by
// BOTH modes and both scan steps within Report mode — never two separate
// JSX copies of it, even ones sharing the same id string. html5-qrcode
// injects a live <video> into that exact DOM node; if two different JSX
// locations each rendered their own copy (e.g. one per mode), React would
// unmount/remount a brand-new node the instant `mode` (or the report
// scan-p1/scan-p2 step) changes while the camera session's `active` flag
// stays true across that change — silently killing the running camera,
// since useQrScanner's effect has no reason to rerun when its own
// dependencies haven't changed.
"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQrScanner } from "@/lib/useQrScanner";

const SCANNER_ELEMENT_ID = "tablet-phone-mode-scanner";
const RESULT_DISPLAY_MS = 2200;

interface MatchSummary {
  id: string;
  round: string;
  status: string;
  player1Score: number;
  player2Score: number;
  player1: { id: string; tag: string } | null;
  player2: { id: string; tag: string } | null;
}

type OverlayMode = "report" | "add-player";

type ReportScreen =
  | { kind: "idle" } // shown content depends on queueModeOn: queue list, or the scan-player-1 prompt
  | { kind: "scan-p2"; player1: { id: string; tag: string } }
  | { kind: "match-not-found"; tagA: string; tagB: string }
  | { kind: "report"; match: MatchSummary }
  | { kind: "reported"; text: string };

type AddPlayerScreen =
  | { kind: "scanning" }
  | { kind: "looking-up" }
  | { kind: "success"; tag: string; alreadyEntered: boolean }
  | { kind: "error"; message: string };

const MATCHES_QUERY = `
  query TabletModeMatches($tournamentId: ID!) {
    matches(tournamentId: $tournamentId) {
      id
      round
      status
      player1Score
      player2Score
      player1 { id tag }
      player2 { id tag }
    }
  }
`;

export function TabletModeButton({ tournamentId, canManage }: { tournamentId: string; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<OverlayMode>("report");
  const [queueModeOn, setQueueModeOn] = useState(false);
  const [reportScreen, setReportScreen] = useState<ReportScreen>({ kind: "idle" });
  const [addPlayerScreen, setAddPlayerScreen] = useState<AddPlayerScreen>({ kind: "scanning" });
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [scanError, setScanError] = useState("");

  // Read inside the QR decode callback via refs (not the state directly) —
  // the callback is created once per camera session by useQrScanner's
  // effect, which only reruns when `cameraActive` flips, not on every
  // render, so it needs a way to see the LATEST mode/screen/matches instead
  // of whatever they were when that camera session started (matters
  // concretely: fetchMatches() resolves asynchronously right after the
  // session starts, and mode/reportScreen change between scans).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const reportScreenRef = useRef(reportScreen);
  reportScreenRef.current = reportScreen;
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const readyMatches = matches.filter(m => m.status === "PENDING" && m.player1 && m.player2);

  // Report mode only needs the camera during its two scan steps (idle
  // without Queue mode, or scan-p2) — once it reaches match-not-found/
  // report/reported it tears down, same as before. Add player mode keeps
  // the camera running for its ENTIRE duration (matching the removed
  // ScanToAddPlayerButton's own scoping exactly) — pause()/resume() alone
  // handles "don't decode again while showing a result", no teardown
  // between scans, so the camera box stays visibly live with just a result
  // overlay on top for fast repeated walk-up check-ins.
  const cameraActive = mode === "report" ? !queueModeOn && (reportScreen.kind === "idle" || reportScreen.kind === "scan-p2") : true;

  const scanner = useQrScanner(
    SCANNER_ELEMENT_ID,
    open && cameraActive,
    text => handleScanned(text),
    () => setScanError("Couldn't access the camera. Check permissions and try again."),
    mode // force a fresh session when switching Report match <-> Add player, even though cameraActive stays true across that switch
  );

  if (!canManage) return null;

  async function fetchMatches() {
    setLoadingMatches(true);
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: MATCHES_QUERY, variables: { tournamentId } }),
      });
      const json = await res.json();
      setMatches(json.data?.matches ?? []);
    } catch {
      // Leave the previous list in place rather than clearing it on a
      // transient fetch failure — the queue/lookup just stays as-is.
    }
    setLoadingMatches(false);
  }

  function openTabletMode() {
    setMode("report");
    setQueueModeOn(false);
    setReportScreen({ kind: "idle" });
    setAddPlayerScreen({ kind: "scanning" });
    setScanError("");
    setOpen(true);
    fetchMatches();
  }

  function switchMode(next: OverlayMode) {
    setMode(next);
    setScanError("");
    setReportScreen({ kind: "idle" });
    setAddPlayerScreen({ kind: "scanning" });
  }

  async function lookupPlayer(displayId: string): Promise<{ id: string; tag: string } | null> {
    const res = await fetch("/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query PlayerByDisplayId($displayId: String!) { playerByDisplayId(displayId: $displayId) { id tag } }`,
        variables: { displayId },
      }),
    });
    const json = await res.json();
    return json.data?.playerByDisplayId ?? null;
  }

  // Returns the underlying promise (not fire-and-forget) — useQrScanner
  // holds its re-entrancy guard until this actually settles, not just until
  // this function returns, so a near-simultaneous decode of the same
  // still-in-frame code can't slip through as a second "scan" before the
  // lookup/processing for the first one has even finished.
  function handleScanned(decodedText: string) {
    if (modeRef.current === "add-player") {
      return handleAddPlayerScanned(decodedText);
    }
    return handleReportScanned(decodedText);
  }

  async function handleReportScanned(decodedText: string) {
    const currentScreen = reportScreenRef.current;
    const player = await lookupPlayer(decodedText);
    if (!player) {
      setScanError("QR code not recognized as a valid Player ID.");
      setTimeout(() => setScanError(""), RESULT_DISPLAY_MS);
      scanner.resume();
      return;
    }

    if (currentScreen.kind === "idle") {
      // First scan
      setScanError("");
      setReportScreen({ kind: "scan-p2", player1: player });
      scanner.resume();
      return;
    }

    if (currentScreen.kind === "scan-p2") {
      const p1 = currentScreen.player1;
      const currentReadyMatches = matchesRef.current.filter(m => m.status === "PENDING" && m.player1 && m.player2);
      const match = currentReadyMatches.find(
        m =>
          (m.player1!.id === p1.id && m.player2!.id === player.id) ||
          (m.player1!.id === player.id && m.player2!.id === p1.id)
      );
      if (!match) {
        setReportScreen({ kind: "match-not-found", tagA: p1.tag, tagB: player.tag });
        return;
      }
      setReportScreen({ kind: "report", match });
    }
  }

  async function submitResult(match: MatchSummary, winnerId: string, p1Score: number, p2Score: number) {
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation TabletReportResult($matchId: ID!, $player1Score: Int, $player2Score: Int) {
              reportResult(matchId: $matchId, player1Score: $player1Score, player2Score: $player2Score) {
                id
                winner { tag }
              }
            }
          `,
          variables: { matchId: match.id, player1Score: p1Score, player2Score: p2Score },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        setReportScreen({ kind: "reported", text: json.errors[0]?.message ?? "Failed to report result." });
      } else {
        const winnerTag = json.data.reportResult.winner?.tag ?? "Winner";
        const loserTag = winnerId === match.player1!.id ? match.player2!.tag : match.player1!.tag;
        const [winScore, loseScore] = winnerId === match.player1!.id ? [p1Score, p2Score] : [p2Score, p1Score];
        setReportScreen({ kind: "reported", text: `✓ ${winnerTag} defeats ${loserTag} (${winScore}-${loseScore})` });
      }
    } catch {
      setReportScreen({ kind: "reported", text: "Something went wrong. Try again." });
    }

    router.refresh();
    await fetchMatches();
    setTimeout(() => {
      setReportScreen({ kind: "idle" });
    }, RESULT_DISPLAY_MS);
  }

  async function handleAddPlayerScanned(decodedText: string) {
    setAddPlayerScreen({ kind: "looking-up" });

    try {
      const player = await lookupPlayer(decodedText);
      if (!player) {
        finishAddPlayer({ kind: "error", message: "QR code not recognized as a valid Player ID." });
        return;
      }

      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation AddEntrantByOrganizer($tournamentId: ID!, $playerId: ID!) {
              addEntrantByOrganizer(tournamentId: $tournamentId, playerId: $playerId) {
                alreadyEntered
                entrant { id }
              }
            }
          `,
          variables: { tournamentId, playerId: player.id },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        finishAddPlayer({ kind: "error", message: json.errors[0]?.message ?? "Failed to add player." });
        return;
      }

      finishAddPlayer({ kind: "success", tag: player.tag, alreadyEntered: json.data.addEntrantByOrganizer.alreadyEntered });
    } catch {
      finishAddPlayer({ kind: "error", message: "Something went wrong. Try again." });
    }
  }

  function finishAddPlayer(result: AddPlayerScreen) {
    setAddPlayerScreen(result);
    router.refresh();
    setTimeout(() => {
      setAddPlayerScreen({ kind: "scanning" });
      scanner.resume();
    }, RESULT_DISPLAY_MS);
  }

  return (
    <>
      {/* Big/prominent entry point — same card pattern as the Streamer Mode
          button next to it in the tournament header, not a small inline
          button, so the two have matching visual weight. */}
      <button
        onClick={openTabletMode}
        className="fgc-card p-6 sm:w-56 flex-shrink-0 flex flex-col items-center justify-center gap-2 text-center hover:bg-[var(--navy-3)] transition-colors"
        style={{ cursor: "pointer" }}
      >
        <span className="text-4xl">📱</span>
        <span className="font-rajdhani text-lg font-bold text-[var(--text-primary)]">Tablet/Phone Mode</span>
        <span className="text-[11px] text-[var(--text-secondary)]">Report matches &amp; add players, touch-optimized</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[9999] flex flex-col" style={{ background: "var(--navy)" }}>
          {/* Header row 1 — title + exit */}
          <div className="flex items-center justify-between gap-3 px-4 pt-4 flex-shrink-0">
            <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">📱 Tablet/Phone Mode</h1>
            <button
              onClick={() => setOpen(false)}
              className="font-rajdhani text-[16px] font-bold px-4 py-3 rounded-lg"
              style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.3)", cursor: "pointer" }}
            >
              Exit
            </button>
          </div>

          {/* Header row 2 — mode tabs + (Report mode only) Queue mode toggle */}
          <div className="flex items-center justify-between gap-3 p-4 flex-shrink-0" style={{ borderBottom: "1px solid var(--border-strong)" }}>
            <div className="flex items-center gap-3">
              <button
                onClick={() => switchMode("report")}
                className="font-rajdhani text-[16px] font-bold px-4 py-3 rounded-lg"
                style={{
                  background: mode === "report" ? "var(--blue)" : "var(--navy-4)",
                  color: mode === "report" ? "white" : "var(--text-secondary)",
                  border: "1px solid var(--border-strong)",
                  cursor: "pointer",
                }}
              >
                🎮 Report match
              </button>
              <button
                onClick={() => switchMode("add-player")}
                className="font-rajdhani text-[16px] font-bold px-4 py-3 rounded-lg"
                style={{
                  background: mode === "add-player" ? "var(--blue)" : "var(--navy-4)",
                  color: mode === "add-player" ? "white" : "var(--text-secondary)",
                  border: "1px solid var(--border-strong)",
                  cursor: "pointer",
                }}
              >
                ➕ Add player
              </button>
            </div>

            {mode === "report" && (
              <button
                onClick={() => {
                  setQueueModeOn(v => !v);
                  setReportScreen({ kind: "idle" });
                }}
                className="font-rajdhani text-[16px] font-bold px-4 py-3 rounded-lg"
                style={{
                  background: queueModeOn ? "var(--blue)" : "var(--navy-4)",
                  color: queueModeOn ? "white" : "var(--text-secondary)",
                  border: "1px solid var(--border-strong)",
                  cursor: "pointer",
                }}
              >
                Queue mode: {queueModeOn ? "ON" : "OFF"}
              </button>
            )}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center">
            {/* Non-camera content — mutually exclusive with the shared
                camera block below (cameraActive is false whenever one of
                these is showing). */}
            {mode === "report" && reportScreen.kind === "reported" && (
              <div className="flex-1 flex items-center justify-center w-full">
                <p className="text-center font-rajdhani text-3xl font-bold" style={{ color: "var(--green)" }}>{reportScreen.text}</p>
              </div>
            )}

            {mode === "report" && reportScreen.kind === "report" && (
              <ReportScreenBody match={reportScreen.match} onSubmit={submitResult} onCancel={() => setReportScreen({ kind: "idle" })} />
            )}

            {mode === "report" && reportScreen.kind === "match-not-found" && (
              <div className="flex-1 flex flex-col items-center justify-center gap-6 w-full text-center">
                <p className="font-rajdhani text-2xl font-bold" style={{ color: "var(--coral)" }}>
                  No pending match found between {reportScreen.tagA} and {reportScreen.tagB}.
                </p>
                <button
                  onClick={() => setReportScreen({ kind: "idle" })}
                  className="font-rajdhani text-xl font-bold px-8 py-4 rounded-lg"
                  style={{ background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }}
                >
                  Try again
                </button>
              </div>
            )}

            {mode === "report" && reportScreen.kind === "idle" && queueModeOn && (
              <QueueScreen matches={readyMatches} loading={loadingMatches} onPick={m => setReportScreen({ kind: "report", match: m })} />
            )}

            {/* THE one shared scanner block — see the file-level comment for
                why this must never be duplicated across mode/screen JSX
                branches. Label text and (add-player mode only) the result
                overlay vary by mode/screen; the container itself doesn't. */}
            {cameraActive && (
              <div className="w-full max-w-sm text-center">
                {mode === "report" ? (
                  reportScreen.kind === "scan-p2" ? (
                    <>
                      <p className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-1">✓ {reportScreen.player1.tag}</p>
                      <p className="font-rajdhani text-xl font-bold text-[var(--text-secondary)] mb-4">Now scan Player 2's QR code</p>
                    </>
                  ) : (
                    <>
                      <p className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-2">Scan Player 1's QR code</p>
                      <p className="text-[13px] text-[var(--text-secondary)] mb-4">Then Player 2's — the match between them will be found automatically.</p>
                    </>
                  )
                ) : (
                  <>
                    <p className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-2">Scan a player's QR code</p>
                    <p className="text-[13px] text-[var(--text-secondary)] mb-4">
                      Point the camera at a player's Player ID QR code (from their profile page) to add them to this tournament.
                    </p>
                  </>
                )}

                <div className="relative rounded-lg overflow-hidden" style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)", minHeight: 280 }}>
                  <div id={SCANNER_ELEMENT_ID} />

                  {/* Add player mode keeps the camera box visible with a
                      result overlay on top (matching the removed
                      ScanToAddPlayerButton's exact UX) instead of leaving
                      the screen entirely, for fast repeated check-ins. */}
                  {mode === "add-player" && addPlayerScreen.kind !== "scanning" && (
                    <div className="absolute inset-0 flex items-center justify-center text-center p-4" style={{ background: "rgba(10,14,26,0.92)" }}>
                      {addPlayerScreen.kind === "looking-up" && <p className="text-[14px] text-[var(--text-secondary)]">Looking up player...</p>}
                      {addPlayerScreen.kind === "success" && (
                        <p className="font-rajdhani text-xl font-bold" style={{ color: addPlayerScreen.alreadyEntered ? "var(--gold)" : "var(--green)" }}>
                          {addPlayerScreen.alreadyEntered ? `${addPlayerScreen.tag} is already entered.` : `✓ Added ${addPlayerScreen.tag}`}
                        </p>
                      )}
                      {addPlayerScreen.kind === "error" && <p className="text-[14px]" style={{ color: "var(--coral)" }}>{addPlayerScreen.message}</p>}
                    </div>
                  )}
                </div>
                {scanError && <p className="mt-4 text-[14px] font-semibold" style={{ color: "var(--coral)" }}>{scanError}</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// Ready-to-play queue — Queue mode ON. Large touch rows; tapping one goes
// straight to reporting (the match is already unambiguous, no QR scan
// needed for a queue-driven pick).
function QueueScreen({ matches, loading, onPick }: { matches: MatchSummary[]; loading: boolean; onPick: (m: MatchSummary) => void }) {
  return (
    <div className="w-full max-w-md">
      <p className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4 text-center">
        {loading ? "Loading..." : `${matches.length} match${matches.length === 1 ? "" : "es"} ready to play`}
      </p>
      {!loading && matches.length === 0 && (
        <p className="text-center text-[14px] text-[var(--text-secondary)]">No matches are ready to play right now.</p>
      )}
      <div className="flex flex-col gap-3">
        {matches.map(m => (
          <button
            key={m.id}
            onClick={() => onPick(m)}
            className="w-full text-left px-5 py-4 rounded-lg fgc-card"
            style={{ cursor: "pointer" }}
          >
            <p className="text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-1">{m.round}</p>
            <p className="font-rajdhani text-xl font-bold text-[var(--text-primary)]">
              {m.player1!.tag} <span style={{ color: "var(--text-muted)" }}>vs</span> {m.player2!.tag}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

// Large-touch-target result entry — pick winner, then adjust the score with
// big steppers (defaults to a minimal valid 1-0 the moment a winner is
// picked, so Confirm is immediately submittable for a quick single-game
// report, still adjustable for a real best-of-X score). Forfeit reporting
// is intentionally NOT duplicated here — the settled design describes
// "pick winner, enter score" only; the normal ReportMatchButton flow still
// covers the forfeit edge case if ever needed mid-event.
function ReportScreenBody({
  match,
  onSubmit,
  onCancel,
}: {
  match: MatchSummary;
  onSubmit: (match: MatchSummary, winnerId: string, p1Score: number, p2Score: number) => void;
  onCancel: () => void;
}) {
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const p1 = match.player1!;
  const p2 = match.player2!;

  function pickWinner(id: string) {
    setWinnerId(id);
    setP1Score(id === p1.id ? 1 : 0);
    setP2Score(id === p2.id ? 1 : 0);
  }

  return (
    <div className="w-full max-w-md">
      <p className="text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-4 text-center">{match.round}</p>

      <div className="grid grid-cols-2 gap-4 mb-6">
        {[p1, p2].map(p => (
          <button
            key={p.id}
            onClick={() => pickWinner(p.id)}
            className="py-8 rounded-xl font-rajdhani text-2xl font-bold"
            style={
              winnerId === p.id
                ? { background: "var(--green-dim)", color: "var(--green)", border: "2px solid var(--green)", cursor: "pointer" }
                : { background: "var(--navy-4)", color: "var(--text-primary)", border: "2px solid var(--border-strong)", cursor: "pointer" }
            }
          >
            {p.tag}
            <br />
            <span className="text-[13px] font-normal">{winnerId === p.id ? "WINNER" : "tap to pick winner"}</span>
          </button>
        ))}
      </div>

      {winnerId && (
        <div className="flex items-center justify-center gap-8 mb-8">
          <ScoreStepper label={p1.tag} value={p1Score} onChange={setP1Score} />
          <span className="font-rajdhani text-3xl font-bold text-[var(--text-muted)]">–</span>
          <ScoreStepper label={p2.tag} value={p2Score} onChange={setP2Score} />
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 py-4 rounded-lg font-rajdhani text-lg font-bold"
          style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
        >
          Cancel
        </button>
        <button
          onClick={() => {
            if (!winnerId || submitting) return;
            setSubmitting(true);
            onSubmit(match, winnerId, p1Score, p2Score);
          }}
          disabled={!winnerId || p1Score === p2Score || submitting}
          className="flex-1 py-4 rounded-lg font-rajdhani text-lg font-bold"
          style={{
            background: "var(--blue)",
            color: "white",
            border: "none",
            cursor: !winnerId || p1Score === p2Score || submitting ? "not-allowed" : "pointer",
            opacity: !winnerId || p1Score === p2Score || submitting ? 0.5 : 1,
          }}
        >
          {submitting ? "Saving..." : "Confirm"}
        </button>
      </div>
    </div>
  );
}

function ScoreStepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-[12px] text-[var(--text-secondary)] font-semibold">{label}</span>
      <div className="flex items-center gap-3">
        <button
          onClick={() => onChange(Math.max(0, value - 1))}
          className="font-rajdhani text-2xl font-bold"
          style={{ width: 48, height: 48, borderRadius: 10, background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border)", cursor: "pointer" }}
        >
          −
        </button>
        <span className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] w-8 text-center">{value}</span>
        <button
          onClick={() => onChange(value + 1)}
          className="font-rajdhani text-2xl font-bold"
          style={{ width: 48, height: 48, borderRadius: 10, background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border)", cursor: "pointer" }}
        >
          +
        </button>
      </div>
    </div>
  );
}
