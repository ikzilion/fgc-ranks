import { ApolloServer } from "@apollo/server";
import { startServerAndCreateNextHandler } from "@as-integrations/next";
import { typeDefs } from "@/graphql/schema";
import { resolvers } from "@/graphql/resolvers";
import { auth } from "@/lib/auth";
import { createLoaders } from "@/graphql/loaders";
import { runAccountDeletionMaintenance } from "@/lib/accountDeletion";
import { createQueryLimitRule } from "@/lib/graphqlLimits";
import { NextRequest } from "next/server";

// validationRules (July 31, 2026): the schema is cyclic and had no depth or
// complexity limit, so one unauthenticated request could nest that cycle
// arbitrarily deep and multiply the DB work per level. See lib/graphqlLimits.ts.
const server = new ApolloServer({
  typeDefs,
  resolvers,
  validationRules: [createQueryLimitRule()],
});

const handler = startServerAndCreateNextHandler<NextRequest>(server, {
  context: async (req) => {
    const session = await auth();
    // Grace-period account deletion (settled July 28, 2026) — no cron/
    // scheduled-job infrastructure in this app, so an elapsed pending-
    // deletion window (or an expired restore-backup) is swept lazily here
    // instead, on every GraphQL request regardless of who's making it or
    // what they're asking for. Cheap sparse-indexed queries, near-always
    // empty at this app's scale — see lib/accountDeletion.ts.
    await runAccountDeletionMaintenance();
    return {
      req,
      userId: (session?.user as any)?.id,
      role: (session?.user as any)?.role,
      playerId: (session?.user as any)?.playerId,
      isTO: !!(session?.user as any)?.isTO,
      // Fresh per request -- see graphql/loaders.ts for why this can't be
      // hoisted above the context factory.
      loaders: createLoaders(),
    };
  },
});

export async function GET(request: NextRequest) {
  return handler(request);
}

export async function POST(request: NextRequest) {
  return handler(request);
}
