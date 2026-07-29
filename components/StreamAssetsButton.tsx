// components/StreamAssetsButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { maxUploadBytes, formatMaxSizeLabel } from "@/lib/uploadLimits";

const DEFAULT_LINE_COLOR = "#3a4066"; // matches BracketView's var(--border-strong) fallback
const DEFAULT_BOX_COLOR = "#13162a"; // matches BracketView's .fgc-card background (var(--navy-2))
const DEFAULT_FONT_COLOR = "#f0f2ff"; // matches BracketView's player-tag text (var(--text-primary))

interface StreamAssetOption {
  id: string;
  url: string;
  filename: string | null;
  createdAt: string;
}

async function fetchStreamAssets(type: "stream-bg" | "sponsor-banner"): Promise<StreamAssetOption[]> {
  try {
    const res = await fetch("/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query MyStreamAssets($type: String!) { myStreamAssets(type: $type) { id url filename createdAt } }`,
        variables: { type },
      }),
    });
    const json = await res.json();
    return json.data?.myStreamAssets ?? [];
  } catch {
    return [];
  }
}

// The reusable-library picker dropdown — sits alongside the existing
// Upload/Change button (additive, doesn't replace it). Selecting a past
// upload just sets the same confirmedUrl state a fresh upload would, so
// everything downstream (preview thumbnail, Save) is identical either way.
//
// Label is the real uploaded filename when one was captured (every upload
// going forward) — a handful of assets uploaded before that field existed
// have no way to recover their original name retroactively, so those fall
// back to a generic "{noun} N" label (most recent = 1) rather than the
// unhelpful raw blob path or a date-only label.
function AssetPickerDropdown({
  assets,
  currentUrl,
  assetNoun,
  onPick,
}: {
  assets: StreamAssetOption[];
  currentUrl: string;
  assetNoun: string;
  onPick: (url: string) => void;
}) {
  if (assets.length === 0) return null;
  // The currently-applied URL might not be one of the listed past uploads
  // (e.g. still the placeholder empty string, or a fresh upload not yet
  // reflected in the fetched list) — in that case nothing should appear
  // pre-selected, so the dropdown doesn't silently relabel an unrelated URL.
  const matchesCurrent = assets.some(a => a.url === currentUrl);
  return (
    <select
      value={matchesCurrent ? currentUrl : ""}
      onChange={e => {
        if (e.target.value) onPick(e.target.value);
      }}
      className="text-[12px] px-2 py-2 rounded w-full mt-2"
      style={{ background: "var(--navy-3)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" }}
    >
      <option value="" disabled>
        Pick from previous uploads ({assets.length})
      </option>
      {assets.map((a, i) => (
        <option key={a.id} value={a.url}>
          {a.filename ?? `${assetNoun} ${i + 1} (uploaded ${new Date(a.createdAt).toLocaleDateString()})`}
        </option>
      ))}
    </select>
  );
}

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

// seconds<->display-unit conversion for the slideshow interval field —
// stored/sent as seconds always (matches the schema's
// sponsorBannerIntervalSeconds), the minutes option is purely a display
// convenience so a TO picking "5 minutes" doesn't have to do the math to 300.
const INTERVAL_UNIT_SECONDS: Record<"seconds" | "minutes", number> = { seconds: 1, minutes: 60 };

// Picks the nicer of the two units to show a saved interval in (e.g. 300s
// displays as "5 minutes", not "300 seconds") — purely a display choice,
// the stored value is always in seconds regardless of which unit is shown.
function secondsToIntervalDisplay(seconds?: number | null): { value: string; unit: "seconds" | "minutes" } {
  if (!seconds) return { value: "", unit: "seconds" };
  if (seconds >= 60 && seconds % 60 === 0) return { value: String(seconds / 60), unit: "minutes" };
  return { value: String(seconds), unit: "seconds" };
}

