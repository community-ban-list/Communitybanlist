import typedef from './typedef.js';
import unguarded from './resolver.js';
import guardChanges from './guard-changes.js';

// Changes need signing in, each user's are made one at a time, and creating and deleting export
// ban lists is limited, as guard-changes.js describes.
const resolver = { ...unguarded, Mutation: guardChanges(unguarded.Mutation) };

export { typedef, resolver };
