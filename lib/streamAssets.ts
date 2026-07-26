// lib/streamAssets.ts
// Service layer for a TO's reusable stream-background/sponsor-banner
// library (models/StreamAsset.ts) -- kept separate from the resolvers per
// the "keep resolvers thin" convention, same as lib/bracket.ts/lib/ranking.ts.
//
// Every stream-bg/sponsor-banner upload becomes a library entry immediately
// (recordStreamAssetUpload, called from app/api/upload/route.ts right after
// the real Vercel Blob put() succeeds) -- whether or not the TO ends up
// actually applying it to a tournament that session, since the whole point
// is "uploaded once, reusable later." The ONLY blob-deletion mechanism for
// these two asset types going forward is this file's retention-cap
// eviction, not the tournament-level "set active background" mutation --
// replacing a tournament's active asset with a different library entry (or
// a fresh upload) is just picking a different URL, not discarding the old
// one, since the whole point of the library is that old uploads stay
// around for reuse. Before this feature existed, EVERY replacement silently
// orphaned the previous blob (confirmed against the real Vercel Blob store
// during this task -- see the Notion "Ranking system"/"Stream asset
// library" writeup for the real orphan count found).
import { del } from "@vercel/blob";
import { StreamAsset, StreamAssetType } from "@/models/StreamAsset";
import { Tournament } from "@/models/Tournament";

// Per organizer, per asset type -- capped independently (10 backgrounds +
// 10 banners, not 10 combined) since they're shown in two separate pickers
// and mixing the caps would let uploading banners evict backgrounds, which
// would be a surprising cross-effect for no real benefit.
const RETENTION_CAP = 10;

// Records a real upload into the TO's library, then evicts anything beyond
// the most-recent 10 of that type -- deleting the evicted blob for real
// (not just unreferencing it). An asset still actively set as some
// tournament's current background/banner is pinned: excluded from the cap
// entirely (never evicted, and doesn't count against the 10), rather than
// just skipped in place -- so the cap always keeps exactly the 10 most
// recent NON-pinned entries, regardless of how many pinned ones exist
// alongside them. Eviction candidates are always old enough that pinning
// shouldn't normally trigger, but a TO could in principle still be actively
// using an old upload as a tournament's current asset.
export async function recordStreamAssetUpload(
  organizerId: string,
  type: StreamAssetType,
  url: string
): Promise<void> {
  await StreamAsset.create({ organizerId, type, url });

  const all = await StreamAsset.find({ organizerId, type }).sort({ createdAt: -1 });
  if (all.length <= RETENTION_CAP) return;

  const field = type === StreamAssetType.STREAM_BG ? "streamBackgroundUrl" : "sponsorBannerUrl";
  const activeTournaments = await Tournament.find({
    organizers: organizerId,
    [field]: { $in: all.map(a => a.url) },
  })
    .select(field)
    .lean();
  const pinnedUrls = new Set(activeTournaments.map((t: any) => t[field]));

  const evictable = all.filter(a => !pinnedUrls.has(a.url));
  const toEvict = evictable.slice(RETENTION_CAP);

  for (const asset of toEvict) {
    try {
      await del(asset.url);
    } catch (err) {
      console.error("[recordStreamAssetUpload] Failed to delete evicted blob:", err);
    }
    await StreamAsset.findByIdAndDelete(asset._id);
  }
}

// Most-recent-first, for the Stream Settings picker dropdown. Deliberately
// NOT .lean() -- the GraphQL StreamAsset.id field relies on Mongoose's
// default `id` virtual (a string getter over _id), which only exists on
// real Documents, not plain lean() objects.
export async function listStreamAssets(organizerId: string, type: StreamAssetType) {
  return StreamAsset.find({ organizerId, type }).sort({ createdAt: -1 });
}
