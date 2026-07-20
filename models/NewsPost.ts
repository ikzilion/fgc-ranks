// models/NewsPost.ts
import { Schema, models, model } from "mongoose";

const NewsPostSchema = new Schema(
  {
    title: { type: String, required: true },
    // Plain text body — no markdown rendering exists anywhere else in this
    // codebase yet, so plain text is the simplest fit for Phase 1.
    content: { type: String, required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    // Optional — unset (missing/null) means a global homepage post, same
    // as before this field existed. Set means this post belongs to a
    // specific Event's own news section instead. See the newsPosts query's
    // eventId filter and createNewsPost/updateNewsPost/deleteNewsPost's
    // branching auth check (global posts stay ADMIN-only; Event posts are
    // gated on that Event's creator/managers instead).
    eventId: { type: Schema.Types.ObjectId, ref: "Event" },
  },
  { timestamps: true }
);

export const NewsPost = models.NewsPost || model("NewsPost", NewsPostSchema);
