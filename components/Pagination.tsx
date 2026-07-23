// components/Pagination.tsx
// Shared page-size dropdown + numbered page nav for client-side-sliced
// lists (PlayerSearchFilter, TournamentSearchFilter). Purely presentational
// — the owning component holds page/pageSize state and does the slicing.
"use client";

const PAGE_SIZE_OPTIONS = [20, 50, 100];

// Windows the page numbers down to a fixed-width strip (first, last,
// current +/-1, with "..." filling the gaps) so this doesn't grow
// unbounded as the list does.
function getPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | "...")[] = [1];
  if (current > 3) pages.push("...");

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let p = start; p <= end; p++) pages.push(p);

  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}

export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  if (totalItems === 0) return null;

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const rangeStart = (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4">
      <p className="text-[12px] text-[var(--text-secondary)]">
        Showing {rangeStart}–{rangeEnd} of {totalItems}
      </p>

      <div className="flex items-center gap-3">
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onPageChange(page - 1)}
              disabled={page === 1}
              className="w-7 h-7 rounded text-[12px] font-bold"
              style={{
                background: "var(--navy-3)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-strong)",
                cursor: page === 1 ? "not-allowed" : "pointer",
                opacity: page === 1 ? 0.4 : 1,
              }}
              aria-label="Previous page"
            >
              ‹
            </button>

            {getPageNumbers(page, totalPages).map((p, i) =>
              p === "..." ? (
                <span key={`ellipsis-${i}`} className="w-7 text-center text-[12px] text-[var(--text-muted)]">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPageChange(p)}
                  className="w-7 h-7 rounded text-[12px] font-bold font-rajdhani"
                  style={{
                    background: p === page ? "var(--blue)" : "var(--navy-3)",
                    color: p === page ? "white" : "var(--text-secondary)",
                    border: "1px solid var(--border-strong)",
                    cursor: "pointer",
                  }}
                  aria-current={p === page ? "page" : undefined}
                >
                  {p}
                </button>
              )
            )}

            <button
              type="button"
              onClick={() => onPageChange(page + 1)}
              disabled={page === totalPages}
              className="w-7 h-7 rounded text-[12px] font-bold"
              style={{
                background: "var(--navy-3)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-strong)",
                cursor: page === totalPages ? "not-allowed" : "pointer",
                opacity: page === totalPages ? 0.4 : 1,
              }}
              aria-label="Next page"
            >
              ›
            </button>
          </div>
        )}

        <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          Per page
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value))}
            className="px-2 py-1.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
            style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
          >
            {PAGE_SIZE_OPTIONS.map(size => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
