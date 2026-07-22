// components/AdminDashboard.tsx
// Tab switcher for the consolidated /admin page — each tab reuses the exact
// same manager component the standalone /admin/* pages already used, just
// fed from one combined fetch instead of each page doing its own. The
// `players` list is fetched once with every field either manager needs
// (user.role for AdminUserManager, user.isTO/createdAt for AdminTOManager)
// and passed to both — passing extra fields a component doesn't read is
// harmless, so no separate query/shape per tab is needed.
"use client";

import { useState } from "react";
import { AdminEventReviewCard } from "@/components/AdminEventReviewCard";
import { AdminGameManager } from "@/components/AdminGameManager";
import { AdminTOManager } from "@/components/AdminTOManager";
import { AdminUserManager } from "@/components/AdminUserManager";

type TabId = "events" | "games" | "to-status" | "users";

export function AdminDashboard({
  pendingEvents,
  games,
  pendingTORequests,
  players,
  showAdminRoles,
}: {
  pendingEvents: any[];
  games: any[];
  pendingTORequests: any[];
  players: any[];
  // Admin roles is SUPER_ADMIN-only (same gate as the standalone
  // /admin/users page) — the other three tabs are ADMIN-or-above, same as
  // this page's own notFound() gate.
  showAdminRoles: boolean;
}) {
  const [tab, setTab] = useState<TabId>("events");

  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: "events", label: "Review queue", count: pendingEvents.length },
    { id: "games", label: "Manage games", count: games.length },
    { id: "to-status", label: "Manage TOs", count: pendingTORequests.length },
    ...(showAdminRoles ? [{ id: "users" as TabId, label: "Admin roles", count: 0 }] : []),
  ];

  return (
    <>
      <div className="flex gap-2 mb-6 overflow-x-auto">
        {tabs.map(t => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="font-rajdhani text-[13px] font-bold tracking-wide px-4 py-2 rounded whitespace-nowrap flex-shrink-0"
              style={{
                background: active ? "var(--blue)" : "var(--navy-3)",
                color: active ? "white" : "var(--text-secondary)",
                border: "1px solid var(--border-strong)",
                cursor: "pointer",
              }}
            >
              {t.label}
              {(t.id === "events" || t.id === "to-status") && ` (${t.count})`}
            </button>
          );
        })}
      </div>

      {tab === "events" && (
        pendingEvents.length === 0 ? (
          <div className="fgc-card p-6">
            <p className="text-[var(--text-secondary)]">Nothing to review.</p>
          </div>
        ) : (
          pendingEvents.map(event => <AdminEventReviewCard key={event.id} event={event} />)
        )
      )}

      {tab === "games" && <AdminGameManager games={games} />}

      {tab === "to-status" && <AdminTOManager pendingRequests={pendingTORequests} players={players} />}

      {tab === "users" && showAdminRoles && <AdminUserManager players={players} />}
    </>
  );
}
