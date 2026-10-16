import { STEAM_API_KEY } from 'scbl-lib/config';

// Steam's summary of a player gives their name and avatars. It comes from the host the importer
// uses, with the same key.
const PLAYER_SUMMARIES = 'https://partner.steam-api.com/ISteamUser/GetPlayerSummaries/v2/';

// Signing in waits for the summary, but the name and avatars are only for show, so Steam has this
// long to answer and a failed request is not made again. The player is then signed in with the
// name and avatars already saved.
const TIMEOUT = 5 * 1000;

// Look up a player's name and avatars by their Steam ID. Only that player's summary is used, so an
// answer without it fails like a failed request. The errors say why, but never give the request's
// address, as it holds the API key.
export default async function getSteamProfile(steamID) {
  const url = new URL(PLAYER_SUMMARIES);
  url.searchParams.set('key', STEAM_API_KEY);
  url.searchParams.set('steamids', steamID);

  let response;
  let answer;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    // Read the whole answer either way, which also frees the connection.
    answer = response.ok ? await response.json() : await response.text();
  } catch (err) {
    throw new Error(`Steam's player summary request failed (${reason(err)})`);
  }
  if (!response.ok)
    throw new Error(`Steam's player summary request failed (HTTP ${response.status})`);

  const players = answer?.response?.players;
  const player = Array.isArray(players)
    ? players.find((summary) => summary?.steamid === steamID)
    : undefined;
  if (typeof player?.personaname !== 'string')
    throw new Error("Steam's player summary did not include the player");

  return {
    name: player.personaname,
    // A player without avatars is saved with none.
    avatar: textOrNull(player.avatar),
    avatarMedium: textOrNull(player.avatarmedium),
    avatarFull: textOrNull(player.avatarfull)
  };
}

// Why a request failed, from the error's name or code only, as fetch's messages can include the
// address.
function reason(err) {
  if (err?.name === 'TimeoutError') return `no answer within ${TIMEOUT / 1000}s`;
  if (err?.name === 'SyntaxError') return 'the answer was not JSON';
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' ? code : String(err?.name ?? 'unknown error');
}

function textOrNull(value) {
  return typeof value === 'string' ? value : null;
}
