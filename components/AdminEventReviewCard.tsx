// components/AdminEventReviewCard.tsx
// One card per PENDING Event in the admin review queue (app/admin/events).
// Pre-filled edit form so the admin can correct a field before approving —
// edit-and-approve happens in one call to approveEvent, not a separate
// "edit" step. Reject requires a reason to be typed before it submits.
// Same field-editing conventions as EditEventDetailsButton, just rendered
// inline instead of in a modal.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PendingEvent {
  id: string;
  displayId?: string | null;
  name: string;
  isOnlineOnly: boolean;
  address?: string | null;
  logoUrl?: string | null;
  twitchUrl?: string | null;
  createdAt: string;
  creator?: { id: string; tag: string } | null;
}

export function AdminEventReviewCard({ event }: { event: PendingEvent }) {
  const router = useRouter();
  const [name, setName] = useState(event.name);
  const [logoUrl, setLogoUrl] = useState(event.logoUrl || "");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [isOnlineOnly, setIsOnlineOnly] = useState(event.isOnlineOnly);
  const [address, setAddress] = useState(event.address || "");
  const [twitchUrl, setTwitchUrl] = useState(event.twitchUrl || "");
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  async function handleApprove() {
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
            mutation ApproveEvent($id: ID!, $name: String, $isOnlineOnly: Boolean, $address: String, $logoUrl: String, $twitchUrl: String) {
              approveEvent(id: $id, name: $name, isOnlineOnly: $isOnlineOnly, address: $address, logoUrl: $logoUrl, twitchUrl: $twitchUrl) { id }
            }
          `,
          variables: {
            id: event.id,
            name,
            isOnlineOnly,
            address: isOnlineOnly ? "" : address,
            logoUrl,
            twitchUrl,
          },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to approve event");
        setLoading(false);
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  async function handleReject() {
    if (!reason.trim()) {
      setError("A rejection reason is required.");
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
            mutation RejectEvent($id: ID!, $reason: String!) {
              rejectEvent(id: $id, reason: $reason) { id }
            }
          `,
          variables: { id: event.id, reason: reason.trim() },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to reject event");
        setLoading(false);
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  return (
    <div className="fgc-card p-5 mb-4">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-rajdhani text-lg font-bold text-[var(--text-primary)] leading-tight">{event.name}</h2>
          <p className="text-[11px] font-mono text-[var(--text-muted)] mt-0.5">{event.displayId}</p>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] text-right flex-shrink-0">
          {event.creator?.tag ?? "Unknown"}
          <br />
          {new Date(event.createdAt).toLocaleDateString()}
        </p>
      </div>

      <div className="mb-3">
        <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Event name</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
          style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
        />
      </div>

      <div className="mb-3">
        <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Logo</label>
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

      <div className="mb-3">
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

      <div className="mb-4">
        <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Twitch link</label>
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

      {showRejectForm ? (
        <div className="mb-3">
          <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Rejection reason (required)</label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Let the creator know what needs to change…"
            rows={3}
            className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)] mb-2"
            style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => { setShowRejectForm(false); setReason(""); setError(""); }}
              disabled={loading}
              className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
              style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
            >
              Cancel
            </button>
            <button
              onClick={handleReject}
              disabled={loading || !reason.trim()}
              className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
              style={{
                background: "var(--coral-dim)",
                color: "var(--coral)",
                border: "1px solid rgba(255,77,77,0.2)",
                cursor: loading || !reason.trim() ? "not-allowed" : "pointer",
                opacity: loading || !reason.trim() ? 0.6 : 1,
              }}
            >
              Confirm reject
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => setShowRejectForm(true)}
            disabled={loading}
            className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
            style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: "pointer" }}
          >
            Reject
          </button>
          <button
            onClick={handleApprove}
            disabled={loading || uploadingLogo}
            className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
            style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Approving..." : "Approve"}
          </button>
        </div>
      )}
    </div>
  );
}
