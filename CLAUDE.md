# FGC Hub — Claude Context

## Project Overview
A Fighting Game Community (FGC) web platform with two core features:
- **Tournament Tracker** — player brackets, match results, join tournaments
- **Player Records** — profiles, stats, and tournament history

## Tech Stack
- **Frontend:** Next.js 16 + Tailwind CSS
- **API:** GraphQL with Apollo Server (`@apollo/server` + `@as-integrations/next`)
- **Database:** MongoDB Atlas (Mongoose ODM)
- **Auth:** NextAuth.js v5 (credentials provider)
- **Rate limiting:** Upstash Redis + `@upstash/ratelimit` (login/register)
- **File storage:** Vercel Blob (player avatar images)
- **Hosting:** Vercel (single project)

## Project Structure
```
/
├── app/
│   ├── api/
│   │   ├── graphql/route.ts
│   │   ├── auth/[...nextauth]/route.ts
│   │   └── upload/route.ts
│   ├── (auth)/           # login, register
│   ├── tournaments/
│   │   ├── page.tsx
│   │   └── [id]/page.tsx
│   ├── players/          # page.tsx, [id]/page.tsx
│   ├── globals.css, layout.tsx, page.tsx
├── components/
│   ├── Navbar.tsx
│   ├── NotificationBell.tsx
│   ├── JoinTournamentButton.tsx
│   ├── ReportMatchButton.tsx
│   ├── EditProfileButton.tsx
│   ├── CreateTournamentButton.tsx
│   ├── DeleteTournamentButton.tsx
│   ├── TournamentStatusButton.tsx
│   ├── PlayerSearchFilter.tsx
│   └── CreateMatchButton.tsx
├── graphql/
│   ├── schema/index.ts
│   └── resolvers/index.ts
├── lib/                  # db.ts, auth.ts, testDb.ts, rateLimit.ts
├── models/                # User, Player, Tournament, Entrant, Match, Notification
└── scripts/               # makeAdmin.js
```

## Key Data Models
- **Player** — profile, stats, tournament history
- **Tournament** — brackets, rounds, match results, status (UPCOMING/LIVE/ENDED)
- **Entrant** — a player's participation in a specific tournament
- **Match** — a reported result between two entrants
- **User** — auth, linked to a player profile via `playerId`
- **Notification** — per-player, triggered inline by resolvers on match/tournament/join events

MongoDB collection names: players, tournaments, users, entrants, matches, notifications.

## Auth & Session
- `app/api/graphql/route.ts` calls `auth()` and passes `session` into Apollo context.
- Session data available: `session.user.email`, `session.user.tag`, `session.user.playerId`, `session.user.role`, `session.user.avatarUrl`.
- Permission/state gating is enforced in **both** the client component (UX) and the resolver (security) — never rely on the UI alone.
- Admin-only resolvers check `role`; `joinTournament` checks tournament status; notification resolvers check `playerId` ownership.
- Session data requires sign-out/sign-in to refresh after schema changes.

## GraphQL Schema Summary
- Types: `Player`, `Tournament`, `Entrant`, `Match`, `User`, `Notification`
- Mutations: `register`, `login`, `updatePlayer`, `createTournament`, `updateTournamentStatus`, `joinTournament` (status-gated), `setPlacement`, `createMatch`, `reportResult`, `deleteMatch`, `deleteTournament`, `leaveTournament`, `markNotificationRead`, `markAllNotificationsRead`

## Commands
```bash
npm run dev       # Start dev server (localhost:3000)
npm run build     # Production build
npm run lint      # Run ESLint
node scripts/makeAdmin.js
vercel env ls / vercel env add VARNAME environment / vercel env pull .env.local
```

## Environment Variables
Set in `.env.local` and Vercel (Production/Preview/Development) — never paste actual values into chat:
`MONGODB_URI`, `NEXTAUTH_SECRET`, `NEXT_PUBLIC_APP_URL`, `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID`, `BLOB_WEBHOOK_PUBLIC_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

## Design System
`app/globals.css` — navy/blue/coral/gold/green palette, Rajdhani + Inter fonts, scanline texture. Mobile responsive via `sm:` breakpoints.

## Conventions
- TypeScript throughout
- Tailwind for all styling (no external CSS unless necessary)
- GraphQL for all data fetching — no REST endpoints except `/api/graphql`, `/api/auth`, `/api/upload`
- Keep resolvers thin — business logic goes in separate service files
- When adding new features, always update the GraphQL schema first
- `cache: "no-store"` + absolute URLs for server-side fetches; `await params` in route handlers
- Server component + `await auth()` for "is this mine" checks
- Server-fetch + client-interactive component split
- Never nest interactive elements inside `<Link>`
- Confirm destructive actions with `confirm()` before executing
- File uploads go through `/api/upload` → Vercel Blob
- Status progression uses a lookup-object pattern to support non-linear transitions (e.g. ENDED → LIVE)
- Notifications are created inline in the triggering resolver; bulk-insert for multi-recipient events
- Beginner-friendly codebase — prefer clarity over cleverness; add comments to explain non-obvious logic
- Never hardcode or paste credentials into code, chat, or commits

## Links
- Production: https://fgc-ranks.vercel.app
- GitHub: https://github.com/ikzilion/fgc-ranks
- GraphQL endpoint: https://fgc-ranks.vercel.app/api/graphql (Apollo Sandbox UI is unreliable in-browser — query via PowerShell/curl instead)

---
**Source of truth for the current to-do list, in-flight implementation plans, and past gotchas:** the "FGC Hub — Claude Context" page in Notion. Check it for anything beyond this file's architectural scope.
