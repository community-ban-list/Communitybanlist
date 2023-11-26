const reasons = {
  Cheating: /cheat|hack|作弊|\bhile|trich|betr(ü|u)|Чітер|Софт|Чіти/i,
  Glitching: /glitch/i,
  Exploiting: /exploit|剝削|istismar|ausnutz/i,

  Teamkilling: /team ?kill|\btk|ITK|[0-9]x?tk|int?tk|team(be|ab)schuss/i,

  Trolling: /troll/i,
  Griefing: /gr(ie|ei)f/i,
  'Wasting Assets':
    /destroying assets|wast(e|ing)|taxi|israf|(friendly|dost) (asset|fob|hab)|sabotage|asset destruct|zerstör|verschwend|eigene(s)? (radio|fob|vehikel|fahrzeug|hab|hub)/i,
  Ghosting: /ghosting/i,

  Toxic:
    /disrespect|flam(e|ing)|har(r)?as(s)?|insult|language|offensive|rude|toxic|sayg(i|ı)s(i|ı)z|hakaret|irrespect|respektlos|beleidig(ung|en)/i,
  'Abusive Language/Hate Speech':
    /abusive|bigot|derogatory|discriminat|hate ?spe(e|a)ch|(homo|trans)(-| )?phobi|nazi|racial|rac(si|is)m|racist|sexism|sexist|(küfür|kufur)|mal(é|e)diction|種族主義|fluchen|semitism|nigg(a|er)|fag|slur|swastika|schimpfw(o|ö)rt|rassis(t|m)|missbr(a|ä)uch|(f|n)(-| )?(word|bomb)/i,

  AFK: /afk|unassigned/i,
  'Breaking Seeding Rules': /seed/i,
  'Breaking Vehicle Priority Rules':
    /priority|(ara(ç|c) (kural|ihlali))|(vic|vehicle|asset) (name )?claim|claim rule|ignor(ing|ed) claim/i,
  Camping: /camping|min(e|ing)/i,
  'Current or Recent VAC Ban': /vac ban/i,
  'Discussing politics': /politi(c|k|s)|siyaset/i,
  'Helicopter Ramming': /(ge)?ramm(ing|en|t)/i,
  Hindering: /(be|ver)?hinder(ing|ed|t|ung)/i,
  Impersonation: /impersonat|ausge(ge)?ben/i,
  'Locked Squad': /(locked|geschlossenes) squad/i,
  'No SL Kit': /sl kit/i,
  Recruiting: /recruiting|rekrutier/i,
  'Soloing Vehicles': /crewman|manning|solo|(1|one)(-| )?man/i,
  Spamming: /spam/i,
  'Squad Baiting':
    /bai(t|ting)|creat(?:ed?|ing)(?: a)? squad|pass sl|lead it|(of|to) lead|pas(s|sing)( |-)?SL/i,
  'Stealing Assets': /steal|çalma|(ge)?st(e|o)hlen/i,
  Streamsniping: /streamsniping|yayinc(i|ı)/i,
  'Sharing team info':
    /shar(e|ing) (ticket|team|hab|fob|info|game|enemy)|ticket (count|sharing)|(info|intel) shar(e|ing)/i,
  Advertising: /advertising|werb(ung|en)/i,
  Ableism: /ableis(t|m)/i,
  'Ban Evasion': /(alt|ban) evasion/i,
  'Current Events': /(current event|currentevent)/i
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
