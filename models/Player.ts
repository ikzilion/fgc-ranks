import { Schema, models, model } from "mongoose";

const PlayerSchema = new Schema(
  {
    // Link back to the auth User account
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    tag: { type: String, required: true, unique: true },
    // Human-friendly sequential ID (displayed as e.g. "FGC-000001" — see
    // lib/playerId.ts for the formatter), assigned atomically via
    // lib/counter.ts on creation. Foundation for the separately-backlogged
    // QR-based tournament check-in feature. `sparse` so the unique index
    // tolerates older documents that haven't been backfilled yet.
    playerNumber: { type: Number, unique: true, sparse: true },
    region: { type: String, default: "" },
    // Free-text team affiliation label — not a structured Team entity with
    // its own roster/page, just an optional tag on the player, same
    // simplicity level as `region`.
    team: { type: String, default: "" },
    avatarUrl: { type: String, default: "" },
    // Simple URL/username field, same free-text level as `team` — parsed
    // down to a bare username by lib/twitch.ts's extractTwitchUsername for
    // the live-status check, not validated strictly at write time.
    twitchUrl: { type: String, default: "" },
    // Social media links (settled July 28, 2026) — same fixed platform set
    // as Event's own copy of these fields (see models/Event.ts), same
    // empty-is-unset free-text convention as twitchUrl above. Rendered via
    // components/SocialLinks.tsx, separate from the Twitch link above (which
    // keeps its own dedicated spot + live-status badge).
    twitterUrl: { type: String, default: "" },
    instagramUrl: { type: String, default: "" },
    youtubeUrl: { type: String, default: "" },
    discordUrl: { type: String, default: "" },
    tiktokUrl: { type: String, default: "" },
    // Generic "website/other" slot — one only (not an arbitrary-length
    // list), pairs a URL with a short user-typed label (e.g. "My website",
    // "Linktree"). otherLinkUrl unset makes otherLinkLabel irrelevant
    // (SocialLinks only renders this pair when otherLinkUrl is set).
    otherLinkUrl: { type: String, default: "" },
    otherLinkLabel: { type: String, default: "" },
    // Array of character names this player mains
    characters: { type: [String], default: [] },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    // Soft-delete (admin-triggered account deletion) — see deletePlayer
    // resolver. The document itself is kept (not removed) so existing
    // Match/Entrant/Tournament/Event references keep resolving; the
    // `players` list query filters these out going forward, but
    // `player(id)`/`playerByTag` deliberately still resolve them.
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    // Restore window (settled July 28, 2026) -- see User.scrubBackupEmail
    // for the full explanation; this is the tag half of the same backup
    // pair, set by softDeletePlayer and cleared either by
    // restoreDeletedPlayer (admin restore) or purgeExpiredScrubBackups once
    // the retention window elapses (lib/accountDeletion.ts). Non-null here
    // is exactly "restorable right now" -- the restorableDeletedPlayers
    // admin query filters on this field directly.
    scrubBackupTag: { type: String, default: null },
  },
  { timestamps: true }
);

// Virtual computed field: winRate = wins / (wins + losses)
PlayerSchema.virtual("winRate").get(function () {
  const total = this.wins + this.losses;
  return total === 0 ? 0 : Math.round((this.wins / total) * 100) / 100;
});

export const Player = models.Player || model("Player", PlayerSchema);
