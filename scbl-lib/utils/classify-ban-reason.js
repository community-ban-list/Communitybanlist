// The categories a ban's reason is labelled with, each found by its keywords, in English and some
// German, Turkish, French, Chinese and Ukrainian. The website shows the labels in place of the
// reason. A keyword that is also part of everyday words is only found where it starts a word, or
// not next to the letters that make those words, so that ordinary wording is not shown as an
// accusation: "in words" is not hate speech, "determined" is not camping, and "someone managed" is
// not soloing vehicles. \b counts only ASCII letters, digits and _ as part of a word, so it is used
// only next to ASCII letters, and the keywords in other scripts are found anywhere, as before.
// scbl-lib/test/classify-ban-reason.js has examples of what the keywords find and what they do not.
// Only the importer and the scripts load this, in Node, so it may use lookbehinds. The website must
// not load it, as Safari before 16.4 cannot read them (see scbl-lib/test/player-ids.js).
const reasons = {
  // Need to organize
  // Not "shack" or "whack", "Dietrich" or "Strich", or "betrunken" (drunk). Betrug, Betrüger,
  // betrügen and betrogen are found.
  Cheating: /cheat|(?<![sw])hack|作弊|\bhile|\btrich|betr(ü|ue|u|o)g|Чітер|Софт|Чіти/i,
  Glitching: /glitch/i,
  Exploiting: /exploit|剝削|istismar|ausnutz/i,
  AdminAbuse: /admin ?abuse|abus(?:ed|ing|e of) ?(?:(?:admin)? ?(?:power))/i,
  // ITK only at the start of a word, so not in "mitkommen" or "Witkowski".
  Teamkilling: /team-?kill|team ?kill|\btk|\bitk|[0-9]x?tk|int?tk|team(be|ab)schuss/i,

  // Not "controlled", "Kontrolle", "patrolling" or "strolling".
  Trolling: /(?<![ck]on|pa|\bs)troll/i,
  // Griefing, also misspelt as greifing, but not German words with greif, such as "angreifen".
  Griefing: /grief|\bgreif(ing|er|ed)/i,
  // Not "taxing".
  'Wasting Assets':
    /destroying assets|wast(e|ing)|taxi(?!ng)|israf|(friendly|dost) (asset|fob|hab)|sabotage|asset destruct|zerstör|verschwend|eigene(s)? (radio|fob|vehikel|fahrzeug|hab|hub)/i,
  Ghosting: /ghosting/i,

  // Not "crude", "intrude", "prudent" or "Gertrude", nor "intoxicated".
  Toxic:
    /disrespect|flam(e|ing)|har(r)?as(s)?|insult|language|offensive|\brude|(?<!in)toxic|sayg(i|ı)s(i|ı)z|hakaret|irrespect|respektlos|beleidig(ung|en)/i,
  // The n-word and f-bombs, but not "in words", "own words" or "own bomb truck".
  'Abusive Language/Hate Speech':
    /abusive|bigot|derogatory|discriminat|hate ?spe(e|a)ch|(homo|trans)(-| )?phobi|nazi|racial|rac(si|is)m|racist|sexism|sexist|(küfür|kufur)|mal(é|e)diction|種族主義|fluchen|semitism|nigg(a|er)|fag|slur|swastika|schimpfw(o|ö)rt|rassis(t|m)|missbr(a|ä)uch|\b(f|n)(-| )?(word|bomb)/i,

  AFK: /afk|unassigned/i,
  'Breaking Seeding Rules': /seed/i,
  'Breaking Vehicle Priority Rules':
    /priority|(ara(ç|c) (kural|ihlali))|(vic|vehicle|asset) (name )?claim|claim rule|ignor(ing|ed) claim/i,
  // Main camping, and mines and mining, as in mining the enemy main, also landmines, mainmining,
  // Landminen and Panzerminen, but not "determined", "examined", "undermine" or "Minecraft".
  Camping: /camping|\b(land|main|panzer)?min(e(?!craft)|ing)/i,
  'Current or Recent VAC Ban': /vac ban/i,
  'Discussing politics': /politi(c|k|s)|siyaset/i,
  // Ramming, rammed, gerammt, rammt and rammen, but not "programming", "Programmen" or "cramming".
  'Helicopter Ramming': /(?<![cg])ramm(ing|ed|en|t)/i,
  Hindering: /(be|ver)?hinder(ing|ed|t|ung)/i,
  // Not "herausgegeben" (handed over).
  Impersonation: /impersonat|\bausge(ge)?ben/i,
  // Not "unlocked squad".
  'Locked Squad': /(\blocked|geschlossenes) squad/i,
  'No SL Kit': /sl kit/i,
  Recruiting: /recruiting|rekrutier/i,
  // Not "Solomon", nor "someone managed", "done many" or "1 Mannschaft" for one man.
  'Soloing Vehicles': /crewman|manning|solo(?!mon)|\b(1|one)(-| )?man(n|ned|s)?\b/i,
  Spamming: /spam/i,
  'Squad Baiting':
    /bai(t|ting)|creat(?:ed?|ing)(?: a)? squad|pass sl|lead it|(of|to) lead|pas(s|sing)( |-)?SL/i,
  // Not "stealth".
  'Stealing Assets': /steal(?!th)|çalma|(ge)?st(e|o)hlen/i,
  Streamsniping: /streamsniping|yayinc(i|ı)/i,
  'Sharing team info':
    /shar(e|ing) (ticket|team|hab|fob|info|game|enemy)|ticket (count|sharing)|(info|intel) shar(e|ing)/i,
  // Not "bewerben" or "Bewerbung" (apply, application), as in how to appeal a ban.
  Advertising: /advertis(?:ing|ement)|(?<!be)werb(ung|en)/i,
  Ableism: /ableis(t|m)/i,
  'Ban Evasion': /(alt|ban) evasion/i,
  'Current Events': /(current event|currentevent)/i,
  Pedophilia: /pedoph(il)?(ia|e)|paedoph(il)?(ia|e)|child porn|kinderporn|csam/i
};

export default function (...reason) {
  const classifiedReasons = [];

  for (const [type, regex] of Object.entries(reasons)) {
    if (regex.test(reason[0])) classifiedReasons.push(type);
  }

  if (classifiedReasons.length === 0 && reason.length > 1) {
    for (const [type, regex] of Object.entries(reasons)) {
      if (regex.test(reason[1])) classifiedReasons.push(type);
    }
  }
  classifiedReasons.sort();
  return classifiedReasons.length > 0 ? classifiedReasons.join(', ') : 'Unknown';
}
