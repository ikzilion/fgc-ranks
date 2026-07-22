// components/AdminTOManager.tsx
// TO permission overhaul admin UI — pending-request review cards (same
// approve/reject-with-reason shape as AdminEventReviewCard) on top, direct
// grant/revoke player search+list (same shape as AdminUserManager) below.
"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";

interface PendingRequest {
  id: string;
  contactEmail: string;
  reason?: string | null;
  createdAt: string;
  player: {
    id: string;
    tag: string;
    displayId?: string | null;
    avatarUrl?: string | null;
    user?: { id: string; createdAt: string } | null;
    tournaments: { id: string }[];
  };
}

interface PlayerRow {
  id: string;
  tag: string;
  displayId?: string | null;
  avatarUrl?: string | null;
  user?: { id: string; isTO: boolean; createdAt: string } | null;
}

function accountAgeLabel(createdAt?: string) {
  if (!createdAt) return "unknown account age";
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000));
  if (days < 1) return "account created today";
  return `account ${days} day${days === 1 ? "" : "s"} old`;
}

function PendingTORequestCard({ request }: { request: PendingRequest }) {
  const router = useRouter();
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function runMutation(query: string, variables: Record<string, unknown>) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Something went wrong");
        setLoading(false);
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  function handleApprove() {
    runMutation(`mutation ApproveTORequest($id: ID!) { approveTORequest(id: $id) { id } }`, { id: request.id });
  }

  function handleReject() {
    if (!reason.trim()) {
      setError("A rejection reason is required.");
      return;
    }
    runMutation(
      `mutation RejectTORequest($id: ID!, $reason: String!) { rejectTORequest(id: $id, reason: $reason) { id } }`,
      { id: request.id, reason: reason.trim() }
    );
  }

  const player = request.player;

  return (
    <div className="fgc-card p-5 mb-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[12px] font-bold overflow-hidden"
            style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.3)" }}
          >
            {player.avatarUrl ? (
              <img src={player.avatarUrl} alt={player.tag} className="w-full h-full object-cover" />
            ) : (
              player.tag.slice(0, 2).toUpperCase()
            )}
          </div>
          <div>
            <h2 className="font-rajdhani text-lg font-bold text-[var(--text-primary)] leading-tight">{player.tag}</h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              {accountAgeLabel(player.user?.createdAt)} · {player.tournaments.length} tournament{player.tournaments.length === 1 ? "" : "s"} entered
            </p>
            <p className="text-[11px] text-[var(--text-secondary)]">{request.contactEmail}</p>
          </div>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] text-right flex-shrink-0">
          {new Date(request.createdAt).toLocaleDateString()}
        </p>
      </div>

      {request.reason && (
        <p className="text-[13px] text-[var(--text-secondary)] mb-3 px-3 py-2 rounded" style={{ background: "var(--navy-3)" }}>
          "{request.reason}"
        </p>
      )}

      {error && (
        <p className="text-[12px] mb-3 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
          {error}
        </p>
      )}

      {showRejectForm ? (
        <div>
          <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Rejection reason (required)</label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Let the player know why…"
            rows={2}
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
            disabled={loading}
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

export function AdminTOManager({ pendingRequests, players }: { pendingRequests: PendingRequest[]; players: PlayerRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return players;
    const q = query.toLowerCase();
    return players.filter(p => p.tag.toLowerCase().includes(q) || p.displayId?.toLowerCase().includes(q));
  }, [players, query]);

  async function runMutation(playerId: string, mutationQuery: string, confirmMessage: string) {
    if (!confirm(confirmMessage)) return;
    setLoadingId(playerId);
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: mutationQuery, variables: { playerId } }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Something went wrong");
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoadingId(null);
  }

  function handleGrant(playerId: string, tag: string) {
    runMutation(playerId, `mutation GrantTOStatus($playerId: ID!) { grantTOStatus(playerId: $playerId) }`, `Grant TO status to ${tag}?`);
  }

  function handleRevoke(playerId: string, tag: string) {
    runMutation(playerId, `mutation RevokeTOStatus($playerId: ID!) { revokeTOStatus(playerId: $playerId) }`, `Revoke TO status from ${tag}?`);
  }

  return (
    <>
      <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">
        Pending requests ({pendingRequests.length})
      </h2>
      {pendingRequests.length === 0 ? (
        <div className="fgc-card p-6 mb-8">
          <p className="text-[var(--text-secondary)]">Nothing to review.</p>
        </div>
      ) : (
        <div className="mb-8">
          {pendingRequests.map(request => (
            <PendingTORequestCard key={request.id} request={request} />
          ))}
        </div>
      )}

      <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Grant or revoke directly</h2>
      <div className="relative mb-4">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by tag or Player ID…"
          className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
          style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
        />
      </div>

      {error && (
        <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
          {error}
        </p>
      )}

      <div className="fgc-card">
        {filtered.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">No players match "{query}".</p>
        )}
        {filtered.map(player => {
          const isTO = !!player.user?.isTO;
          const loading = loadingId === player.id;
          return (
            <div
              key={player.id}
              className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-[var(--border)] last:border-0"
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[12px] font-bold overflow-hidden"
                style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
              >
                {player.avatarUrl ? (
                  <img src={player.avatarUrl} alt={player.tag} className="w-full h-full object-cover" />
                ) : (
                  player.tag.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)] leading-tight">{player.tag}</p>
                {player.displayId && <p className="text-[11px] font-mono text-[var(--text-muted)]">{player.displayId}</p>}
              </div>
              {isTO && (
                <span className="text-[10px] font-bold uppercase px-2 py-1 rounded" style={{ background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.25)" }}>
                  TO
                </span>
              )}
              {isTO ? (
                <button
                  onClick={() => handleRevoke(player.id, player.tag)}
                  disabled={loading}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                  style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
                >
                  {loading ? "..." : "Revoke TO"}
                </button>
              ) : (
                <button
                  onClick={() => handleGrant(player.id, player.tag)}
                  disabled={loading}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                  style={{ background: "var(--green-dim)", color: "var(--green)", border: "1px solid rgba(58,199,120,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
                >
                  {loading ? "..." : "Grant TO"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
