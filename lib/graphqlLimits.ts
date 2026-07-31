// lib/graphqlLimits.ts
// SECURITY (July 31, 2026) — query depth + field-count limits for /api/graphql.
//
// WHY: the schema is cyclic (Player.tournaments -> Entrant.tournament ->
// Tournament.entrants -> Entrant.player -> Player.tournaments -> ...), and
// ApolloServer was constructed with no validationRules, no complexity limit
// and no depth limit at all. That let a single UNAUTHENTICATED request nest
// that cycle arbitrarily deep, with each extra level multiplying the DB work
// and response size. Measured against real production data before this
// landed: a 3-level nest already returned 32KB and grew roughly 14x per
// added level — comfortably enough to exhaust the Atlas M0 connection pool
// (which this project has already hit once) or the function timeout.
//
// WHY THESE NUMBERS: the deepest query the app itself issues is depth 5
// (app/tournaments/[id]/page.tsx and the stream view), so 10 leaves 2x
// headroom for future nesting while still bounding the blast radius. The
// field-count cap is a cheap complexity proxy aimed at the other shape of
// this attack — alias multiplication (`a1: players{...} a2: players{...}`
// x1000), which stays shallow and so slips past a depth limit alone.
//
// NOT a full cost-based complexity model: that would need per-field list-size
// estimates and is a real design decision. These two limits stop the
// pathological cases without changing how any legitimate query behaves.

import { GraphQLError, Kind } from "graphql";
import type {
  ASTVisitor,
  FragmentDefinitionNode,
  SelectionSetNode,
  ValidationContext,
} from "graphql";

export const MAX_QUERY_DEPTH = 10;
export const MAX_QUERY_FIELDS = 1500;

type Fragments = Record<string, FragmentDefinitionNode>;

// Walks a selection set, following fragment spreads, returning both the
// deepest field nesting and the total number of fields selected.
// visitedFragments guards against a self-referential fragment cycle sending
// this into infinite recursion (GraphQL validation rejects those separately,
// but this rule can run before that error surfaces).
function measure(
  selectionSet: SelectionSetNode,
  fragments: Fragments,
  visitedFragments: Set<string>
): { depth: number; fields: number } {
  let depth = 0;
  let fields = 0;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      fields++;
      if (selection.selectionSet) {
        const inner = measure(selection.selectionSet, fragments, visitedFragments);
        depth = Math.max(depth, 1 + inner.depth);
        fields += inner.fields;
      } else {
        depth = Math.max(depth, 1);
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      // An inline fragment is not itself a level of field nesting.
      const inner = measure(selection.selectionSet, fragments, visitedFragments);
      depth = Math.max(depth, inner.depth);
      fields += inner.fields;
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (visitedFragments.has(name)) continue;
      const fragment = fragments[name];
      if (!fragment) continue;
      visitedFragments.add(name);
      const inner = measure(fragment.selectionSet, fragments, visitedFragments);
      visitedFragments.delete(name);
      depth = Math.max(depth, inner.depth);
      fields += inner.fields;
    }
  }

  return { depth, fields };
}

export function createQueryLimitRule(
  maxDepth: number = MAX_QUERY_DEPTH,
  maxFields: number = MAX_QUERY_FIELDS
) {
  return function queryLimitRule(context: ValidationContext): ASTVisitor {
    return {
      Document(document) {
        const fragments: Fragments = {};
        for (const def of document.definitions) {
          if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
        }

        for (const def of document.definitions) {
          if (def.kind !== Kind.OPERATION_DEFINITION) continue;

          // Introspection is disabled in production anyway, but a real
          // IntrospectionQuery is legitimately ~11-13 levels deep — don't let
          // this rule break the Apollo sandbox in local development.
          const rootFields = def.selectionSet.selections.filter(s => s.kind === Kind.FIELD);
          const introspectionOnly =
            rootFields.length > 0 &&
            rootFields.every(
              s => s.kind === Kind.FIELD && s.name.value.startsWith("__")
            );
          if (introspectionOnly) continue;

          const { depth, fields } = measure(def.selectionSet, fragments, new Set());

          if (depth > maxDepth) {
            context.reportError(
              new GraphQLError(
                `Query is too deeply nested (${depth} levels; maximum is ${maxDepth}).`,
                { nodes: [def], extensions: { code: "QUERY_TOO_DEEP" } }
              )
            );
          }
          if (fields > maxFields) {
            context.reportError(
              new GraphQLError(
                `Query selects too many fields (${fields}; maximum is ${maxFields}).`,
                { nodes: [def], extensions: { code: "QUERY_TOO_LARGE" } }
              )
            );
          }
        }
      },
    };
  };
}
