import { createHash } from 'crypto';

// SHA-256 of the placeholder secret the repository used to fall back to. It is public, so anyone
// could sign tokens with it.
const PLACEHOLDER_SECRET_HASH = '5f4b8fa611a50ed239a44a02e7567e28f0dfb233524d7a0eb13ac7ba55359efd';

// Secrets shorter than this can be guessed, so the web server warns about them.
const RECOMMENDED_SECRET_LENGTH = 32;

// Check the secret that signs sign-in tokens. Returns why the web server must not start with it,
// with `fatal`, or a warning to log, or null if it is fine.
export default function checkJwtSecret(secret) {
  if (typeof secret !== 'string' || secret.trim() === '')
    return { fatal: true, message: 'JWT_AUTH_SECRET is not set.' };

  // Compare without surrounding whitespace or quotes, so a copy of the placeholder pasted with them
  // is still caught. The secret itself is used exactly as given.
  const bare = secret
    .trim()
    .replace(/^(["'])(.*)\1$/s, '$2')
    .trim();

  if (createHash('sha256').update(bare).digest('hex') === PLACEHOLDER_SECRET_HASH)
    return {
      fatal: true,
      message: 'JWT_AUTH_SECRET is the placeholder that used to be in the public repository.'
    };

  if (bare.length < RECOMMENDED_SECRET_LENGTH)
    return {
      fatal: false,
      message: `JWT_AUTH_SECRET is shorter than ${RECOMMENDED_SECRET_LENGTH} characters, so it may be guessable.`
    };

  return null;
}
