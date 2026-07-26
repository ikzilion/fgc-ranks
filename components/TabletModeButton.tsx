// components/TabletModeButton.tsx
// "Tablet Mode" — a touch-optimized match-reporting view for TOs running a
// live event, especially the many-matches-at-once Pool play + top-cut
// format. A toggleable full-screen overlay on the EXISTING tournament page
// (not a separate route). Core flow: scan both players' Player ID QR codes
// (the exact same html5-qrcode approach ScanToAddPlayerButton/QR-based
// check-in already uses — same config, same pause/resume pattern,
// deliberately not extracted into a shared component since the two flows
// diverge enough downstream) to find their real PENDING match, then report
// it via large touch targets. No new backend logic: match-finding and the
// "ready to play" queue are pure client-side filters over the EXISTING
// matches(tournamentId) query (already returns every match for a
// tournament — standard bracket, pool matches, and pool-format main
// bracket alike, all keyed by the same tournamentId, so no per-format
// branching is needed here), and reporting reuses reportResult verbatim —
// same mutation ReportMatchButton already calls. That component and the
// rest of the normal (non-tablet) reporting UI are completely untouched.
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";

const SCANNER_ELEMENT_ID = "tablet-mode-scanner";
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

type Screen =
  | { kind: "idle" } // shown content depends on queueModeOn: queue list, or the scan-player-1 prompt
  | { kind: "scan-p2"; player1: { id: string; tag: string } }
  | { kind: "match-not-found"; tagA: string; tagB: string }
  | { kind: "report"; match: MatchSummary }
  | { kind: "reported"; text: string };

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
  const [queueModeOn, setQueueModeOn] = useState(false);
  const [screen, setScreen] = useState<Screen>({ kind: "idle" });
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [scanError, setScanError] = useState("");

  // Read inside the QR decode callback via refs (not the `screen`/`matches`
  // state directly) so the callback — created once per camera session by
  // the effect below, which only reruns on open/scanningActive changes, not
  // on every render — always sees the current step and the latest fetched
  // matches instead of a stale closure from whenever the effect first ran
  // (matters concretely: fetchMatches() resolves asynchronously right after
  // the camera session starts).
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);

  if (!canManage) return null;

  const readyMatches = matches.filter(m => m.status === "PENDING" && m.player1 && m.player2);

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
    setQueueModeOn(false);
    setScreen({ kind: "idle" });
    setScanError("");
    setOpen(true);
    fetchMatches();
  }

  function closeTabletMode() {
    setOpen(false);
  }

  // --- Camera: one continuous session across both scan steps -----------
  const scanningActive = screen.kind === "idle" && !queueModeOn ? true : screen.kind === "scan-p2";

  useEffect(() => {
    if (!open || !scanningActive) return;

    let cancelled = false;
    const scanner = new Html5Qrcode(SCANNER_ELEMENT_ID);
    scannerRef.current = scanner;

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        decodedText => {
          if (cancelled || processingRef.current) return;
          processingRef.current = true;
          scanner.pause(true);
          handleScanned(decodedText.trim()).finally(() => {
            processingRef.current = false;
          });
        },
        () => {} // per-frame "nothing found" — expected, not an error
      )
      .catch(() => setScanError("Couldn't access the camera. Check permissions and try again."));

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (!s) return;
      // clear() throws SYNCHRONOUSLY (not a rejected promise) if html5-qrcode's
      // internal state doesn't agree this scanner has actually stopped yet —
      // can happen here specifically because this component transitions
      // screens (and so tears the camera down) immediately on a decode, right
      // after pause(), a tighter race than a modal-close-driven teardown ever
      // hits. Both stop() and clear() are wrapped so neither can ever throw
      // uncaught into this effect's cleanup regardless of internal state.
      const stopPromise = s.isScanning ? s.stop().catch(() => {}) : Promise.resolve();
      stopPromise.then(() => {
        try {
          s.clear();
        } catch {
          // Already cleared, or never fully initialized -- fine either way.
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scanningActive]);

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

  async function handleScanned(decodedText: string) {
    const currentScreen = screenRef.current;
    const player = await lookupPlayer(decodedText);
    if (!player) {
      setScanError("QR code not recognized as a valid Player ID.");
      setTimeout(() => setScanError(""), RESULT_DISPLAY_MS);
      scannerRef.current?.resume();
      return;
    }

    if (currentScreen.kind === "idle") {
      // First scan
      setScanError("");
      setScreen({ kind: "scan-p2", player1: player });
      scannerRef.current?.resume();
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
        setScreen({ kind: "match-not-found", tagA: p1.tag, tagB: player.tag });
        return;
      }
      setScreen({ kind: "report", match });
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
        setScreen({ kind: "reported", text: json.errors[0]?.message ?? "Failed to report result." });
      } else {
        const winnerTag = json.data.reportResult.winner?.tag ?? "Winner";
        const loserTag = winnerId === match.player1!.id ? match.player2!.tag : match.player1!.tag;
        const [winScore, loseScore] = winnerId === match.player1!.id ? [p1Score, p2Score] : [p2Score, p1Score];
        setScreen({ kind: "reported", text: `✓ ${winnerTag} defeats ${loserTag} (${winScore}-${loseScore})` });
      }
    } catch {
      setScreen({ kind: "reported", text: "Something went wrong. Try again." });
    }

    router.refresh();
    await fetchMatches();
    setTimeout(() => {
      setScreen({ kind: "idle" });
      if (!queueModeOn) scannerRef.current?.resume();
    }, RESULT_DISPLAY_MS);
  }

  return (
    <>
      <button
        onClick={openTabletMode}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        📱 Tablet Mode
      </button>

      {open && (
        <div className="fixed inset-0 z-[9999] flex flex-col" style={{ background: "var(--navy)" }}>
          {/* Header — big, thumb-reachable controls: exit + the queue toggle */}
          <div className="flex items-center justify-between gap-3 p-4 flex-shrink-0" style={{ borderBottom: "1px solid var(--border-strong)" }}>
            <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">📱 Tablet Mode</h1>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setQueueModeOn(v => !v);
                  setScreen({ kind: "idle" });
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
              <button
                onClick={closeTabletMode}
                className="font-rajdhani text-[16px] font-bold px-4 py-3 rounded-lg"
                style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.3)", cursor: "pointer" }}
              >
                Exit
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center">
            {screen.kind === "reported" && (
              <div className="flex-1 flex items-center justify-center w-full">
                <p className="text-center font-rajdhani text-3xl font-bold" style={{ color: "var(--green)" }}>{screen.text}</p>
              </div>
            )}

            {screen.kind === "report" && (
              <ReportScreen match={screen.match} onSubmit={submitResult} onCancel={() => setScreen({ kind: "idle" })} />
            )}

            {screen.kind === "match-not-found" && (
              <div className="flex-1 flex flex-col items-center justify-center gap-6 w-full text-center">
                <p className="font-rajdhani text-2xl font-bold" style={{ color: "var(--coral)" }}>
                  No pending match found between {screen.tagA} and {screen.tagB}.
                </p>
                <button
                  onClick={() => {
                    setScreen({ kind: "idle" });
                    scannerRef.current?.resume();
                  }}
                  className="font-rajdhani text-xl font-bold px-8 py-4 rounded-lg"
                  style={{ background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }}
                >
                  Try again
                </button>
              </div>
            )}

            {screen.kind === "idle" && queueModeOn && (
              <QueueScreen matches={readyMatches} loading={loadingMatches} onPick={m => setScreen({ kind: "report", match: m })} />
            )}

            {/* One persistent container for both scan steps — NOT two
                separate JSX blocks sharing the same id. html5-qrcode injects
                a live <video> into this exact DOM node; if scan-p1 and
                scan-p2 each rendered their own copy (even with the same id
                string), React would unmount/remount a brand-new node on the
                idle -> scan-p2 transition and silently kill the running
                camera, since the session effect below has no reason to
                rerun (scanningActive stays true across that transition). */}
            {(screen.kind === "idle" && !queueModeOn) || screen.kind === "scan-p2" ? (
              <div className="w-full max-w-sm text-center">
                {screen.kind === "scan-p2" ? (
                  <>
                    <p className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-1">✓ {screen.player1.tag}</p>
                    <p className="font-rajdhani text-xl font-bold text-[var(--text-secondary)] mb-4">Now scan Player 2's QR code</p>
                  </>
                ) : (
                  <>
                    <p className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-2">Scan Player 1's QR code</p>
                    <p className="text-[13px] text-[var(--text-secondary)] mb-4">Then Player 2's — the match between them will be found automatically.</p>
                  </>
                )}
                <div id={SCANNER_ELEMENT_ID} className="rounded-lg overflow-hidden" style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)", minHeight: 280 }} />
                {scanError && <p className="mt-4 text-[14px] font-semibold" style={{ color: "var(--coral)" }}>{scanError}</p>}
              </div>
            ) : null}
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
function ReportScreen({
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
