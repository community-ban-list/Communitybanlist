import graphql from 'graphql';

import { PAGE_SIZE, largestPage, pageArgs } from './page-size.js';

const {
  GraphQLError,
  Kind,
  getNamedType,
  getNullableType,
  isListType,
  isObjectType,
  valueFromASTUntyped
} = graphql;

// The most one operation may cost, as queryCost works it out, and the most fields it may ask for at
// its top level. Each field at the top level runs on its own, such as a player lookup or a change
// to an export ban list. The site's own queries cost less than half as much, and each asks for one
// field at its top level.
export const QUERY_LIMITS = { cost: 20000, topLevelFields: 10 };

// A field costs this much for each row it can be returned for, or more when it has its own
// resolver, as that may look rows up in the database.
const FIELD_COST = 1;
const RESOLVER_COST = 10;

// The rows counted for a list without page arguments, such as the organisations or an export ban
// list's configs. Each has fewer today.
const LIST_ROWS = 25;

// The default page size of each list with page arguments, as its resolver passes it to pageArgs.
export const PAGE_DEFAULTS = {
  'Query.bans': PAGE_SIZE.list,
  'Query.steamUsers': PAGE_SIZE.list,
  'SteamUser.bans': PAGE_SIZE.playerBans
};

const hasPageArgs = (field) => field.args.some((arg) => arg.name === 'first');

// What the cost of a query depends on in this schema: which fields have their own resolvers, and
// which types are the connections that lists with page arguments return. Apollo Server gives every
// field a resolver when it runs its first request, so read these before then.
export function schemaCosts(schema) {
  const resolved = new Set();
  const connections = new Set();
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type)) continue;
    for (const field of Object.values(type.getFields())) {
      if (field.resolve) resolved.add(field);
      if (hasPageArgs(field)) connections.add(getNamedType(field.type));
    }
  }
  return { resolved, connections };
}

// How many rows a list with page arguments can return for those this field gives it: as many as
// pageArgs passes on to paginate for them, or the list's largest page when the page size comes
// from a variable, which could be any number.
function pageRows(node, fallback) {
  const args = new Map(node.arguments.map((arg) => [arg.name.value, arg.value]));
  const fromVariable = (name) => args.get(name)?.kind === Kind.VARIABLE;
  if (fromVariable('first') || fromVariable('last')) return largestPage(fallback);

  const value = (name) => (args.has(name) ? valueFromASTUntyped(args.get(name)) : undefined);
  const rows = (before) => {
    const page = pageArgs({ first: value('first'), last: value('last'), before }, fallback);
    return page.last ?? page.first;
  };
  // A cursor from a variable may or may not be given, so count the larger of the first page and
  // the page before a cursor.
  return fromVariable('before') ? Math.max(rows(undefined), rows('cursor')) : rows(value('before'));
}

// The cost of each operation in a document, and the number of fields at its top level. A field
// costs FIELD_COST, or RESOLVER_COST when it has its own resolver, for each row it can be returned
// for. A list with page arguments multiplies the rows of the fields under it by its page size, and
// any other list by LIST_ROWS, except that a connection's edges are the rows of its page and do not
// multiply again. __typename and the other __ fields are answered from the schema itself, so they
// cost nothing. Pass the schema's costs once Apollo Server may have run a request with it.
export function queryCost(document, schema, costs = schemaCosts(schema)) {
  const fragments = new Map();
  for (const definition of document.definitions)
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);

  // A fragment costs the same for each row wherever it is spread, so each is only worked out once,
  // however many times it is spread. One that spreads itself, which validation refuses, adds
  // nothing more.
  const fragmentCosts = new Map();
  function fragmentCost(name) {
    if (!fragmentCosts.has(name)) {
      fragmentCosts.set(name, 0);
      const fragment = fragments.get(name);
      if (fragment) {
        const type = schema.getType(fragment.typeCondition.name.value);
        fragmentCosts.set(name, cost(fragment.selectionSet, type));
      }
    }
    return fragmentCosts.get(name);
  }

  // How many rows of the fields under this field each row of its parent type can return.
  function rowsUnder(type, field, node) {
    if (hasPageArgs(field))
      return pageRows(node, PAGE_DEFAULTS[`${type.name}.${field.name}`] ?? PAGE_SIZE.max);
    if (isListType(getNullableType(field.type)) && !costs.connections.has(type)) return LIST_ROWS;
    return 1;
  }

  // The cost of these selections for one row of this type.
  function cost(selectionSet, type) {
    let total = 0;
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        total += fragmentCost(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        const condition = selection.typeCondition;
        total += cost(
          selection.selectionSet,
          condition ? schema.getType(condition.name.value) : type
        );
      } else {
        // The __ fields are not among a type's own fields.
        const field = isObjectType(type) ? type.getFields()[selection.name.value] : undefined;
        if (!field) continue;
        total += costs.resolved.has(field) ? RESOLVER_COST : FIELD_COST;
        if (selection.selectionSet)
          total +=
            rowsUnder(type, field, selection) *
            cost(selection.selectionSet, getNamedType(field.type));
      }
    }
    return total;
  }

  // The names the fields at the top level of these selections are answered under, including those
  // in fragments. Fields with the same name are answered once.
  function topLevelNames(selectionSet, names = new Set(), spread = new Set()) {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        if (!selection.name.value.startsWith('__'))
          names.add((selection.alias ?? selection.name).value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        topLevelNames(selection.selectionSet, names, spread);
      } else if (!spread.has(selection.name.value)) {
        spread.add(selection.name.value);
        const fragment = fragments.get(selection.name.value);
        if (fragment) topLevelNames(fragment.selectionSet, names, spread);
      }
    }
    return names;
  }

  return document.definitions
    .filter((definition) => definition.kind === Kind.OPERATION_DEFINITION)
    .map((operation) => {
      const type = schema.getRootType(operation.operation);
      return {
        operation,
        cost: type ? cost(operation.selectionSet, type) : 0,
        topLevelFields: topLevelNames(operation.selectionSet).size
      };
    });
}

// A validation rule that refuses any operation that costs more than QUERY_LIMITS.cost or asks for
// more than QUERY_LIMITS.topLevelFields fields at its top level, so that none of it runs. Make it
// with the schema before the server runs a request, as schemaCosts explains.
export function queryCostRule(schema) {
  const costs = schemaCosts(schema);
  return (context) => ({
    Document(document) {
      for (const { operation, cost, topLevelFields } of queryCost(document, schema, costs)) {
        const name = operation.name ? `Operation "${operation.name.value}"` : 'The operation';
        if (topLevelFields > QUERY_LIMITS.topLevelFields) {
          context.reportError(
            new GraphQLError(
              `${name} asks for ${topLevelFields} fields at its top level, and one request can ask ` +
                `for at most ${QUERY_LIMITS.topLevelFields}. Split it into several requests.`,
              { nodes: [operation] }
            )
          );
        } else if (cost > QUERY_LIMITS.cost) {
          context.reportError(
            new GraphQLError(
              `${name} asks for more than one request can answer: it costs more than ` +
                `${QUERY_LIMITS.cost}, counting each field once for each row it can be returned ` +
                `for, or ${RESOLVER_COST} times if it looks data up. Ask for smaller pages with ` +
                'first or last, or split it into several requests.',
              { nodes: [operation] }
            )
          );
        }
      }
      // Each operation has been checked, so the rest of the document need not be visited.
      return false;
    }
  });
}
