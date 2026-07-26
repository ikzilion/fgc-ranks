// lib/useQrScanner.ts
// Shared camera-session lifecycle for every QR-scanning feature (Tablet/
// Phone Mode's match-reporting and add-player flows; previously duplicated
// inline in each of ScanToAddPlayerButton.tsx and TabletModeButton.tsx
// separately). Wraps html5-qrcode's start/pause/resume/stop/clear dance —
// including the defensive stop-then-clear teardown (clear() throws
// SYNCHRONOUSLY, not a rejected promise, if html5-qrcode's internal state
// doesn't yet agree scanning has stopped; a caller that tears the camera
// down immediately on a decode, before pause() has fully settled, hits this
// far more easily than a modal-close-driven teardown ever does) — so no
// caller has to get this right on its own.
"use client";

import { useEffect, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";

const SCAN_CONFIG = { fps: 10, qrbox: 250 };

// `active`: whether the camera should be running right now. `onDecoded`
// fires with the trimmed decoded text — the scanner is already paused by
// the time it's called; the caller decides when to call `resume()` (after
// whatever lookup/processing the decode triggers finishes). `onError` fires
// if the camera itself can't be started (permissions, no device, etc).
// `sessionKey` (optional): changing its value forces a fresh camera session
// (full stop + restart) even if `active` stays true across the change —
// for a coarse, deliberate navigation (e.g. switching between two entirely
// different scan-driven modes in the same overlay) where reusing the
// pause()/resume() cycle on one continuous session risks html5-qrcode's
// internal decode pipeline still working through frames queued from the
// PREVIOUS logical session. Within one session (e.g. two scan steps in a
// row, same sessionKey), pause()/resume() is deliberately preferred over a
// restart — it's smoother (no camera flicker/reinit) and already proven
// correct there.
export function useQrScanner(
  elementId: string,
  active: boolean,
  onDecoded: (text: string) => void | Promise<void>,
  onError?: () => void,
  sessionKey?: string | number
) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const processingRef = useRef(false);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    const scanner = new Html5Qrcode(elementId);
    scannerRef.current = scanner;

    scanner
      .start(
        { facingMode: "environment" },
        SCAN_CONFIG,
        decodedText => {
          if (cancelled || processingRef.current) return;
          processingRef.current = true;
          scanner.pause(true);
          // Keep the guard held until onDecoded's own async work (the
          // player lookup, any follow-up mutation) actually finishes, not
          // just until this synchronous call returns — pause() doesn't
          // synchronously guarantee an already-scheduled decode tick for
          // the same still-in-frame code won't fire again almost
          // immediately after. Resetting the guard too early (previously:
          // right after this call, not after its returned promise settles)
          // let that near-simultaneous second tick slip through as if it
          // were a genuine second scan of the same code.
          Promise.resolve(onDecodedRef.current(decodedText.trim())).finally(() => {
            processingRef.current = false;
          });
        },
        // Per-frame "no code found in this frame" callback — fires
        // continuously while nothing's in view, not an actual error.
        () => {}
      )
      .catch(() => {
        if (!cancelled) onErrorRef.current?.();
      });

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (!s) return;
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
  }, [elementId, active, sessionKey]);

  function resume() {
    // resume() throws SYNCHRONOUSLY if the scanner isn't currently paused —
    // a real, observed case: a caller's delayed resume() (e.g. a result-
    // banner timeout) can fire after the user already moved on to a new
    // session (a mode switch, restarting via `sessionKey`), by which point
    // scannerRef.current is a fresh instance that's already scanning, not
    // paused. That's a no-op, not an error.
    try {
      scannerRef.current?.resume();
    } catch {
      // Already scanning, already torn down, or mid-transition -- fine.
    }
  }

  return { resume };
}
