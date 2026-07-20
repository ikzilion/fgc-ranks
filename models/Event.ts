import { Schema, models, model } from "mongoose";

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