export function StreamAssetsButton({
  tournamentId,
  streamBackgroundUrl,
  sponsorBannerUrl,
  sponsorBannerUrls,
  sponsorBannerIntervalSeconds,
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
  sponsorBannerUrls?: { url: string; linkUrl?: string | null }[];
  sponsorBannerIntervalSeconds?: number | null;
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
  // Sponsor banner slideshow — the subset of the TO's banner library
  // (bannerAssets below) selected to rotate through, plus the interval
  // that's saved/sent as seconds but shown in whichever unit the current
  // value reads more naturally in (see secondsToIntervalDisplay). Each
  // selected slide carries its own optional click-through linkUrl
  // (settled July 28, 2026) — "" means not clickable, same empty-is-unset
  // convention as every other optional URL field in this app.
  const [slideshowSlides, setSlideshowSlides] = useState<{ url: string; linkUrl: string }[]>(
    (sponsorBannerUrls ?? []).map(s => ({ url: s.url, linkUrl: s.linkUrl ?? "" }))
  );
  const initialInterval = secondsToIntervalDisplay(sponsorBannerIntervalSeconds);
  const [intervalValue, setIntervalValue] = useState(initialInterval.value);
  const [intervalUnit, setIntervalUnit] = useState<"seconds" | "minutes">(initialInterval.unit);
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
  // The TO's reusable library (models/StreamAsset.ts) for each asset type —
  // fetched fresh every time the modal opens, and re-fetched after a new
  // upload succeeds so a just-uploaded image shows up in its own dropdown
  // immediately, without needing to close and reopen the modal.
  const [bgAssets, setBgAssets] = useState<StreamAssetOption[]>([]);
  const [bannerAssets, setBannerAssets] = useState<StreamAssetOption[]>([]);

  if (!canManage) return null;

  function openModal() {
    setBackgroundUrl(streamBackgroundUrl || "");
    setBannerUrl(sponsorBannerUrl || "");
    setSlideshowSlides((sponsorBannerUrls ?? []).map(s => ({ url: s.url, linkUrl: s.linkUrl ?? "" })));
    const initial = secondsToIntervalDisplay(sponsorBannerIntervalSeconds);
    setIntervalValue(initial.value);
    setIntervalUnit(initial.unit);
    setLineColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setDraftLineColor(bracketLineColor || DEFAULT_LINE_COLOR);
    setBoxColor(bracketBoxColor || DEFAULT_BOX_COLOR);
    setDraftBoxColor(bracketBoxColor || DEFAULT_BOX_COLOR);
    setFontColor(bracketFontColor || DEFAULT_FONT_COLOR);
    setDraftFontColor(bracketFontColor || DEFAULT_FONT_COLOR);
    setError("");
    setOpen(true);
    if (!isRestricted) {
      fetchStreamAssets("stream-bg").then(setBgAssets);
      fetchStreamAssets("sponsor-banner").then(setBannerAssets);
    }
  }

  // Explicitly discard any in-progress edits (background/banner/colors) back
  // to the tournament's actual saved values, rather than relying on the next
  // openModal() call to reset them — closing via the backdrop click uses the
  // same handler, so this is the single source of truth for "cancel".
  function closeWithoutSaving() {
    setBackgroundUrl(streamBackgroundUrl || "");
    setBannerUrl(sponsorBannerUrl || "");
    setSlideshowSlides((sponsorBannerUrls ?? []).map(s => ({ url: s.url, linkUrl: s.linkUrl ?? "" })));
    const resetInterval = secondsToIntervalDisplay(sponsorBannerIntervalSeconds);
    setIntervalValue(resetInterval.value);
    setIntervalUnit(resetInterval.unit);
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
    if (url) {
      setBackgroundUrl(url);
      // The upload route already recorded this into the library server-side
      // (lib/streamAssets.ts) — refetch so the dropdown includes it right away.
      fetchStreamAssets("stream-bg").then(setBgAssets);
    }
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
    if (url) {
      setBannerUrl(url);
      fetchStreamAssets("sponsor-banner").then(setBannerAssets);
    }
    setUploadingBanner(false);
  }

  function toggleSlideshowUrl(url: string) {
    setSlideshowSlides(prev => (prev.some(s => s.url === url) ? prev.filter(s => s.url !== url) : [...prev, { url, linkUrl: "" }]));
  }

  function setSlideshowLinkUrl(url: string, linkUrl: string) {
    setSlideshowSlides(prev => prev.map(s => (s.url === url ? { ...s, linkUrl } : s)));
  }

  async function handleSave() {
    setError("");

    // Mirrors the server-side check in updateTournamentStreamAssets — catch
    // it here too so the TO gets an inline message instead of a round trip
    // just to find out the interval field was left blank.
    const intervalNum = parseFloat(intervalValue);
    const effectiveIntervalSeconds =
      intervalValue && !isNaN(intervalNum) && intervalNum > 0 ? Math.round(intervalNum * INTERVAL_UNIT_SECONDS[intervalUnit]) : null;
    if (!isRestricted && slideshowSlides.length >= 2 && !effectiveIntervalSeconds) {
      setError("Set a rotation interval to enable the sponsor banner slideshow.");
      return;
    }

    setLoading(true);

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
                mutation UpdateStreamAssets($id: ID!, $streamBackgroundUrl: String, $sponsorBannerUrl: String, $sponsorBannerUrls: [SponsorBannerSlideInput!], $sponsorBannerIntervalSeconds: Int) {
                  updateTournamentStreamAssets(
                    id: $id
                    streamBackgroundUrl: $streamBackgroundUrl
                    sponsorBannerUrl: $sponsorBannerUrl
                    sponsorBannerUrls: $sponsorBannerUrls
                    sponsorBannerIntervalSeconds: $sponsorBannerIntervalSeconds
                  ) { id }
                }
              `,
              variables: {
                id: tournamentId,
                streamBackgroundUrl: backgroundUrl,
                sponsorBannerUrl: bannerUrl,
                sponsorBannerUrls: slideshowSlides.map(s => ({ url: s.url, linkUrl: s.linkUrl.trim() || null })),
                sponsorBannerIntervalSeconds: effectiveIntervalSeconds,
              },
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
          {/* pl-8 (vs pr-6) — the inner scrollable region below adds its own
              pr-1/-mr-1 scrollbar-gutter compensation (see its comment), so
              the right edge already reads with a bit more breathing room
              than the left got from a plain uniform p-6; this closes that
              gap instead of matching it exactly. */}
          <div className="fgc-card pl-8 pr-6 py-6 w-full max-w-3xl flex flex-col" style={{ maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
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
                and scrolling internally — min-h-0 overrides that.

                p-4/-mr-4 (not the previous pr-1/-mr-1): setting only
                overflow-y here means the browser computes overflow-x as
                "auto" too (per spec, an axis left at its default "visible"
                gets forced into a clipping regime once the OTHER axis
                isn't "visible" — the exact same rule the bracket-scroll fix
                in this codebase hit in reverse), so this element itself
                clips both axes despite only meaning to scroll vertically.
                Each ColorPickerField's react-colorful handle overhangs its
                own 160x140 box by 14px (half its 28px diameter) whenever
                dragged to an edge — with the old 4px pr-1/-mr-1 buffer (and
                zero padding on the other 3 sides), a picker sitting flush
                against this element's own left/right/top/bottom clipped
                that overhang. p-4 gives 16px of real buffer on all 4 sides
                (comfortably more than the 14px overhang); -mr-4 keeps the
                original intent on the right specifically — the scrollbar's
                own track still sits flush at the ancestor `.fgc-card`'s true
                edge (borrowing into its pr-6) instead of doubling up
                whitespace, just scaled up from the old -mr-1. */}
            <div className="overflow-y-auto p-4 -mr-4 flex-1 min-h-0">
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
                  <AssetPickerDropdown assets={bgAssets} currentUrl={backgroundUrl} assetNoun="Background" onPick={setBackgroundUrl} />
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
                  <AssetPickerDropdown assets={bannerAssets} currentUrl={bannerUrl} assetNoun="Banner" onPick={setBannerUrl} />

                  {/* Slideshow — picks from the same library the dropdown
                      above draws from (bannerAssets), rotating through
                      whichever ones are checked instead of the single
                      bannerUrl above. 0/1 selected just falls back to that
                      single banner on the stream view, so leaving this empty
                      is a no-op, not a separate "disabled" state to track. */}
                  <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                    <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">
                      Slideshow (optional)
                    </label>
                    {bannerAssets.length === 0 ? (
                      <p className="text-[11px] text-[var(--text-secondary)]">Upload sponsor banners above to build a rotation.</p>
                    ) : (
                      <>
                        <div
                          className="flex flex-col gap-1.5 max-h-40 overflow-y-auto p-2 rounded"
                          style={{ border: "1px solid var(--border-strong)", background: "var(--navy-3)" }}
                        >
                          {bannerAssets.map((a, i) => {
                            const slide = slideshowSlides.find(s => s.url === a.url);
                            return (
                              <div key={a.id}>
                                <label className="flex items-center gap-2 text-[12px] cursor-pointer" style={{ color: "var(--text-secondary)" }}>
                                  <input type="checkbox" checked={!!slide} onChange={() => toggleSlideshowUrl(a.url)} />
                                  {a.filename ?? `Banner ${i + 1}`}
                                </label>
                                {/* Per-banner click-through link (settled July 28, 2026) —
                                    only shown/editable once its banner is checked, so an
                                    unselected banner has no dangling link field to fill in. */}
                                {slide && (
                                  <input
                                    type="url"
                                    placeholder="Link URL (optional)"
                                    value={slide.linkUrl}
                                    onChange={e => setSlideshowLinkUrl(a.url, e.target.value)}
                                    className="text-[11px] px-2 py-1 rounded w-full mt-1 ml-5"
                                    style={{ width: "calc(100% - 1.25rem)", background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" }}
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {slideshowSlides.length >= 2 ? (
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-[11px] text-[var(--text-muted)]">Rotate every</span>
                            <input
                              type="number"
                              min="1"
                              value={intervalValue}
                              onChange={e => setIntervalValue(e.target.value)}
                              className="text-[12px] px-2 py-1.5 rounded w-16"
                              style={{ background: "var(--navy-3)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" }}
                            />
                            <select
                              value={intervalUnit}
                              onChange={e => setIntervalUnit(e.target.value as "seconds" | "minutes")}
                              className="text-[12px] px-2 py-1.5 rounded"
                              style={{ background: "var(--navy-3)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" }}
                            >
                              <option value="seconds">seconds</option>
                              <option value="minutes">minutes</option>
                            </select>
                          </div>
                        ) : (
                          <p className="text-[11px] text-[var(--text-secondary)] mt-2">
                            {slideshowSlides.length === 1
                              ? "Pick at least one more to enable rotation — with just this one it displays statically."
                              : "Pick 2 or more to rotate them on the stream view."}
                          </p>
                        )}
                      </>
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
