// components/StreamAssetsButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HexColorPicker, HexColorInput } from "react-colorful";

const DEFAULT_LINE_COLOR = "#3a4066"; // matches BracketView's var(--border-strong) fallback

export function StreamAssetsButton({
  tournamentId,
  streamBackgroundUrl,
  sponsorBannerUrl,
  bracketLineColor,
  canManage,
}: {
  tournamentId: string;
  streamBackgroundUrl?: string;
  sponsorBannerUrl?: string;
  bracketLineColor?: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [backgroundUrl, setBackgroundUrl] = useState(streamBackgroundUrl || "");
  const [bannerUrl, setBannerUrl] = useState(sponsorBannerUrl || "");
  // lineColor is the confirmed value — what gets saved and what the preview
  // swatch shows. draftColor tracks the native color input while the user is
  // actively picking, so a color choice needs an explicit "OK" to become the
  // confirmed value (and can be backed out of via "Cancel") rather than
  // committing the instant the native picker fires onChange.
  const [lineColor, setLineColor] = useState(bracketLineColor || DEFAULT_LINE_COLOR);
  const [draftColor, setDraftColor] = useState(bracketLineColor || DEFAULT_LINE_COLOR);
  const [uploadingBg, setUploadingBg] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  function openModal() {
    setBackgroundUrl(streamBackgroundUrl || "");
    setBannerUrl(sponsorBannerUrl || "");
    setLineColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setDraftColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setError("");
    setOpen(true);
  }

  // Explicitly discard any in-progress edits (background/banner/color) back
  // to the tournament's actual saved values, rather than relying on the next
  // openModal() call to reset them — closing via the backdrop click uses the
  // same handler, so this is the single source of truth for "cancel".
  function closeWithoutSaving() {
    setBackgroundUrl(streamBackgroundUrl || "");
    setBannerUrl(sponsorBannerUrl || "");
    setLineColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setDraftColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setError("");
    setOpen(false);
  }

  function confirmDraftColor() {
    setLineColor(draftColor);
  }

  function cancelDraftColor() {
    setDraftColor(lineColor);
  }

  async function uploadImage(file: File, type: "stream-bg" | "sponsor-banner"): Promise<string | null> {
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", type);

      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();

      if (json.error) {
        setError(json.error);
        return null;
      }
      return json.url;
    } catch {
      setError("Failed to upload image. Try again.");
      return null;
    }
  }

  async function handleBackgroundChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingBg(true);
    const url = await uploadImage(file, "stream-bg");
    if (url) setBackgroundUrl(url);
    setUploadingBg(false);
  }

  async function handleBannerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingBanner(true);
    const url = await uploadImage(file, "sponsor-banner");
    if (url) setBannerUrl(url);
    setUploadingBanner(false);
  }

  async function handleSave() {
    setLoading(true);
    setError("");

    try {
      const [assetsRes, colorRes] = await Promise.all([
        fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `
              mutation UpdateStreamAssets($id: ID!, $streamBackgroundUrl: String, $sponsorBannerUrl: String) {
                updateTournamentStreamAssets(id: $id, streamBackgroundUrl: $streamBackgroundUrl, sponsorBannerUrl: $sponsorBannerUrl) { id }
              }
            `,
            variables: { id: tournamentId, streamBackgroundUrl: backgroundUrl, sponsorBannerUrl: bannerUrl },
          }),
        }),
        fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `
              mutation UpdateBracketLineColor($id: ID!, $bracketLineColor: String!) {
                updateTournamentBracketLineColor(id: $id, bracketLineColor: $bracketLineColor) { id }
              }
            `,
            variables: { id: tournamentId, bracketLineColor: lineColor },
          }),
        }),
      ]);

      const [assetsJson, colorJson] = await Promise.all([assetsRes.json(), colorRes.json()]);

      if (assetsJson.errors || colorJson.errors) {
        setError(assetsJson.errors?.[0]?.message ?? colorJson.errors?.[0]?.message ?? "Failed to save stream settings");
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
        onClick={openModal}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        Stream settings
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={closeWithoutSaving}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Stream settings</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              Customize the broadcast overlay at{" "}
              <a href={`/tournaments/${tournamentId}/stream`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue)" }}>
                /tournaments/{tournamentId}/stream
              </a>{" "}
              — paste that URL into OBS as a browser source.
            </p>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Background image</label>
              {backgroundUrl && (
                <div className="w-full h-20 rounded-md mb-2 overflow-hidden" style={{ border: "1px solid var(--border-strong)" }}>
                  <img src={backgroundUrl} alt="Background preview" className="w-full h-full object-cover" />
                </div>
              )}
              <div className="flex gap-2">
                <label
                  className="text-[12px] font-semibold px-3 py-2 rounded cursor-pointer"
                  style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
                >
                  {uploadingBg ? "Uploading..." : backgroundUrl ? "Change" : "Upload"}
                  <input type="file" accept="image/*" onChange={handleBackgroundChange} disabled={uploadingBg} className="hidden" />
                </label>
                {backgroundUrl && (
                  <button
                    onClick={() => setBackgroundUrl("")}
                    className="text-[12px] font-semibold px-3 py-2 rounded"
                    style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: "pointer" }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="mb-6">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Sponsor banner</label>
              {bannerUrl && (
                <div className="w-full h-16 rounded-md mb-2 overflow-hidden flex items-center justify-center" style={{ border: "1px solid var(--border-strong)", background: "var(--navy-3)" }}>
                  <img src={bannerUrl} alt="Banner preview" className="max-h-full max-w-full object-contain" />
                </div>
              )}
              <div className="flex gap-2">
                <label
                  className="text-[12px] font-semibold px-3 py-2 rounded cursor-pointer"
                  style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
                >
                  {uploadingBanner ? "Uploading..." : bannerUrl ? "Change" : "Upload"}
                  <input type="file" accept="image/*" onChange={handleBannerChange} disabled={uploadingBanner} className="hidden" />
                </label>
                {bannerUrl && (
                  <button
                    onClick={() => setBannerUrl("")}
                    className="text-[12px] font-semibold px-3 py-2 rounded"
                    style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: "pointer" }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="mb-6">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Bracket connector line color</label>
              {/* react-colorful instead of a native <input type="color">: the
                  native input pops the OS/browser's own color dialog, which
                  has its own built-in OK/Cancel — fighting with this modal's
                  OK/Cancel right next to it was the actual source of the
                  "feels off" reports, not button placement. Rendering the
                  picker fully in-page means our OK/Cancel is the only
                  confirmation UI involved, full stop. */}
              <div className="flex items-start gap-3 flex-wrap">
                <HexColorPicker color={draftColor} onChange={setDraftColor} style={{ width: 160, height: 140 }} />
                <div className="flex flex-col gap-2 min-w-[140px]">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-8 h-8 rounded flex-shrink-0"
                      style={{ background: draftColor, border: "1px solid var(--border-strong)" }}
                    />
                    <span style={{ color: "var(--text-muted)" }}>#</span>
                    <HexColorInput
                      color={draftColor}
                      onChange={setDraftColor}
                      className="text-[12px] font-semibold px-2 py-1.5 rounded w-20"
                      style={{ background: "var(--navy-3)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" }}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={confirmDraftColor}
                      disabled={draftColor === lineColor}
                      className="text-[12px] font-bold px-3 py-2 rounded"
                      style={{
                        background: "var(--green)",
                        color: "var(--navy)",
                        border: "none",
                        cursor: draftColor === lineColor ? "not-allowed" : "pointer",
                        opacity: draftColor === lineColor ? 0.4 : 1,
                      }}
                    >
                      OK
                    </button>
                    <button
                      type="button"
                      onClick={cancelDraftColor}
                      disabled={draftColor === lineColor}
                      className="text-[12px] font-semibold px-3 py-2 rounded"
                      style={{
                        background: "var(--coral-dim)",
                        color: "var(--coral)",
                        border: "1px solid rgba(255,77,77,0.2)",
                        cursor: draftColor === lineColor ? "not-allowed" : "pointer",
                        opacity: draftColor === lineColor ? 0.4 : 1,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-4 h-4 rounded-full flex-shrink-0"
                      style={{ background: lineColor, border: "1px solid var(--border-strong)" }}
                    />
                    <span className="text-[11px] text-[var(--text-muted)]">current</span>
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-[var(--text-secondary)] mt-2">
                {draftColor === lineColor
                  ? "Pick a color that stays visible against your background — applies to the bracket lines on all views."
                  : "Unconfirmed pick — click OK to apply it here, or Cancel to revert. Either way, the overall Save button below still persists it."}
              </p>
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
                disabled={loading || uploadingBg || uploadingBanner}
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
