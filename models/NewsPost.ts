// models/NewsPost.ts
import { Schema, models, model } from "mongoose";

const NewsPostSchema = new Schema(
  {
    title: { type: String, required: true },
    // Plain text body — no markdown rendering exists anywhere else in this
    // codebase yet, so plain text is the simplest fit for Phase 1.
    content: { type: String, required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
  },
  { timestamps: true }
);

export const NewsPost = models.NewsPost || model("NewsPost", NewsPostSchema);
