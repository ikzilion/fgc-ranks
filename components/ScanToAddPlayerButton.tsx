// components/ScanToAddPlayerButton.tsx
// QR-based tournament check-in (add-to-roster half only — the separate
// day-of attendance "Check-in system" item is unbuilt and out of scope
// here). Opens the device camera, decodes a scanned Player ID QR (the same
// plain displayId string players/[id]/page.tsx encodes, e.g. "FGC-000001"),
// resolves it via the existing playerByDisplayId query, then adds them via
// addEntrantByOrganizer — the organizer-side counterpart to joinTournament.
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";

const SCANNER_ELEMENT_ID = "qr-add-player-scanner";
// How long a result banner (success/error) stays up before the camera
// automatically resumes scanning — long enough to read, short enough to
// keep a check-in desk moving through a line of players.
const RESULT_DISPLAY_MS = 1800;

type ScanState =
  | { kind: "scanning" }
  | { kind: "looking-up" }
  | { kind: "success"; tag: string; alreadyEntered: boolean }
  | { kind: "error"; message: string };

export function ScanToAddPlayerButton({
  tournamentId,
  canManage,
  status,
}: {
  tournamentId: string;
  canManage: boolean;
  status: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ScanState>({ kind: "scanning" });
  const scannerRef = useRef<Html5Qrcode | null>(null);
  // Guards against html5-qrcode firing its success callback again for the
  // same still-in-frame code before pause() has actually taken effect.
  const processingRef = useRef(false);

  // Same LIVE/ENDED lock the mutation itself enforces server-side — hidden
  // once the roster can't change anymore, same convention as
  // RemoveEntrantButton/GenerateBracketButton's own canManage gates.
  if (!canManage || status === "LIVE" || status === "ENDED") return null;

  useEffect(() => {
    if (!open) return;

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
          handleDecoded(decodedText).finally(() => {
            processingRef.current = false;
          });
        },
        // Per-frame "no code found in this frame" callback — fires
        // continuously while nothing's in view, not an actual error.
        () => {}
      )
      .catch(() => {
        if (!cancelled) setState({ kind: "error", message: "Couldn't access the camera. Check permissions and try again." });
      });

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (!s) return;
      if (s.isScanning) {
        s.stop().then(() => s.clear()).catch(() => {});
      } else {
        s.clear();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleDecoded(decodedText: string) {
    setState({ kind: "looking-up" });

    try {
      const lookupRes = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            query PlayerByDisplayId($displayId: String!) {
              playerByDisplayId(displayId: $displayId) { id tag }
            }
          `,
          variables: { displayId: decodedText.trim() },
        }),
      });
      const lookupJson = await lookupRes.json();
      const player = lookupJson.data?.playerByDisplayId;
      if (lookupJson.errors || !player) {
        finish({ kind: "error", message: "QR code not recognized as a valid Player ID." });
        return;
      }

      const addRes = await fetch("/api/graphql", {
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
      const addJson = await addRes.json();
      if (addJson.errors) {
        finish({ kind: "error", message: addJson.errors[0]?.message ?? "Failed to add player." });
        return;
      }

      finish({ kind: "success", tag: player.tag, alreadyEntered: addJson.data.addEntrantByOrganizer.alreadyEntered });
      router.refresh();
    } catch {
      finish({ kind: "error", message: "Something went wrong. Try again." });
    }
  }

  function finish(result: ScanState) {
    setState(result);
    setTimeout(() => {
      setState({ kind: "scanning" });
      scannerRef.current?.resume();
    }, RESULT_DISPLAY_MS);
  }

  function openScanner() {
    setState({ kind: "scanning" });
    setOpen(true);
  }

  return (
    <>
      <button
        onClick={openScanner}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        📷 Scan to add player
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Scan to add player</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              Point the camera at a player's Player ID QR code (from their profile page) to add them to this tournament.
            </p>

            {/* The scanner container stays mounted for as long as the modal
                is open — html5-qrcode owns a live <video> inside it, so
                conditionally unmounting this on every state change would
                kill the running camera. Status is an overlay on top instead. */}
            <div className="relative rounded-md overflow-hidden mb-4" style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)", minHeight: 250 }}>
              <div id={SCANNER_ELEMENT_ID} />

              {state.kind !== "scanning" && (
                <div
                  className="absolute inset-0 flex items-center justify-center text-center p-4"
                  style={{ background: "rgba(10,14,26,0.92)" }}
                >
                  {state.kind === "looking-up" && (
                    <p className="text-[13px] text-[var(--text-secondary)]">Looking up player...</p>
                  )}
                  {state.kind === "success" && (
                    <p className="text-[14px] font-semibold" style={{ color: state.alreadyEntered ? "var(--gold)" : "var(--green)" }}>
                      {state.alreadyEntered ? `${state.tag} is already entered.` : `✓ Added ${state.tag}`}
                    </p>
                  )}
                  {state.kind === "error" && (
                    <p className="text-[13px]" style={{ color: "var(--coral)" }}>{state.message}</p>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={() => setOpen(false)}
              className="w-full py-2 rounded font-rajdhani text-[14px] font-bold"
              style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
