import { Schema, models, model } from "mongoose";

export enum EventStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

// A venue/organization umbrella that Tournaments can link to — solves
// multi-game events (EVO, CEO, Frosty Faustings) without touching the
// Tournament/Bracket/Entrant model at all: each game just gets its own
// fully independent Tournament, linked to the same Event. See
// Tournament.eventId and the address/logoUrl/twitchUrl field-resolver
// overrides in graphql/resolvers/index.ts for the live-link mechanism.
const EventSchema = new Schema(
  {
    name: { type: String, required: true },
    // Human-friendly sequential ID (displayed as e.g. "EVT-000001" — see
    // lib/eventId.ts), assigned atomically via lib/counter.ts on creation,
    // same pattern as Player.playerNumber. This is what a TO types into a
    // tournament's "Event ID" field to link it — `sparse` so the unique
    // index doesn't choke on the (should-never-happen) case of a missing
    // value.
    eventNumber: { type: Number, unique: true, sparse: true },
    // Same isOnlineOnly + address pattern as Tournament's metadata batch —
    // independent fields, not validated against each other.
    isOnlineOnly: { type: Boolean, default: false },
    address: { type: String, default: "" },
    logoUrl: { type: String, default: "" },
    twitchUrl: { type: String, default: "" },
    // Free-text markdown source (settled July 28, 2026) — what the event
    // actually is, venue info, schedule notes, etc. Optional, same
    // empty-is-unset convention as every other free-text field here.
    // Rendered on the public Event page via components/MarkdownContent.tsx
    // -- see that file for why storing raw markdown here (rather than
    // sanitizing at write time) is still XSS-safe.
    description: { type: String, default: "" },
    // Social media links (settled July 28, 2026) — same fixed platform set
    // and generic-slot pattern as Player's own copy of these fields, see
    // models/Player.ts for the full explanation. Rendered via
    // components/SocialLinks.tsx, separate from twitchUrl above.
    twitterUrl: { type: String, default: "" },
    instagramUrl: { type: String, default: "" },
    youtubeUrl: { type: String, default: "" },
    discordUrl: { type: String, default: "" },
    tiktokUrl: { type: String, default: "" },
    otherLinkUrl: { type: String, default: "" },
    otherLinkLabel: { type: String, default: "" },
    // New Events start PENDING regardless of who creates them — hidden from
    // the public `events` list and `eventByDisplayId` lookup (so they can't
    // be linked to a Tournament) until an admin approves them via
    // approveEvent/rejectEvent. The creator can still view/edit their own
    // Event while PENDING or REJECTED via `event(id)`.
    status: {
      type: String,
      enum: Object.values(EventStatus),
      default: EventStatus.PENDING,
    },
    // Only set when status is REJECTED — cleared automatically on
    // resubmission (any updateEvent edit while REJECTED re-enters the queue
    // as PENDING) or on approval.
    rejectionReason: { type: String, default: "" },
    creatorId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    // The creator is always included here at creation — managerIds is the
    // single source of truth for "who can manage this Event" (no separate
    // "creator OR in managerIds" branching anywhere), same simplicity the
    // Tournament Organizer role already established for tournaments.
    managerIds: [{ type: Schema.Types.ObjectId, ref: "Player" }],
  },
  { timestamps: true }
);

export const Event = models.Event || model("Event", EventSchema);
