import { Schema, models, model } from "mongoose";

// Single site-wide settings singleton (fixed _id, upserted) -- same
// one-document-per-concern pattern lib/blobStorage.ts's Counter document
// already uses for site-wide state, just a dedicated model instead of the
// generic Counter (that one's shape -- a single numeric `seq` -- doesn't
// fit a named theme string). Room to grow into other site-wide settings
// later without a new model, same way this one field already does.
const SiteSettingsSchema = new Schema({
  _id: { type: String, required: true },
  // Color theme system (settled July 29, 2026, see lib/theme.ts) -- one
  // active theme applies to every visitor at once, not a per-player
  // preference. Only a Super Admin can change it (setActiveTheme resolver).
  activeTheme: { type: String, default: "default" },
});

export const SiteSettings = models.SiteSettings || model("SiteSettings", SiteSettingsSchema);
