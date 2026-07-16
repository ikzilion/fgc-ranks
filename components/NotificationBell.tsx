// components/NotificationBell.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

interface Notification {
  id: string;
  type: string;
  message: string;
  link?: string;
  read: boolean;
  createdAt: string;
}

export function NotificationBell() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Poll unread count every 30 seconds
  useEffect(() => {
    if (!session?.user) return;

    async function fetchUnreadCount() {
      try {
        const res = await fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `query { unreadNotificationCount }` }),
        });
        const json = await res.json();
        setUnreadCount(json.data?.unreadNotificationCount ?? 0);
      } catch {
        // silent fail — not critical
      }
    }

    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [session]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  async function handleOpen() {
    setOpen(!open);
    if (!open) {
      setLoading(true);
      try {
        const res = await fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query { myNotifications { id type message link read createdAt } }`,
          }),
        });
        const json = await res.json();
        setNotifications(json.data?.myNotifications ?? []);
      } catch {
        // silent fail
      }
      setLoading(false);
    }
  }

  async function handleMarkAllRead() {
    try {
      await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `mutation { markAllNotificationsRead }` }),
      });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {
      // silent fail
    }
  }

  async function handleNotificationClick(notif: Notification) {
    if (!notif.read) {
      try {
        await fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `mutation MarkRead($id: ID!) { markNotificationRead(id: $id) }`,
            variables: { id: notif.id },
          }),
        });
        setNotifications(prev => prev.map(n => (n.id === notif.id ? { ...n, read: true } : n)));
        setUnreadCount(prev => Math.max(0, prev - 1));
      } catch {
        // silent fail
      }
    }
    setOpen(false);
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  if (!session?.user) return null;

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={handleOpen}
        style={{
          position: "relative",
          width: "32px",
          height: "32px",
          borderRadius: "6px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-secondary)",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: "2px",
              right: "2px",
              minWidth: "16px",
              height: "16px",
              borderRadius: "8px",
              background: "var(--coral)",
              color: "white",
              fontSize: "10px",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 3px",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fgc-card"
          style={{
            position: "absolute",
            top: "40px",
            right: 0,
            width: "320px",
            maxHeight: "400px",
            overflowY: "auto",
            zIndex: 100,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
            <span className="font-rajdhani" style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                style={{ fontSize: "11px", color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }}
              >
                Mark all read
              </button>
            )}
          </div>

          {loading && (
            <p style={{ padding: "16px", fontSize: "12px", color: "var(--text-secondary)" }}>Loading...</p>
          )}

          {!loading && notifications.length === 0 && (
            <p style={{ padding: "16px", fontSize: "12px", color: "var(--text-secondary)" }}>No notifications yet.</p>
          )}

          {!loading &&
            notifications.map(notif => (
              <Link
                key={notif.id}
                href={notif.link || "#"}
                onClick={() => handleNotificationClick(notif)}
                style={{
                  display: "block",
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--border)",
                  textDecoration: "none",
                  background: notif.read ? "transparent" : "var(--blue-dim)",
                }}
              >
                <p style={{ fontSize: "12px", color: "var(--text-primary)", marginBottom: "2px" }}>{notif.message}</p>
                <p style={{ fontSize: "10px", color: "var(--text-muted)" }}>{timeAgo(notif.createdAt)}</p>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
