// Regression guard for the July 31, 2026 production upload outage.
//
// THE OUTAGE: every /api/upload request 500'd with
//   TypeError: ArrayBuffer: SharedArrayBuffer is not allowed
// thrown from inside Next's BUNDLED fetch (@edge-runtime/primitives, which
// wraps undici's webidl BufferSource conversion). That conversion's gate is
// literally `util.types.isSharedArrayBuffer(view.buffer)` — see
// node_modules/undici/lib/web/fetch/webidl.js — and put() is the only fetch
// in that route with a buffer body.
//
// ROOT CAUSE: the route's own earlier rewrite changed `storedBody` from the
// `File` object (which fetch consumes natively as a Blob) to
// `Buffer.from(await file.arrayBuffer())`. Buffer.from(ArrayBuffer) creates a
// VIEW, not a copy, so the request body inherited whatever backing store the
// runtime allocated for the uploaded file. On Vercel that is shared memory.
// A local Node build does not use shared memory there — which is exactly why
// this passed every local test and only ever failed in production, and is why
// this test asserts against undici's REAL predicate rather than trying to
// reproduce the runtime difference.
//
// Run: npx tsx scripts/testUploadBodyNotShared.mjs

import util from "node:util";

const { toUploadBody } = await import("../lib/uploadSecurity");

let passed = 0, failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

// The exact gate undici applies to a fetch body.
const rejectedByFetch = view => util.types.isSharedArrayBuffer(view.buffer);

console.log("\n1. Reproduce the production condition: a SHARED-memory-backed body");
const sab = new SharedArrayBuffer(256);
const shared = new Uint8Array(sab);
for (let i = 0; i < shared.length; i++) shared[i] = i % 256;

check("fixture really is shared-backed", rejectedByFetch(shared));
check(
  "…and would therefore be REJECTED by fetch (this was the outage)",
  rejectedByFetch(shared)
);

console.log("\n2. The naive form that caused it — Buffer.from(arrayBuffer) ALIASES, not copies");
const aliased = Buffer.from(sab);
check("Buffer.from(sab) still shared-backed (NOT a fix)", rejectedByFetch(aliased));
check("…and it aliases the same memory", aliased.buffer === sab);

console.log("\n3. toUploadBody() — the fix");
const fixed = toUploadBody(shared);
check("result is NOT shared-backed", !rejectedByFetch(fixed));
check("result would be ACCEPTED by fetch", !rejectedByFetch(fixed));
check("backing store is a plain ArrayBuffer", fixed.buffer.constructor.name === "ArrayBuffer");
check("does not alias the original", fixed.buffer !== sab);
check("offset 0", fixed.byteOffset === 0);
check("exact size (no pool slack)", fixed.buffer.byteLength === shared.byteLength);
check("bytes preserved byte-for-byte", Buffer.compare(Buffer.from(fixed), Buffer.from(shared)) === 0);

console.log("\n4. Mutating the source must not change the copy (proves a real copy)");
const before = fixed[10];
shared[10] = (shared[10] + 7) % 256;
check("copy unchanged after source mutation", fixed[10] === before);

console.log("\n5. Normal (non-shared) bodies still pass through correctly");
for (const [label, src] of [
  ["Buffer.alloc", Buffer.alloc(64, 3)],
  ["pooled Buffer.from(array)", Buffer.from([1, 2, 3, 4, 5])],
  ["plain Uint8Array", new Uint8Array([9, 8, 7])],
]) {
  const out = toUploadBody(src);
  check(
    `${label}: not shared, offset 0, bytes preserved`,
    !rejectedByFetch(out) && out.byteOffset === 0 &&
      Buffer.compare(Buffer.from(out), Buffer.from(src)) === 0
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
