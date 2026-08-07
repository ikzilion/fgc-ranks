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

// Pool format Model A/B/C — which pool-stage model a "Pools + Bracket"
// tournament uses, chosen once at creation (see createTournament) and never
// re-derived; changing it after pools exist would invalidate their
// structure, so there's no update mutation for it. Irrelevant/unused for
// "Standard Bracket". B = EVO-style massive-scale continuous carry-over
// (128+ entrants only) — generateModelBPools builds Round 1,
// advanceModelBRound advances every round after (real results regrouped via
// lib/bracket.ts's computeNextRepooledRound) through to the real Finals
// bracket. Full per-pool UI polish and real-scale load-testing are still
// separate, later work, but the format itself is playable end to end.
export enum PoolModel {
  A = "A", // round-robin pools, fresh bracket restart
  B = "B", // EVO-style continuous carry-over — not buildable yet
  C = "C", // double-elim pools, fresh bracket restart (existing/default)
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
    // Sponsor banner slideshow (settled design, see the Notion "Sponsor
    // banner slideshow" writeup) -- when non-empty, the stream view rotates
    // through these instead of showing the single sponsorBannerUrl above.
    // Selected from the same reusable stream-asset library the single-banner
    // picker already draws from (models/StreamAsset.ts). Empty = no
    // slideshow configured, falls back to sponsorBannerUrl as before.
    //
    // Each entry carries its OWN optional click-through link (per-banner
    // links, settled July 28, 2026) -- a plain string array would need a
    // second parallel array to stay in sync by index for that, so this is a
    // small subdocument instead. _id: false since these are just an ordered
    // list, not independently referenced/queried documents.
    // NOTE: this field used to be a plain string array -- any pre-existing
    // data was migrated by scripts/migrateSponsorBannerUrlsShape.mjs before
    // this shape shipped; that script is safe to re-run if ever needed.
    sponsorBannerUrls: {
      type: [
        {
          url: { type: String, required: true },
          // "" = no click-through link, banner renders unclickable exactly
          // as before this feature existed. Same empty-is-unset convention
          // as every other optional URL field on this model.
          linkUrl: { type: String, default: "" },
          _id: false,
        },
      ],
      default: [],
    },
    // Required (validated + clamped 1-3600 in updateTournamentStreamAssets)
    // once sponsorBannerUrls has 2+ entries. Null/unset otherwise -- there's
    // no sensible hardcoded default to fall back to, the TO has to pick one.
    sponsorBannerIntervalSeconds: { type: Number, default: null },
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
    // Pool play + top-cut bracket format only ("Pools + Bracket" — see
    // format below). Set once generateMainBracket runs, after every Pool's
    // own Bracket has completed. null for a standard tournament, and null
    // for a "Pools + Bracket" tournament until its pool stage is done. The
    // existing single Bracket relationship (Tournament.bracket field
    // resolver, Bracket.findOne({tournamentId})) is untouched and keeps
    // working exactly as before for standard tournaments.
    mainBracketId: { type: Schema.Types.ObjectId, ref: "Bracket", default: null },
    // Set once at creation time (never re-derived) based on whether the
    // creator had TO status (or was an admin) at that moment — see
    // createTournament. `false`/unset (every pre-existing tournament) means
    // full capabilities, unchanged from before this flag existed — this
    // only ever restricts tournaments created going forward by a non-TO
    // player: forced PRIVATE visibility (permanently — updateTournamentVisibility
    // refuses PUBLIC on these), no stream background/sponsor banner
    // (updateTournamentStreamAssets refuses both), and excluded entirely
    // from the ranking/points computation (lib/ranking.ts).
    isRestricted: { type: Boolean, default: false },
    // See the PoolModel enum above. Every tournament created before this
    // field existed has it genuinely absent (not "C") in its stored
    // document — same situation as isRestricted above, so the Tournament.poolModel
    // field resolver coalesces the same way isRestricted's does.
    poolModel: { type: String, enum: Object.values(PoolModel), default: PoolModel.C },
    // Marks a tournament as an illustrative example/demo (e.g. the showcase
    // tournaments seeded to let visitors browse every bracket format) rather
    // than a real community competition. Purely a display flag — an
    // isExample tournament is otherwise a completely normal, fully
    // functional Tournament document (public listing, real bracket data,
    // etc.), just badged differently. Default false, same
    // absent-means-false convention as isRestricted for pre-existing docs.
    isExample: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Tournament = models.Tournament || model("Tournament", TournamentSchema);
