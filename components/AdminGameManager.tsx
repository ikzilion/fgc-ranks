// components/AdminGameManager.tsx
// ADMIN-only Games CRUD — same create-modal + inline-list conventions as
// CreateEventButton (icon upload) and AdminUserManager (list + actions).
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { maxUploadBytes, formatMaxSizeLabel } from "@/lib/uploadLimits";

interface GameRow {
  id: string;
  name: string;
  iconUrl?: string | null;
  tournamentCount: number;
}

// Orphan entries (a Tournament.game string with no curated Game document
// yet — see the `games` resolver) share this same list, flagged only by
// their synthetic id prefix, so an admin can "curate" one straight from
// here instead of having to separately notice and retype it.
function isOrphan(id: string) {
  return id.startsWith("orphan-");
}

export function AdminGameManager({ games }: { games: GameRow[] }) {
  const router = useRouter();
  const [modalGame, setModalGame] = useState<GameRow | null>(null);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [name, setName] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function openCreate(prefillName = "") {
    setModalMode("create");
    setModalGame(null);
    setName(prefillName);
    setIconUrl("");
    setError("");
  }

  function openEdit(game: GameRow) {
    setModalMode("edit");
    setModalGame(game);
    setName(game.name);
    setIconUrl(game.iconUrl || "");
    setError("");
  }

  function closeModal() {
    setModalMode(null);
    setModalGame(null);
  }

  async function handleIconChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const maxBytes = maxUploadBytes("game-icon");
    if (file.size > maxBytes) {
      setError(`Icon must be under ${formatMaxSizeLabel(maxBytes)}.`);
      e.target.value = "";
      return;
    }

    setUploadingIcon(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", "game-icon");

      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();

      if (json.error) {
        setError(json.error);
      } else {
        setIconUrl(json.url);
      }
    } catch {
      setError("Failed to upload icon. Try again.");
    }

    setUploadingIcon(false);
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Game name is required.");
      return;
    }
    setLoading(true);
    setError("");

    const isEdit = modalMode === "edit" && modalGame;
    const query = isEdit
      ? `mutation UpdateGame($id: ID!, $name: String, $iconUrl: String) { updateGame(id: $id, name: $name, iconUrl: $iconUrl) { id } }`
      : `mutation CreateGame($name: String!, $iconUrl: String) { createGame(name: $name, iconUrl: $iconUrl) { id } }`;
    const variables = isEdit
      ? { id: modalGame!.id, name, iconUrl: iconUrl || undefined }
      : { name, iconUrl: iconUrl || undefined };

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Something went wrong");
      } else {
        closeModal();
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  async function handleDelete(game: GameRow) {
    if (!confirm(`Delete "${game.name}" from the curated Games list? Existing tournaments keep their game value either way.`)) return;
    setDeletingId(game.id);
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DeleteGame($id: ID!) { deleteGame(id: $id) }`,
          variables: { id: game.id },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to delete game");
      } else {
        router.refresh();
      }
    } catch {
      alert("Something went wrong. Try again.");
    }
    setDeletingId(null);
  }

  return (
    <>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => openCreate()}
          className="font-rajdhani text-[13px] font-bold tracking-wide px-4 py-2 rounded"
          style={{ background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }}
        >
          + New game
        </button>
      </div>

      <div className="fgc-card">
        {games.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">No games yet.</p>
        )}
        {games.map(game => {
          const orphan = isOrphan(game.id);
          return (
            <div
              key={game.id}
              className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-[var(--border)] last:border-0"
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[12px] font-bold overflow-hidden"
                style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
              >
                {game.iconUrl ? (
                  <img src={game.iconUrl} alt={game.name} className="w-full h-full object-cover" />
                ) : (
                  game.name.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)] leading-tight truncate">{game.name}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {game.tournamentCount} tournament{game.tournamentCount === 1 ? "" : "s"}
                </p>
              </div>
              {orphan ? (
                <>
                  <span
                    className="text-[10px] font-bold uppercase px-2 py-1 rounded flex-shrink-0"
                    style={{ background: "var(--navy-4)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
                  >
                    Uncurated
                  </span>
                  <button
                    onClick={() => openCreate(game.name)}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                    style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.25)", cursor: "pointer" }}
                  >
                    Curate
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => openEdit(game)}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                    style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(game)}
                    disabled={deletingId === game.id}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                    style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: deletingId === game.id ? "not-allowed" : "pointer", opacity: deletingId === game.id ? 0.6 : 1 }}
                  >
                    {deletingId === game.id ? "..." : "Delete"}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {modalMode && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={closeModal}
        >
          <div className="fgc-card p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">
              {modalMode === "edit" ? "Edit game" : "New game"}
            </h2>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Game name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-6">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Icon (optional)</label>
              <div className="flex items-center gap-3">
                {iconUrl && (
                  <div className="w-12 h-12 rounded-full overflow-hidden flex-shrink-0" style={{ border: "1px solid var(--border-strong)" }}>
                    <img src={iconUrl} alt="Icon preview" className="w-full h-full object-cover" />
                  </div>
                )}
                <label
                  className="text-[12px] font-semibold px-3 py-2 rounded cursor-pointer"
                  style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
                >
                  {uploadingIcon ? "Uploading..." : iconUrl ? "Change" : "Upload"}
                  <input type="file" accept="image/*" onChange={handleIconChange} disabled={uploadingIcon} className="hidden" />
                </label>
                {iconUrl && (
                  <button
                    type="button"
                    onClick={() => setIconUrl("")}
                    className="text-[12px] font-semibold px-3 py-2 rounded"
                    style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: "pointer" }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            {error && (
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={closeModal}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading || uploadingIcon}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
              >
                {loading ? "Saving..." : modalMode === "edit" ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
