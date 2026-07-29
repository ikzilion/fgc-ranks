// lib/accountDeletion.ts
// Service layer for the account-deletion grace-period feature (settled
// July 28, 2026, see the Notion "Account deletion is currently
// unrecoverable" writeup) -- kept separate from the resolvers per the "keep
// resolvers thin" convention, same as lib/streamAssets.ts/lib/ranking.ts.
//
// softDeletePlayer lives here (moved out of graphql/resolvers/index.ts)
// rather than staying resolver-local, specifically so lib/auth.ts's
// authorize() can call it too -- the lazy elapsed-scrub check needs to run
// at login time, not just from a GraphQL mutation.
import { head, del } from "@vercel/blob";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { Player } from "@/models/Player";
import { AccountDeletionAuditLog, AccountDeletionAuditAction } from "@/models/AccountDeletionAuditLog";
import { adjustBlobStorageUsage } from "@/lib/blobStorage";

// Requesting deletion no longer scrubs immediately -- confirmAccountDeletion
// schedules the real scrub this far out instead, giving a "cancel deletion"
// window for the case that started this whole feature: a compromised email
// account clicking through someone else's deletion link. 7 days matches the
// settled scope exactly (long enough to notice/react, short enough that a
// genuine deletion request doesn't sit around forever).
export const DELETION_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

// How long softDeletePlayer keeps the original tag/email recoverable for
// restoreDeletedPlayer (admin restore tool) before purgeExpiredScrubBackups
// clears them for good. 30 days -- long enough for a legitimate "I got
// hacked, please restore me" report to reach a Super Admin and get acted on
// (this is a low-traffic hobby project, not a 24/7-staffed service), short
// enough that the backup itself doesn't defeat the purpose of scrubbing PII
// in the first place. NOTE: the account's passwordHash is randomized at
// scrub time and is NOT part of this backup -- genuinely unrecoverable by
// design, so a restored account always needs a fresh password reset.
export const SCRUB_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function logAccountDeletionEvent(
  playerId: any,
  action: AccountDeletionAuditAction,
  meta: { ip?: string; performedByPlayerId?: string | null } = {}
): Promise<void> {
  await AccountDeletionAuditLog.create({
    playerId,
    action,
    ip: meta.ip ?? "unknown",
    performedByPlayerId: meta.performedByPlayerId ?? null,
  });
}

// Shared soft-delete implementation — used by the ADMIN deletePlayer
// mutation, the grace-period's lazy elapsed-scrub sweep below, and
// lib/auth.ts's authorize() (an elapsed pending-deletion account discovered
// at login time), so none of those paths can drift apart. Assumes the
// caller has already authorized the action (and already fetched `player`);
// this function itself performs no permission checks. Deletes the avatar
// from Vercel Blob, scrubs personal info, anonymizes the tag, retains a
// SCRUB_BACKUP_RETENTION_MS-long backup for restoreDeletedPlayer, and
// disables login on the linked User.
export async function softDeletePlayer(player: any, meta: { ip?: string; performedByPlayerId?: string | null } = {}): Promise<void> {
  if (player.isDeleted) return; // already deleted — idempotent

  if (player.avatarUrl) {
    try {
      // head() before del() -- the running storage total (lib/blobStorage.ts)
      // needs the blob's real size, and there's no way to ask for it once
      // it's gone. A failed head()/del() just skips the decrement rather
      // than blocking the rest of the soft-delete -- a display-only counter
      // drifting slightly beats account deletion failing over a blob issue.
      const { size } = await head(player.avatarUrl);
      await del(player.avatarUrl);
      await adjustBlobStorageUsage(-size);
    } catch (err) {
      console.error("[softDeletePlayer] Failed to delete avatar blob:", err);
    }
  }

  const deletedAt = new Date();
  // Suffix guarantees uniqueness against the Player.tag unique index even
  // across repeated deletions.
  const anonymizedTag = `Deleted Player #${player._id.toString().slice(-8)}`;
  const scrubBackupExpiresAt = new Date(deletedAt.getTime() + SCRUB_BACKUP_RETENTION_MS);

  await Player.findByIdAndUpdate(player._id, {
    isDeleted: true,
    deletedAt,
    tag: anonymizedTag,
    avatarUrl: "",
    region: "",
    team: "",
    // Restore window — see restoreDeletedPlayer/purgeExpiredScrubBackups.
    scrubBackupTag: player.tag,
  });

  if (player.userId) {
    const user = await User.findById(player.userId);
    if (user) {
      await User.findByIdAndUpdate(player.userId, {
        isDeleted: true,
        deletedAt,
        // Frees up the real email for reuse and removes it from the account
        // entirely; the random passwordHash is redundant with authorize()'s
        // isDeleted check but scrubs the credential too -- and is genuinely
        // NOT part of the restore backup below (see SCRUB_BACKUP_RETENTION_MS's
        // comment).
        email: `deleted-${player._id.toString()}@deleted.local`,
        passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
        deleteAccountTokenHash: null,
        deleteAccountTokenExpiry: null,
        // Clears out any still-pending grace-period state -- this scrub IS
        // the terminal outcome that state was tracking towards (or, for an
        // ADMIN-triggered immediate deletePlayer, there may never have been
        // any pending state to begin with; clearing null fields is a no-op).
        pendingDeletionRequestedAt: null,
        scheduledScrubAt: null,
        cancelDeletionTokenHash: null,
        cancelDeletionTokenExpiry: null,
        scrubBackupEmail: user.email,
        scrubBackupExpiresAt,
      });
    }
  }

  await logAccountDeletionEvent(player._id, AccountDeletionAuditAction.SCRUBBED, meta);
}

