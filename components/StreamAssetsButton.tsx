// components/StreamAssetsButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { maxUploadBytes, formatMaxSizeLabel } from "@/lib/uploadLimits";

const DEFAULT_LINE_COLOR = "#3a4066"; // matches BracketView's var(--border-strong) fallback
const DEFAULT_BOX_COLOR = "#13162a"; // matches BracketView's .fgc-card background (var(--navy-2))
const DEFAULT_FONT_COLOR = "#f0f2ff"; // matches BracketView's player-tag text (var(--text-primary))

// One react-colorful picker + draft-state-until-Save + OK/Cancel-per-picker
// widget, shared by all three bracket color pickers below so their behavior
// can't drift from each other — see the "Bracket connector line color"
// picker's original comment for why react-colorful over a native
// <input type="color"> in the first place (competing OK/Cancel dialogs).
function ColorPickerField({
  label,
  helpText,
  confirmedColor,
  draftColor,
  onDraftChange,
  onConfirm,
  onCancel,
}: {
  label: string;
  helpText: string;
  confirmedColor: string;
  draftColor: string;
  onDraftChange: (color: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isDirty = draftColor !== confirmedColor;

  return (
    <div className="mb-6">
      <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">{label}</label>
      <div className="flex items-start gap-3 flex-wrap">
        <HexColorPicker color={draftColor} onChange={onDraftChange} style={{ width: 160, height: 140 }} />
        <div className="flex flex-col gap-2 min-w-[140px]">
          <div className="flex items-center gap-2">
            <span
              className="w-8 h-8 rounded flex-shrink-0"
              style={{ background: draftColor, border: "1px solid var(--border-strong)" }}
            />
            <span style={{ color: "var(--text-muted)" }}>#</span>
            <HexColorInput
              color={draftColor}
              onChange={onDraftChange}
              className="text-[12px] font-semibold px-2 py-1.5 rounded w-20"
              style={{ background: "var(--navy-3)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" }}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              disabled={!isDirty}
              className="text-[12px] font-bold px-3 py-2 rounded"
              style={{
                background: "var(--green)",
                color: "var(--navy)",
                border: "none",
                cursor: isDirty ? "pointer" : "not-allowed",
                opacity: isDirty ? 1 : 0.4,
              }}
            >
              OK
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={!isDirty}
              className="text-[12px] font-semibold px-3 py-2 rounded"
              style={{
                background: "var(--coral-dim)",
                color: "var(--coral)",
                border: "1px solid rgba(255,77,77,0.2)",
                cursor: isDirty ? "pointer" : "not-allowed",
                opacity: isDirty ? 1 : 0.4,
              }}
            >
              Cancel
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="w-4 h-4 rounded-full flex-shrink-0"
              style={{ background: confirmedColor, border: "1px solid var(--border-strong)" }}
            />
            <span className="text-[11px] text-[var(--text-muted)]">current</span>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-[var(--text-secondary)] mt-2">
        {isDirty
          ? "Unconfirmed pick — click OK to apply it here, or Cancel to revert. Either way, the overall Save button below still persists it."
          : helpText}
      </p>
    </div>
  );
}

export function StreamAssetsButton({
  tournamentId,
  streamBackgroundUrl,
  sponsorBannerUrl,
  bracketLineColor,
  bracketBoxColor,
  bracketFontColor,
  canManage,
  // TO permission overhaul — a restricted tournament can never get a stream
  // background/sponsor banner (set once at creation, see
  // models/Tournament.ts). Bracket color customization is unaffected —
  // only the background/banner section below is hidden.
  isRestricted,
}: {
  tournamentId: string;
  streamBackgroundUrl?: string;
  sponsorBannerUrl?: string;
  bracketLineColor?: string;
  bracketBoxColor?: string;
  bracketFontColor?: string;
  canManage: boolean;
  isRestricted?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [backgroundUrl, setBackgroundUrl] = useState(streamBackgroundUrl || "");
  const [bannerUrl, setBannerUrl] = useState(sponsorBannerUrl || "");
  // Each confirmed/draft pair follows the same rule: the confirmed value is
  // what gets saved and what the "current" swatch shows; the draft value
  // tracks the picker while the user is actively choosing, so a pick needs
  // an explicit "OK" to become the confirmed value (and can be backed out of
  // via "Cancel") rather than committing the instant onChange fires.
  const [lineColor, setLineColor] = useState(bracketLineColor || DEFAULT_LINE_COLOR);
  const [draftLineColor, setDraftLineColor] = useState(bracketLineColor || DEFAULT_LINE_COLOR);
  const [boxColor, setBoxColor] = useState(bracketBoxColor || DEFAULT_BOX_COLOR);
  const [draftBoxColor, setDraftBoxColor] = useState(bracketBoxColor || DEFAULT_BOX_COLOR);
  const [fontColor, setFontColor] = useState(bracketFontColor || DEFAULT_FONT_COLOR);
  const [draftFontColor, setDraftFontColor] = useState(bracketFontColor || DEFAULT_FONT_COLOR);
  const [uploadingBg, setUploadingBg] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  function openModal() {
    setBackgroundUrl(streamBackgroundUrl || "");
    setBannerUrl(sponsorBannerUrl || "");
    setLineColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setDraftLineColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setBoxColor(bracketBoxColor || DEFAULT_BOX_COLOR);
    setDraftBoxColor(bracketBoxColor || DEFAULT_BOX_COLOR);
    setFontColor(bracketFontColor || DEFAULT_FONT_COLOR);
    setDraftFontColor(bracketFontColor || DEFAULT_FONT_COLOR);
    setError("");
    setOpen(true);
  }

  // Explicitly discard any in-progress edits (background/banner/colors) back
  // to the tournament's actual saved values, rather than relying on the next
  // openModal() call to reset them — closing via the backdrop click uses the
  // same handler, so this is the single source of truth for "cancel".
  function closeWithoutSaving() {
    setBackgroundUrl(streamBackgroundUrl || "");
    setBannerUrl(sponsorBannerUrl || "");
    setLineColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setDraftLineColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setBoxColor(bracketBoxColor || DEFAULT_BOX_COLOR);
    setDraftBoxColor(bracketBoxColor || DEFAULT_BOX_COLOR);
    setFontColor(bracketFontColor || DEFAULT_FONT_COLOR);
    setDraftFontColor(bracketFontColor || DEFAULT_FONT_COLOR);
    setError("");
    setOpen(false);
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
    const maxBytes = maxUploadBytes("stream-bg");
    if (file.size > maxBytes) {
      setError(`Image must be under ${formatMaxSizeLabel(maxBytes)}.`);
      e.target.value = "";
      return;
    }
    setUploadingBg(true);
    const url = await uploadImage(file, "stream-bg");
    if (url) setBackgroundUrl(url);
    setUploadingBg(false);
  }

  async function handleBannerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const maxBytes = maxUploadBytes("sponsor-banner");
    if (file.size > maxBytes) {
      setError(`Image must be under ${formatMaxSizeLabel(maxBytes)}.`);
      e.target.value = "";
      return;
    }
    setUploadingBanner(true);
    const url = await uploadImage(file, "sponsor-banner");
    if (url) setBannerUrl(url);
    setUploadingBanner(false);
  }

  async function handleSave() {
    setLoading(true);
    setError("");

    try {
      // A restricted tournament never sends the assets mutation at all —
      // it would always be rejected server-side anyway (see
      // updateTournamentStreamAssets), and this section's own inputs are
      // hidden below, but this Save button also commits bracket color
      // changes, which ARE allowed on a restricted tournament, so it can't
      // just no-op entirely here.
      const requests = [
        fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `
              mutation UpdateBracketColors($id: ID!, $bracketLineColor: String!, $bracketBoxColor: String, $bracketFontColor: String) {
                updateTournamentBracketLineColor(id: $id, bracketLineColor: $bracketLineColor, bracketBoxColor: $bracketBoxColor, bracketFontColor: $bracketFontColor) { id }
              }
            `,
            variables: { id: tournamentId, bracketLineColor: lineColor, bracketBoxColor: boxColor, bracketFontColor: fontColor },
          }),
        }),
      ];
      if (!isRestricted) {
        requests.push(
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
          })
        );
      }

      const responses = await Promise.all(requests);
      const jsons = await Promise.all(responses.map(r => r.json()));
      const firstError = jsons.find(j => j.errors)?.errors?.[0]?.message;

      if (firstError) {
        setError(firstError);
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
          <div className="fgc-card p-6 w-full max-w-3xl flex flex-col" style={{ maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Stream settings</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              Customize the broadcast overlay at{" "}
              <a href={`/tournaments/${tournamentId}/stream`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue)" }}>
                /tournaments/{tournamentId}/stream
              </a>{" "}
              — paste that URL into OBS as a browser source.
            </p>

            {/* Everything that can grow (images + color pickers) scrolls in
                its own region, so a wide-enough viewport reflows them into
                a compact multi-column grid/row instead of one long stack,
                while the header above and error/Save-Cancel below stay put
                — the modal itself never grows tall enough to push the
                action buttons off-screen. `flex-1 min-h-0` is load-bearing
                here: a flex child's default min-height is `auto` (i.e. its
                content size), which would let this region grow past the
                parent's own `maxHeight: 90vh` instead of shrinking to fit
                and scrolling internally — min-h-0 overrides that. */}
            <div className="overflow-y-auto pr-1 -mr-1 flex-1 min-h-0">
              {isRestricted && (
                <p className="text-[12px] mb-6 px-3 py-2 rounded" style={{ background: "var(--navy-4)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
                  This tournament was created without TO status, so a stream background/sponsor banner isn't available — bracket color customization below still is.
                </p>
              )}
              {!isRestricted && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                <div>
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

                <div>
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
              </div>
              )}

              <div className="flex flex-wrap gap-4">
                <div className="flex-1 min-w-[280px]">
                  <ColorPickerField
                    label="Bracket connector line color"
                    helpText="Stays visible against your background — applies to the bracket lines (and the Winners/Losers divider) on all views."
                    confirmedColor={lineColor}
                    draftColor={draftLineColor}
                    onDraftChange={setDraftLineColor}
                    onConfirm={() => setLineColor(draftLineColor)}
                    onCancel={() => setDraftLineColor(lineColor)}
                  />
                </div>

                <div className="flex-1 min-w-[280px]">
                  <ColorPickerField
                    label="Match card background color"
                    helpText="Applies to every match/score box's background across TO, public, and stream views."
                    confirmedColor={boxColor}
                    draftColor={draftBoxColor}
                    onDraftChange={setDraftBoxColor}
                    onConfirm={() => setBoxColor(draftBoxColor)}
                    onCancel={() => setDraftBoxColor(boxColor)}
                  />
                </div>

                <div className="flex-1 min-w-[280px]">
                  <ColorPickerField
                    label="Match card text color"
                    helpText="Pick a color that stays readable against the match card background."
                    confirmedColor={fontColor}
                    draftColor={draftFontColor}
                    onDraftChange={setDraftFontColor}
                    onConfirm={() => setFontColor(draftFontColor)}
                    onCancel={() => setDraftFontColor(fontColor)}
                  />
                </div>
              </div>
            </div>

            {error && (
              <p className="text-[12px] mt-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2 mt-6">
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
