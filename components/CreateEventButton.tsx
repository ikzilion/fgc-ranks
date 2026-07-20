// components/CreateEventButton.tsx
// Any signed-in player can create an Event — no admin approval gate
// (settled design, supersedes the earlier "Venue/Event" admin-review-queue
// idea). Same modal/form conventions as CreateTournamentButton.
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

export function CreateEventButton() {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [isOnlineOnly, setIsOnlineOnly] = useState(false);
  const [address, setAddress] = useState("");
  const [twitchUrl, setTwitchUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!session) return null;

  function resetForm() {
    setName("");
    setLogoUrl("");
    setIsOnlineOnly(false);
    setAddress("");
    setTwitchUrl("");
    setError("");
  }

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingLogo(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", "event-logo");

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
    if (!name.trim()) {
      setError("Event name is required.");
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
            mutation CreateEvent($name: String!, $isOnlineOnly: Boolean, $address: String, $logoUrl: String, $twitchUrl: String) {
              createEvent(name: $name, isOnlineOnly: $isOnlineOnly, address: $address, logoUrl: $logoUrl, twitchUrl: $twitchUrl) {
                id
                displayId
              }
            }
          `,
          variables: {
            name,
            isOnlineOnly,
            address: isOnlineOnly ? "" : address,
            logoUrl: logoUrl || undefined,
            twitchUrl: twitchUrl || undefined,
          },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to create event");
      } else {
        setOpen(false);
        resetForm();
        router.push(`/events/${json.data.createEvent.id}`);
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
        + New event
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Create event</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              A venue or recurring series — tournaments can link to it afterward to share its logo/location/Twitch link and show up together on its page.
            </p>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Event name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Combo Breaker"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

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

            <div className="mb-6">
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

            {error && (
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2">
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
