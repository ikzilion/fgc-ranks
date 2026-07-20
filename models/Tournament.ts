import { Schema, models, model } from "mongoose";

export enum TournamentStatus {
  UPCOMING = "UPCOMING",
  LIVE = "LIVE",
  ENDED = "ENDED",
  CANCELLED = "CANCELLED",
}

export enum TournamentVisibility {
  PUBLIC = "PUBLIC",
  PRIVATE = "PRIVATE",
}

const TournamentSchema = new Schema(
  {
    name: { type: String, required: true },
    game: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(TournamentStatus),
      default: TournamentStatus.UPCOMING,
    },
    // Only set when status is CANCELLED — shown on the tournament card/listing.
    cancellationReason: { type: String },
    // PUBLIC = listed and open to join (default, existing behavior).
    // PRIVATE = still visible on the list (locked, not hidden), but joining
    // requires an accepted invite from an organizer.
    visibility: {
      type: String,
      enum: Object.values(TournamentVisibility),
      default: TournamentVisibility.PUBLIC,
    },
    // Players invited to a PRIVATE tournament who haven't accepted (joined)
    // or declined yet. Cleared once a player joins or declines.
    invitedPlayerIds: [{ type: Schema.Types.ObjectId, ref: "Player" }],
    // Cached count — updated when entrants join/leave
    entrantCount: { type: Number, default: 0 },
    // Players with management access to this specific tournament (create/edit
    // matches, change status, etc.) — distinct from the global ADMIN role.
    // The creator is automatically added as the first organizer.
    organizers: [{ type: Schema.Types.ObjectId, ref: "Player" }],
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    // Stream/broadcast view (Phase 3) customization — TO-uploaded images via
    // the same Vercel Blob pattern as player avatars. Empty string = unset,
    // stream view falls back to design system defaults.
    streamBackgroundUrl: { type: String, default: "" },
    sponsorBannerUrl: { type: String, default: "" },
    // Bracket connector-line color, TO-customizable so it stays visible
    // against whatever stream background they pick. Empty = unset, bracket
    // rendering falls back to the design system default.
    bracketLineColor: { type: String, default: "" },
    // Match-card box background + text color, same TO-customizable/empty-is-
    // unset pattern as bracketLineColor above. Empty = unset, match cards
    // fall back to the design system defaults (.fgc-card background,
    // var(--text-primary) player-tag text).
    bracketBoxColor: { type: String, default: "" },
    bracketFontColor: { type: String, default: "" },
    // ── Metadata batch: logo, location, Twitch link, format, capacity,
    // entry fee/prize pot — all display/informational only, nothing here
    // drives enforcement (e.g. capacity never blocks joinTournament). ──
    logoUrl: { type: String, default: "" },
    // Mutually exclusive in practice (online-only tournaments have no
    // address, physical ones do) but not enforced against each other —
    // just two independent fields, same empty-is-unset convention as
    // everything else here.
    isOnlineOnly: { type: Boolean, default: false },
    address: { type: String, default: "" },
    twitchUrl: { type: String, default: "" },
    // Free-text label (e.g. "Double Elimination") — purely descriptive,
    // not a driver of actual bracket-generation logic.
    format: { type: String, default: "" },
    // No default — undefined means "no cap set", distinct from 0.
    capacity: { type: Number },
    // Free text rather than a Number, so a TO can write "$10" or "Free"
    // without needing separate currency-formatting fields.
    entryFee: { type: String, default: "" },
    prizePot: { type: String, default: "" },
    // Optional live link to an Event — when set, this tournament's
    // address/logoUrl/twitchUrl display values are resolved from the
    // LINKED EVENT's current data instead of this tournament's own fields
    // above (see the Tournament.address/logoUrl/twitchUrl field-resolver
    // overrides in graphql/resolvers/index.ts). The fields above stay
    // populated regardless, as the fallback for once unlinked/if the Event
    // is ever deleted — deleting an Event is explicitly allowed with
    // tournaments still linked to it (no block), and a dangling eventId
    // just resolves to nothing found, falling back automatically.
    eventId: { type: Schema.Types.ObjectId, ref: "Event" },
  },
  { timestamps: true }
);

export const Tournament = models.Tournament || model("Tournament", TournamentSchema);
