import assert from 'assert';

import classifyBanReason from '../utils/classify-ban-reason.js';
import * as utils from '../utils/index.js';

// The importer labels each ban with the categories its reason's keywords find, and the website
// shows the labels in place of the reason, so a keyword found inside an unrelated word shows an
// accusation the reason never made. Each reason below is given with the labels it gets.

// The n-word is a keyword, and the rows that check it is still found are built from its stem, as the
// classifier spells it, so that the slur itself is not written out here.
const nWordStem = 'nigg';

// Reasons whose keywords are found: plurals and other forms, compounds, and the keywords in German,
// Turkish, French, Chinese and Ukrainian, of which those with letters other than a to z are found
// anywhere in a word, as before.
const found = [
  // Cheating.
  ['Cheating', 'Cheating'],
  ['Cheater, banned on sight', 'Cheating'],
  ['Hacker', 'Cheating'],
  ['Wallhacks', 'Cheating'],
  ['speedhacking', 'Cheating'],
  ['Glowhack', 'Cheating'],
  ['hile', 'Cheating'],
  ['Hileci', 'Cheating'],
  ['triche', 'Cheating'],
  ['Tricheur', 'Cheating'],
  ['Betrug', 'Cheating'],
  ['Betrugsversuch', 'Cheating'],
  ['Betrüger', 'Cheating'],
  ['BETRÜGER', 'Cheating'],
  ['Betrueger', 'Cheating'],
  ['betrügen', 'Cheating'],
  // Betrüger with ü written as u and a combining diaeresis.
  ['Betru\u0308ger', 'Cheating'],
  // The past participle of betrügen, which the keyword missed before.
  ['Hat betrogen', 'Cheating'],
  ['作弊', 'Cheating'],
  ['Чітер', 'Cheating'],
  ['чіти', 'Cheating'],
  ['Софт', 'Cheating'],

  // Teamkilling.
  ['Teamkilling', 'Teamkilling'],
  ['team kill', 'Teamkilling'],
  ['team-kills', 'Teamkilling'],
  ['TK', 'Teamkilling'],
  ['TKing', 'Teamkilling'],
  ['Intentional TK', 'Teamkilling'],
  ['ITK', 'Teamkilling'],
  ['ITKs', 'Teamkilling'],
  ['3xTK', 'Teamkilling'],
  ['5tk', 'Teamkilling'],
  ['3xITK', 'Teamkilling'],
  ['2ITK', 'Teamkilling'],
  ['HeliTK on friendlies', 'Teamkilling'],
  ['LogiTK', 'Teamkilling'],
  ['MultiTK', 'Teamkilling'],
  ['IntTK', 'Teamkilling'],
  ['Teambeschuss', 'Teamkilling'],
  ['Teamabschuss', 'Teamkilling'],

  // Trolling.
  ['Trolling', 'Trolling'],
  ['trolled', 'Trolling'],
  ['mictrolling', 'Trolling'],
  ['Trollen', 'Trolling'],
  ['getrollt', 'Trolling'],
  ['Hasstroll', 'Trolling'],

  // Griefing, also misspelt.
  ['Griefing', 'Griefing'],
  ['Griefer', 'Griefing'],
  ['teamgriefing', 'Griefing'],
  ['griefen', 'Griefing'],
  ['gegrieft', 'Griefing'],
  ['greifing', 'Griefing'],
  ['greifers', 'Griefing'],
  ['greifed the FOB', 'Griefing'],
  ['teamgreifing at fob', 'Griefing'],
  ['Hat gegreift', 'Griefing'],

  // Wasting assets, also "taxing", as taxiing is often spelt.
  ['Wasting assets', 'Wasting Assets'],
  ['taxi', 'Wasting Assets'],
  ['taxiing players', 'Wasting Assets'],
  ['Helitaxi', 'Wasting Assets'],
  ['Heli taxing players around', 'Wasting Assets'],
  ['israf', 'Wasting Assets'],
  ['zerstört', 'Wasting Assets'],
  ['verschwendet', 'Wasting Assets'],

  // Toxic.
  ['toxic in chat', 'Toxic'],
  ['Toxicity', 'Toxic'],
  ['rude', 'Toxic'],
  ['Rudeness', 'Toxic'],
  ['rudely', 'Toxic'],
  ['saygısız', 'Toxic'],
  ['saygisiz', 'Toxic'],
  ['hakaret', 'Toxic'],
  ['respektlos', 'Toxic'],
  ['Beleidigung', 'Toxic'],

  // Abusive language and hate speech.
  ['n-word', 'Abusive Language/Hate Speech'],
  ['N word', 'Abusive Language/Hate Speech'],
  ['nword', 'Abusive Language/Hate Speech'],
  ['Repeated n-words in chat', 'Abusive Language/Hate Speech'],
  ['Saying n words', 'Abusive Language/Hate Speech'],
  ['n-wording in local', 'Abusive Language/Hate Speech'],
  // The n-word itself, also written together with a word before it, as in a player's name.
  [`Said ${nWordStem}er in chat`, 'Abusive Language/Hate Speech'],
  [`Name was Big${nWordStem}a`, 'Abusive Language/Hate Speech'],
  ['f-bombs', 'Abusive Language/Hate Speech'],
  ['Dropping f bombs on admins', 'Abusive Language/Hate Speech'],
  ['Racial slurs in chat', 'Abusive Language/Hate Speech'],
  // Slurring and slurred, which in a ban reason mostly mean using slurs.
  ['Slurring in chat', 'Abusive Language/Hate Speech'],
  ['Slurred at a teammate', 'Abusive Language/Hate Speech'],
  ['Neonazi', 'Abusive Language/Hate Speech'],
  ['Nazis', 'Abusive Language/Hate Speech'],
  ['Naziflagge', 'Abusive Language/Hate Speech'],
  ['Nazimusik', 'Abusive Language/Hate Speech'],
  // Compounds that go on with ä, ö or ü after the letters that end names such as Nazim.
  ['Naziführer', 'Abusive Language/Hate Speech'],
  ['Nazimärsche', 'Abusive Language/Hate Speech'],
  ['Nazimörder', 'Abusive Language/Hate Speech'],
  ['Rassismus', 'Abusive Language/Hate Speech'],
  ['Schimpfwörter', 'Abusive Language/Hate Speech'],
  ['küfür', 'Abusive Language/Hate Speech'],
  ['kufur', 'Abusive Language/Hate Speech'],
  ['malédiction', 'Abusive Language/Hate Speech'],
  ['種族主義', 'Abusive Language/Hate Speech'],

  // Camping: main camping, and mines and mining, as in mining the enemy main.
  ['Main camping', 'Camping'],
  ['Planted a mine at the main exit', 'Camping'],
  ['Mines at enemy main', 'Camping'],
  ['mined the main exit', 'Camping'],
  ['mining the main', 'Camping'],
  ['Mainmining', 'Camping'],
  ['Placed landmines in enemy main', 'Camping'],
  ['anti-tank mines in main', 'Camping'],
  ['Minen gelegt', 'Camping'],
  ['Landminen in der Main', 'Camping'],
  ['Panzerminen', 'Camping'],
  ['AT-Minen', 'Camping'],
  ['ATmines in main', 'Camping'],
  ['Antitankmines in main', 'Camping'],
  ['Panzerabwehrminen im Main', 'Camping'],
  ['Spawnminen gelegt', 'Camping'],
  ['Tellerminen im Main', 'Camping'],
  ['Main verminen', 'Camping'],

  // Helicopter ramming.
  ['Helicopter ramming', 'Helicopter Ramming'],
  ['heliramming', 'Helicopter Ramming'],
  ['vicramming friendlies', 'Helicopter Ramming'],
  // The past tense, which the keyword missed before.
  ['Heli rammed a friendly', 'Helicopter Ramming'],
  ['Heli gerammt', 'Helicopter Ramming'],
  ['rammt Fahrzeuge', 'Helicopter Ramming'],
  ['Rammen mit Heli', 'Helicopter Ramming'],

  // Impersonation and locked squads.
  ['impersonating an admin', 'Impersonation'],
  ['Sich als Admin ausgegeben', 'Impersonation'],
  ['Locked squad', 'Locked Squad'],
  ['geschlossenes Squad', 'Locked Squad'],

  // Soloing vehicles.
  ['Soloing vehicles', 'Soloing Vehicles'],
  ['solo tank', 'Soloing Vehicles'],
  ['Solo-Panzer', 'Soloing Vehicles'],
  ['crewman', 'Soloing Vehicles'],
  ['manning a tank alone', 'Soloing Vehicles'],
  ['1 man tank', 'Soloing Vehicles'],
  ['1-man', 'Soloing Vehicles'],
  ['1man', 'Soloing Vehicles'],
  ['one man', 'Soloing Vehicles'],
  ['one-manned', 'Soloing Vehicles'],
  ['1-manning', 'Soloing Vehicles'],
  ['He 1-mans the tank', 'Soloing Vehicles'],
  ['1 Mann Panzer', 'Soloing Vehicles'],
  ['1 maning a tank', 'Soloing Vehicles'],
  ['1-maned the tank', 'Soloing Vehicles'],

  // Stealing assets.
  ['Stealing assets', 'Stealing Assets'],
  ['steals', 'Stealing Assets'],
  ['çalma', 'Stealing Assets'],
  ['gestohlen', 'Stealing Assets'],

  // Advertising, also bewerben and Bewerbung, which are to promote as well as to apply.
  ['Advertising', 'Advertising'],
  ['Werbung', 'Advertising'],
  ['werben', 'Advertising'],
  ['Serverwerbung', 'Advertising'],
  ['Eigenwerbung', 'Advertising'],
  ['Fremden Discord-Server bewerben', 'Advertising'],
  ['Bewerbung eines anderen Servers', 'Advertising'],

  // Other categories, in other languages.
  ['istismar', 'Exploiting'],
  ['剝削', 'Exploiting'],
  ['ausnutzen', 'Exploiting'],
  ['araç kural ihlali', 'Breaking Vehicle Priority Rules'],
  ['siyaset', 'Discussing politics'],
  ['Politik', 'Discussing politics'],
  ['yayinci', 'Streamsniping'],
  ['rekrutieren', 'Recruiting'],

  // Several labels, in alphabetical order, and none.
  ['Teamkilling and racism', 'Abusive Language/Hate Speech, Teamkilling'],
  ['Breaking server rules', 'Unknown']
];

