// components/ManualBracketSlotSeeder.tsx
"use client";

// Shared by GenerateBracketButton (a standard tournament's own bracket) and
// GenerateMainBracketButton (a Pools + Bracket tournament's post-pool
// top-cut bracket) — both are structurally "one double-elimination bracket
// built from a flat list of participants," just a different participant
// list (raw entrants vs. the 2 pool advancers/pool), so this one component
// covers the MANUAL_BRACKET seeding method for both call sites.
//
// Renders an empty Round-1 shell (paired slots, matching
// buildDoubleEliminationBracket's own physical slot-i/slot-i+1 pairing) plus
// a sidebar of not-yet-placed participants. Native HTML5 drag-and-drop —
// this codebase has no dnd library dependency, and the interaction here
// (drag a sidebar chip into a slot, drag between slots to swap, drag a
// filled slot back onto the sidebar to clear it) doesn't need one.
//
// `slots` is the single source of truth: an array of length
// nextPowerOfTwo(participants.length), index i = physical Round-1 slot i,
// null = an intentional bye. The parent owns this state (so it can also
// gate its own Generate button on "every participant placed") and passes it
// down alongside the setter.

export interface ManualSeederParticipant {
  playerId: string;
  tag: string;
}

export function ManualBracketSlotSeeder({
  participants,
  slots,
  onSlotsChange,
}: {
  participants: ManualSeederParticipant[];
  slots: (string | null)[];
  onSlotsChange: (next: (string | null)[]) => void;
}) {
  const tagById = new Map(participants.map(p => [p.playerId, p.tag]));
  const placedIds = new Set(slots.filter((id): id is string => id != null));
  const unplaced = participants.filter(p => !placedIds.has(p.playerId));

  function placeInSlot(slotIndex: number, playerId: string) {
    const next = [...slots];
    const fromIndex = next.indexOf(playerId);
    // Swap: if the dragged participant came from another slot, whichever
    // occupant (or bye) was in the TARGET slot goes back to the SOURCE slot.
    // If they came from the sidebar (fromIndex === -1), the target slot's
    // previous occupant, if any, simply becomes unplaced again — nothing
    // else to write, since `slots` no longer references them anywhere.
    if (fromIndex !== -1) next[fromIndex] = next[slotIndex];
    next[slotIndex] = playerId;
    onSlotsChange(next);
  }

  function clearSlot(slotIndex: number) {
    const next = [...slots];
    next[slotIndex] = null;
    onSlotsChange(next);
  }

  function handleDragStart(e: React.DragEvent, playerId: string) {
    e.dataTransfer.setData("text/plain", playerId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDropOnSlot(e: React.DragEvent, slotIndex: number) {
    e.preventDefault();
    const playerId = e.dataTransfer.getData("text/plain");
    if (playerId) placeInSlot(slotIndex, playerId);
  }

  function handleDropOnSidebar(e: React.DragEvent) {
    e.preventDefault();
    const playerId = e.dataTransfer.getData("text/plain");
    if (!playerId) return;
    const fromIndex = slots.indexOf(playerId);
    if (fromIndex !== -1) clearSlot(fromIndex);
  }

  const pairs: [number, number][] = [];
  for (let i = 0; i < slots.length; i += 2) pairs.push([i, i + 1]);

  function SlotBox({ index }: { index: number }) {
    const playerId = slots[index];
    const tag = playerId ? tagById.get(playerId) : null;
    return (
      <div
        onDragOver={e => e.preventDefault()}
        onDrop={e => handleDropOnSlot(e, index)}
        draggable={playerId != null}
        onDragStart={e => playerId && handleDragStart(e, playerId)}
        data-slot-index={index}
        data-testid={`manual-slot-${index}`}
        className="flex-1 flex items-center gap-2 px-3 py-2 rounded-md text-[12px] min-w-0"
        style={{
          background: playerId ? "var(--navy-3)" : "transparent",
          border: playerId ? "1px solid var(--border-strong)" : "1px dashed var(--border)",
          cursor: playerId ? "grab" : "default",
        }}
      >
        <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0">{index + 1}</span>
        <span
          className="flex-1 truncate font-rajdhani font-semibold"
          style={{ color: playerId ? "var(--text-primary)" : "var(--text-muted)" }}
        >
          {tag ?? "Empty — bye"}
        </span>
        {playerId && (
          <button
            type="button"
            onClick={() => clearSlot(index)}
            aria-label={`Remove ${tag} from slot ${index + 1}`}
            className="text-[13px] leading-none flex-shrink-0"
            style={{ color: "var(--coral)", cursor: "pointer" }}
          >
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row gap-4">
      <div
        className="sm:w-48 flex-shrink-0"
        onDragOver={e => e.preventDefault()}
        onDrop={handleDropOnSidebar}
      >
        <p className="text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">
          Unplaced ({unplaced.length})
        </p>
        <div
          data-testid="unplaced-sidebar"
          className="flex flex-col gap-1.5 min-h-[48px] rounded-md p-2"
          style={{ border: "1px dashed var(--border-strong)" }}
        >
          {unplaced.length === 0 && (
            <p className="text-[11px] text-[var(--text-muted)] italic px-1 py-1">Every entrant is placed.</p>
          )}
          {unplaced.map(p => (
            <div
              key={p.playerId}
              draggable
              onDragStart={e => handleDragStart(e, p.playerId)}
              data-testid={`unplaced-${p.playerId}`}
              className="px-2 py-1.5 rounded text-[12px] font-rajdhani font-semibold truncate"
              style={{ background: "var(--navy-3)", color: "var(--text-primary)", border: "1px solid var(--border-strong)", cursor: "grab" }}
            >
              {p.tag}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">
          Round 1 ({slots.length} slots)
        </p>
        <div className="flex flex-col gap-2">
          {pairs.map(([a, b]) => (
            <div key={a} className="flex items-center gap-2 rounded-md p-1.5" style={{ background: "var(--navy-4)" }}>
              <SlotBox index={a} />
              <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0">vs</span>
              <SlotBox index={b} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