// No cron/scheduled-job infrastructure exists in this app (same reasoning
// as lib/ranking.ts's header comment) -- the grace period is enforced
// lazily instead. Called from app/api/graphql/route.ts's context factory on
// every GraphQL request (effectively all site traffic, see CLAUDE.md), so
// an elapsed pending-deletion account gets scrubbed the next time ANYONE's
// request touches the API, not just the account's own owner signing back
// in (which lib/auth.ts's authorize() separately, redundantly covers for
// the direct-login-attempt case, since that route never touches
// /api/graphql at all). Cheap sparse-indexed query, near-always an empty
// result at this app's scale (tens of players) -- see
// UserSchema.index({ scheduledScrubAt: 1 }).
export async function processElapsedPendingDeletions(): Promise<void> {
  const elapsed = await User.find({ scheduledScrubAt: { $ne: null, $lte: new Date() } });
  for (const user of elapsed) {
    const player = user.playerId ? await Player.findById(user.playerId) : null;
    if (player) {
      await softDeletePlayer(player, {});
    } else {
      // Orphaned pending state with no linked Player (shouldn't normally
      // happen) -- clear it directly rather than leaving a permanently
      // "elapsed but never resolved" record this sweep would otherwise
      // re-scan forever.
      await User.findByIdAndUpdate(user._id, { pendingDeletionRequestedAt: null, scheduledScrubAt: null, cancelDeletionTokenHash: null, cancelDeletionTokenExpiry: null });
    }
  }
}

// Same lazy, no-cron enforcement as processElapsedPendingDeletions, for the
// OTHER deferred-cleanup window this feature introduces: purges the
// restore-tool backup (User.scrubBackupEmail/Player.scrubBackupTag) once
// SCRUB_BACKUP_RETENTION_MS has passed since the scrub, so the "temporarily
// retained" backup doesn't quietly become permanent. Clearing
// Player.scrubBackupTag is what actually drops a player out of
// restorableDeletedPlayers (the admin restore tool's list).
export async function purgeExpiredScrubBackups(): Promise<void> {
  const expired = await User.find({ scrubBackupExpiresAt: { $ne: null, $lte: new Date() } });
  for (const user of expired) {
    await User.findByIdAndUpdate(user._id, { scrubBackupEmail: null, scrubBackupExpiresAt: null });
    if (user.playerId) {
      await Player.findByIdAndUpdate(user.playerId, { scrubBackupTag: null });
    }
  }
}

// The single entry point app/api/graphql/route.ts's context factory calls
// on every request -- both sweeps are cheap sparse-indexed queries that are
// near-always empty at this app's scale, so running them unconditionally on
// every request (rather than on some timer) is a non-issue, same tradeoff
// lib/ranking.ts's header comment makes for read-time computation over a
// cron this app has no infrastructure for. Self-contained
// connectToDatabase() call (unlike this file's other exports) since the
// context factory invokes this BEFORE any resolver -- which is what
// normally establishes the connection -- has run.
export async function runAccountDeletionMaintenance(): Promise<void> {
  await connectToDatabase();
  await processElapsedPendingDeletions();
  await purgeExpiredScrubBackups();
}
