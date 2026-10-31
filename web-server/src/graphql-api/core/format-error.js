import graphql from 'graphql';

import { DATABASE_UNAVAILABLE_MESSAGE, isDatabaseUnavailable } from 'scbl-lib/db/sequelize';

import { inDevelopment } from '../../production.js';

const { GraphQLError } = graphql;

// What the client is told when part of a request fails. The errors the API gives on purpose are
// shown as they are, as they say what was wrong or what to do: a request GraphQL could not read,
// check or run, a page cursor the API cannot use, a list that does not exist, a value out of
// bounds, a limit reached, signing in again, or what BattleMetrics answered.
//
// Any other error is one the client did not cause, such as the database's or a bug's, whose message
// would mean nothing to the user and can name the database's tables or the server's code. The
// client is only told that the server had an error, and the error is logged. While the database
// cannot be reached, e.g. as it restarts, the client is told that instead.

const INTERNAL_SERVER_ERROR = 'Internal server error';

export default function formatError(formattedError, error) {
  const thrown = thrownError(error);
  if (isDatabaseUnavailable(thrown))
    return { ...formattedError, message: DATABASE_UNAVAILABLE_MESSAGE };
  if (isForClient(thrown))
    return inDevelopment ? formattedError : withoutSuggestions(formattedError);

  logHidden(formattedError.path?.join('.') ?? 'a request', thrown);
  // The path and locations only say which of the fields the client asked for failed.
  return {
    ...formattedError,
    message: INTERNAL_SERVER_ERROR,
    extensions: { code: 'INTERNAL_SERVER_ERROR' }
  };
}

// The error that was thrown. GraphQL and Apollo Server hold it as the originalError of the
// GraphQLErrors they wrap it in, e.g. for one a resolver threw, or one thrown while a request's
// context was made.
function thrownError(error) {
  let thrown = error;
  while (thrown instanceof GraphQLError && thrown.originalError) thrown = thrown.originalError;
  return thrown;
}

// Whether an error's message is for the client, as the API gives it on purpose: a GraphQLError, as
// GraphQL gives for a request it cannot read, check or run, and the API throws for one it cannot
// answer; an ApiError, as the BattleMetrics client gives, which names the request that failed but
// never its address, headers or key (scbl-lib/apis/create-api-client.js); or a plain Error, as the
// resolvers and the code they call throw them. ApiErrors and plain Errors are told apart by the
// names their classes set, so none of their code is needed. Node's errors, such as for a failed
// connection, and the MySQL driver's are often plain Errors too, but they carry an errno or a code,
// which the API's own plain Errors never do, and their messages can name the server's addresses.
function isForClient(error) {
  if (error instanceof GraphQLError || error?.name === 'ApiError') return true;
  return error?.name === 'Error' && error.errno === undefined && error.code === undefined;
}

// GraphQL suggests names that exist for one that does not. Outside development Apollo Server
// removes the suggestions from its errors for a request's fields and arguments
// (hideSchemaDetailsFromClientErrors in index.js), but not from those for its variables, such as an
// enum value that does not exist, so they are removed here, the same way.
function withoutSuggestions(formattedError) {
  if (formattedError.extensions?.code !== 'BAD_USER_INPUT') return formattedError;
  return {
    ...formattedError,
    message: formattedError.message.replace(/ ?Did you mean(.+?)\?$/, '')
  };
}

// The errors hidden from the client while Apollo Server formats a response's errors, which it does
// one after another, by their descriptions, each with the first field it failed, how many others it
// failed and, in development, where it was thrown. They are logged once it has, in a line for each,
// so an error that fails every item of a list, as the database's can, is logged once for the
// response rather than once for each item.
let hidden = null;

function logHidden(where, error) {
  if (!hidden) {
    hidden = new Map();
    Promise.resolve().then(logHiddenErrors);
  }
  const description = describe(error);
  const seen = hidden.get(description);
  if (seen) seen.others++;
  else hidden.set(description, { where, others: 0, stack: stackFrames(error) });
}

function logHiddenErrors() {
  const errors = hidden;
  hidden = null;
  for (const [description, { where, others, stack }] of errors) {
    const also = others === 0 ? '' : ` and ${others} other field${others === 1 ? '' : 's'}`;
    console.error(
      `${INTERNAL_SERVER_ERROR} in ${where}${also}, not shown to the client: ${description}${stack}`
    );
  }
}

// An error by its name and message, in a line, as scbl-lib's describeError gives it, and never
// whole, so not, e.g., the SQL that Sequelize's errors hold. GraphQL wraps a thrown value that is
// not an error in a NonErrorThrown whose message is the value's text, so such a value, like any
// other that is not an error, is only named by its type, as its text could hold anything.
function describe(error) {
  const value = error?.name === 'NonErrorThrown' ? error.thrownValue : error;
  if (typeof value?.message !== 'string')
    return `a thrown ${Object.prototype.toString.call(value)}`;
  return `${value.name}: ${value.message}`.replace(/\s+/g, ' ').trim();
}

// Where an error was thrown, in development, as no response says so: the lines of its stack trace
// that name a function and file, each on a line of its own, as scbl-lib's stackTrace gives them.
function stackFrames(error) {
  if (!inDevelopment || typeof error?.stack !== 'string') return '';
  return error.stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .map((line) => `\n${line}`)
    .join('');
}
