# FGC Website — Claude Context

## Project Overview
A Fighting Game Community (FGC) web platform with two core features:
- **Tournament Tracker** — player brackets and match results
- **Player Records** — profiles, stats, and tournament history

## Tech Stack
- **Frontend:** Next.js + Tailwind CSS
- **API:** GraphQL with Apollo Server
- **Database:** MongoDB Atlas (NoSQL)
- **Auth:** NextAuth.js
- **Hosting:** Vercel (frontend) + MongoDB Atlas (database)

## Project Structure
```
/
├── app/                  # Next.js app directory
│   ├── (auth)/           # Auth routes
│   ├── tournaments/      # Tournament pages
│   └── players/          # Player profile pages
├── components/           # Reusable UI components
├── graphql/
│   ├── schema/           # GraphQL type definitions
│   └── resolvers/        # GraphQL resolvers
├── lib/
│   ├── db.ts             # MongoDB connection
│   └── auth.ts           # NextAuth config
└── models/               # MongoDB schemas (Mongoose)
```

## Key Data Models
- **Player** — profile, stats, tournament history
- **Tournament** — brackets, rounds, match results
- **User** — auth, linked to player profile

## Commands
```bash
npm run dev       # Start dev server (localhost:3000)
npm run build     # Production build
npm run lint      # Run ESLint
```

## Conventions
- Use TypeScript throughout
- Tailwind for all styling (no external CSS unless necessary)
- GraphQL for all data fetching (no REST endpoints)
- Keep resolvers thin — business logic goes in separate service files
- MongoDB collection names: players, tournaments, users

## Notes
- Beginner-friendly codebase — prefer clarity over cleverness
- Add comments to explain non-obvious logic
- When adding new features, always update the GraphQL schema first