// Everyday words and names that hold a keyword, which do not get its label. All of them got it
// before but "Scrammed when admins arrived", which is here because "rammed" is now found. The reason
// keeps the labels its other keywords find.
const notFound = [
  // Not cheating: whack, shack, the name Dietrich, Strich (line) and betrunken (drunk).
  ['Whacked teammates with a shovel', 'Unknown'],
  ['Built a shack in main', 'Unknown'],
  ['Gebannt von Dietrich', 'Unknown'],
  ['Name mit Unterstrich', 'Unknown'],
  ['Betrunken im Voice', 'Unknown'],

  // Not teamkilling: Mitkämpfer (fellow players) and the name Witkowski.
  ['Beleidigung von Mitkämpfern', 'Toxic'],
  ['Banned by Witkowski', 'Unknown'],

  // Not trolling: control, Kontrolle, patrol and stroll.
  ['controlled the drone into friendlies', 'Unknown'],
  ['Kontrolle verloren', 'Unknown'],
  ['Patrolling the enemy main', 'Unknown'],
  ['strolling into the main', 'Unknown'],

  // Not griefing: greifen (grab), greift, angreifen (attack, here with words) and Angreifer
  // (attacker).
  ['Nach der Waffe greifen', 'Unknown'],
  ['Greift Admins im Chat an', 'Unknown'],
  ['Admins verbal angreifen', 'Unknown'],
  ['Angreifer im Spawn', 'Unknown'],

  // Not toxic: crude, intruder and intoxicated.
  ['Crude jokes in all chat', 'Unknown'],
  ['Intruder in the main', 'Unknown'],
  ['Playing while intoxicated', 'Unknown'],

  // Not hate speech: words and bombs after words that end in f or n.
  ['Warned in words, then kept teamkilling', 'Teamkilling'],
  ['Insulting admins in his own words', 'Toxic'],
  ['Disrespect in words to admins', 'Toxic'],
  ['Poor choice of words in chat', 'Unknown'],
  ['Teamkilled squad with own bomb truck', 'Teamkilling'],
  ['Ran bomb car into friendlies', 'Unknown'],
  // Nor sniggering or slurping, nor the Turkish nazik (polite), the Italian nazionale (national), or
  // names that hold nazi, also with a digit or _ after them.
  ['Sniggering in chat', 'Unknown'],
  ['Slurping noises on mic', 'Unknown'],
  ['Adminlere karşı nazik değil', 'Unknown'],
  ['Squadra nazionale', 'Unknown'],
  ['Banned by Nazim', 'Unknown'],
  ['Banned by Nazih', 'Unknown'],
  ['Gebannt von Nazir', 'Unknown'],
  ['Banned by Nazife', 'Unknown'],
  ['Banned by Ignazio', 'Unknown'],
  ['Banned by Nazim1998', 'Unknown'],
  ['Banned by Nazim_TR', 'Unknown'],

  // Not camping: determined, examined, undermining, Minecraft, Termine (appointments) and the French
  // vermine (vermin).
  ['Determined to grief the main', 'Griefing'],
  ['Examined the logs', 'Unknown'],
  ['Undermining admins', 'Unknown'],
  ['Minecraft skin name', 'Unknown'],
  ['Termine nicht eingehalten', 'Unknown'],
  ['Traite les joueurs de vermine', 'Unknown'],

  // Not ramming: programming, Programmen, cramming and scrammed.
  ['Programming macro to spam', 'Spamming'],
  ['Cheating mit Drittanbieter-Programmen', 'Cheating'],
  ['Cramming players into the heli', 'Unknown'],
  ['Scrammed when admins arrived', 'Unknown'],

  // Not impersonation: herausgegeben (handed over).
  ['Daten herausgegeben', 'Unknown'],

  // Not a locked squad: an unlocked one.
  ['Created an unlocked squad', 'Unknown'],

  // Not soloing vehicles: the names Solomon and Soloman, and one man inside other words.
  ['Banned by Solomon', 'Unknown'],
  ['Banned by Soloman', 'Unknown'],
  ['Someone managed to ban evade', 'Unknown'],
  ['No one managed to stop him', 'Unknown'],
  ['Done many times before', 'Unknown'],
  ['21 man squad', 'Unknown'],

  // Not stealing assets: stealth.
  ['Used stealth to ghost', 'Unknown'],

  // Not advertising: erwerben (acquire) and Wettbewerben (competitions).
  ['Vorteile erwerben', 'Unknown'],
  ['Bei Wettbewerben gesperrt', 'Unknown']
];

const wrong = [...found, ...notFound]
  .map(([reason, labels]) => ({ reason, labels, got: classifyBanReason(reason) }))
  .filter(({ labels, got }) => got !== labels);
assert.deepStrictEqual(wrong, [], 'reasons whose labels are wrong');

// A BattleMetrics ban's note is classified only when its reason finds nothing, also when its reason
// is missing, or held only a keyword inside another word.
assert.strictEqual(classifyBanReason('Banned', 'Teamkilled 3 times'), 'Teamkilling');
assert.strictEqual(classifyBanReason('Cheating', 'Teamkilled 3 times'), 'Cheating');
assert.strictEqual(classifyBanReason(null, 'Teamkilled 3 times'), 'Teamkilling');
assert.strictEqual(classifyBanReason('Warned in words', 'Teamkilled 3 times'), 'Teamkilling');
assert.strictEqual(classifyBanReason('Banned', null), 'Unknown');
assert.strictEqual(classifyBanReason(undefined), 'Unknown');

// The services get it with the other utils.
assert.strictEqual(utils.classifyBanReason, classifyBanReason);

console.log(
  `Ban reason checks passed: ${found.length} reasons keep their labels, and ${notFound.length} get no label from a keyword inside another word.`
);
