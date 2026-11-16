import assert from 'assert';
import { fileURLToPath } from 'url';

import * as sass from 'sass';

import viteConfig from '../../client/vite.config.mjs';

// Checks the client's stylesheet, compiled with the client's build settings, in light and dark mode:
// text can be read (4.5:1, WCAG's contrast for text), field borders and focus rings can be seen
// (3:1, WCAG's contrast for parts of controls), no rule takes the ring away from a focused button,
// focused controls have an outline for devices that force their own colours, links in sentences are
// underlined, fields are big enough that iOS Safari does not zoom in on them, and motion stops for
// visitors who ask for less. Colours are read from the stylesheet and measured against the
// backgrounds they are shown on.

const CLIENT = new URL('../../client/', import.meta.url);

// Bootstrap is loaded from wherever the client's packages are installed, as in the client's build.
const warnings = [];
const { css } = await sass.compileAsync(
  fileURLToPath(new URL('src/assets/scss/core.scss', CLIENT)),
  {
    ...viteConfig.css.preprocessorOptions.scss,
    loadPaths: [new URL('node_modules/', CLIENT), new URL('../node_modules/', CLIENT)].map((url) =>
      fileURLToPath(url)
    ),
    logger: { warn: (message) => warnings.push(message) }
  }
);

// Text split at a separator, but not inside brackets or quotes, as in a selector list or a list of
// shadows.
function split(text, separator) {
  const parts = [''];
  let depth = 0;
  let quote = null;
  for (const char of text) {
    if (quote) quote = char === quote ? null : quote;
    else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (depth === 0 && char === separator) {
      parts.push('');
      continue;
    }
    parts[parts.length - 1] += char;
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

// The stylesheet's style rules in order, each with its selectors, its declarations and the media
// queries it is in. Rules in @keyframes and other at-rules are left out.
function parseRules(text) {
  const rules = [];
  const open = [];
  let buffer = '';
  let depth = 0;
  let quote = null;
  for (const char of text.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (quote) quote = char === quote ? null : quote;
    else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && char === '{') {
      const prelude = buffer.trim().replace(/\s+/g, ' ');
      buffer = '';
      if (prelude.startsWith('@media')) open.push({ media: prelude.slice(6).trim() });
      else if (prelude.startsWith('@')) open.push({ atRule: prelude });
      else open.push({ selectors: split(prelude, ','), declarations: [] });
      continue;
    } else if (depth === 0 && (char === ';' || char === '}')) {
      const declaration = buffer.trim();
      buffer = '';
      const block = open.at(-1);
      if (declaration && block?.declarations) {
        const colon = declaration.indexOf(':');
        const value = declaration.slice(colon + 1).trim();
        block.declarations.push({
          property: declaration.slice(0, colon).trim(),
          value: value.replace(/\s*!important$/, ''),
          important: value.endsWith('!important')
        });
      }
      if (char === '}') {
        const closed = open.pop();
        if (closed?.declarations && !open.some((block) => block.atRule))
          rules.push({
            selectors: closed.selectors,
            declarations: closed.declarations,
            media: open.filter((block) => block.media).map((block) => block.media)
          });
      }
      continue;
    }
    buffer += char;
  }
  return rules;
}

const rules = parseRules(css);
const everywhere = rules.filter((rule) => rule.media.length === 0);
assert.ok(everywhere.length > 1000, `Found only ${everywhere.length} rules in the stylesheet`);

// The value a property has on an element that the selectors match, such as .btn and .btn-primary,
// in light or dark mode, by the cascade between their rules: an !important declaration wins over
// others, a dark mode rule wins in dark mode, as its selector is more specific, and otherwise the
// last rule wins.
function declared(selectors, property, mode) {
  selectors = [selectors].flat();
  const dark = selectors.map((selector) => `[data-bs-theme=dark] ${selector}`);
  let winner;
  for (const rule of everywhere) {
    const darkOnly = mode === 'dark' && dark.some((selector) => rule.selectors.includes(selector));
    if (!darkOnly && !selectors.some((selector) => rule.selectors.includes(selector))) continue;
    for (const declaration of rule.declarations) {
      if (declaration.property !== property) continue;
      const rank = (declaration.important ? 2 : 0) + (darkOnly ? 1 : 0);
      if (!winner || rank >= winner.rank) winner = { rank, value: declaration.value };
    }
  }
  return winner?.value;
}

// A custom property set on the page itself, in light or dark mode.
const root = (name, mode) =>
  (mode === 'dark' && declared('[data-bs-theme=dark]', name, 'light')) ||
  declared(':root', name, 'light');

// Text with its var()s filled in, from the element's own rules or from the page.
function fill(text, selector, mode) {
  for (let i = 0; i < 10 && text.includes('var('); i++)
    text = text.replace(
      /var\((--[\w-]+)(?:,\s*([^()]*))?\)/,
      (match, name, fallback) =>
        declared(selector, name, mode) ?? root(name, mode) ?? fallback ?? ''
    );
  return text;
}

// A property's value with its var()s filled in.
const value = (selector, property, mode) =>
  fill(declared(selector, property, mode) ?? '', selector, mode);

// A colour as red, green and blue from 0 to 255, and alpha, or null for anything else. Sass writes
// some colours it works out by name.
const named = { black: '#000', white: '#fff', transparent: '#0000' };
function colour(text) {
  text = named[text.trim()] ?? text;
  const hex = /^#([\da-f]{3,8})$/i.exec(text.trim());
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join('');
    const channels = digits.match(/../g).map((pair) => parseInt(pair, 16));
    return [...channels.slice(0, 3), channels.length > 3 ? channels[3] / 255 : 1];
  }
  const functional = /^rgba?\((.*)\)$/i.exec(text.trim());
  if (!functional) return null;
  const [red = '', green = '', blue = '', alpha = '1'] = split(functional[1], ',');
  const channel = (part) => (part.endsWith('%') ? parseFloat(part) * 2.55 : parseFloat(part));
  const channels = [
    channel(red),
    channel(green),
    channel(blue),
    alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha)
  ];
  return channels.some(Number.isNaN) ? null : channels;
}

// Whether two colours are the same, however they are written.
const sameColour = (a, b) =>
  colour(a) !== null && colour(a).every((channel, i) => Math.abs(channel - colour(b)?.[i]) < 0.5);

// A colour mixed with white or black by a weight from 0 to 1, as Sass's tint-color() and
// shade-color() do.
const mix = (text, weight, towards) =>
  `rgb(${colour(text)
    .slice(0, 3)
    .map((channel) => Math.round((channel + (towards - channel) * weight) * 100) / 100)
    .join(', ')})`;
const tint = (text, weight) => mix(text, weight, 255);
const shade = (text, weight) => mix(text, weight, 0);

// WCAG's contrast ratio between a colour, which may be see-through, and the background under it.
function contrast(foreground, background) {
  const under = colour(background);
  const over = colour(foreground);
  if (!under || !over) return 0;
  const shown = under.slice(0, 3).map((channel, i) => over[i] * over[3] + channel * (1 - over[3]));
  const luminance = (channels) => {
    const [red, green, blue] = channels.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(shown), luminance(under)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

// The colours of a box-shadow's rings, inner first.
const rings = (shadow) =>
  split(shadow, ',').flatMap((part) => split(part, ' ').filter((word) => colour(word)));

// The backgrounds things are shown on.
const backgrounds = {
  light: {
    page: root('--bs-body-bg', 'light'),
    'table header': value('.table .thead-light th', 'background-color', 'light'),
    footer: value('.footer', 'background', 'light')
  },
  dark: {
    page: root('--bs-body-bg', 'dark'),
    card: value('.card', '--bs-card-bg', 'dark'),
    menu: value('.dropdown-menu', '--bs-dropdown-bg', 'dark'),
    'table header': value('.table .thead-light th', 'background-color', 'dark'),
    footer: value('.footer', 'background', 'dark')
  },
  // The navbar is navy once the page is scrolled, in both modes.
  navbar: value('.headroom--not-top', 'background-color', 'light')
};
for (const [name, background] of Object.entries({
  ...backgrounds.light,
  ...backgrounds.dark,
  navbar: backgrounds.navbar
}))
  assert.ok(colour(background), `Found no colour for the ${name} background: ${background}`);

// Each check that fails, so a run lists them all.
const failures = [];
function check(what, foreground, background, minimum) {
  const ratio = contrast(foreground, background);
  if (!(ratio >= minimum))
    failures.push(`${what}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
}

// Text, in light mode on white, and on the light greys where it can be shown, and in dark mode on the
// dark page and panels.
const lightText = [
  ['links', root('--bs-link-color', 'light'), ['page', 'table header', 'footer']],
  ['muted and help text', value('.text-muted', 'color', 'light'), ['page', 'table header']],
  ['help text under fields', value('.form-text', 'color', 'light'), ['page']],
  ['table headers', value('.table .thead-light th', 'color', 'light'), ['table header']],
  ["the footer's links", value('.footer .nav .nav-link', 'color', 'light'), ['footer']],
  ["the navbar menus' descriptions", value('.dropdown-media p', 'color', 'light'), ['page']],
  ['placeholders', value('.form-control::placeholder', 'color', 'light'), ['page']],
  ['invalid field messages', value('.invalid-feedback', 'color', 'light'), ['page']],
  ['code, such as EOS IDs', value('code', 'color', 'light'), ['page']],
  ['titles in the yellow', value('.text-primary', 'color', 'light'), ['page', 'footer']],
  ...['info', 'success', 'warning', 'danger'].map((name) => [
    `titles and risk ratings in .text-${name}`,
    value(`.text-${name}`, 'color', 'light'),
    ['page']
  ])
];
for (const [what, foreground, on] of lightText)
  for (const name of on)
    check(`Light mode ${what}, on the ${name}`, foreground, backgrounds.light[name], 4.5);

const darkText = [
  ['links', root('--bs-link-color', 'dark'), ['page', 'card']],
  ['muted and help text', value('.text-muted', 'color', 'dark'), ['page', 'card']],
  ['table headers', value('.table .thead-light th', 'color', 'dark'), ['table header']],
  ["the footer's links", value('.footer .nav .nav-link', 'color', 'dark'), ['footer']],
  ["the navbar menus' descriptions", value('.dropdown-media p', 'color', 'dark'), ['menu']],
  ['placeholders', value('.form-control::placeholder', 'color', 'dark'), ['page']],
  ['invalid field messages', value('.invalid-feedback', 'color', 'dark'), ['card']],
  ['code, such as EOS IDs', value('code', 'color', 'dark'), ['card']],
  ...['primary', 'info', 'success', 'warning', 'danger'].map((name) => [
    `titles and risk ratings in .text-${name}`,
    value(`.text-${name}`, 'color', 'dark'),
    ['card', 'menu']
  ])
];
for (const [what, foreground, on] of darkText)
  for (const name of on)
    check(`Dark mode ${what}, on the ${name}`, foreground, backgrounds.dark[name], 4.5);

// Dark mode keeps the colours it had where they could already be read.
for (const [what, actual, expected] of [
  ['links', root('--bs-link-color', 'dark'), root('--bs-primary', 'dark')],
  ['titles in the yellow', value('.text-primary', 'color', 'dark'), root('--bs-primary', 'dark')],
  ["the footer's links", value('.footer .nav .nav-link', 'color', 'dark'), root('--bs-gray-600')],
  ["the menus' descriptions", value('.dropdown-media p', 'color', 'dark'), root('--bs-gray-600')],
  ['placeholders', value('.form-control::placeholder', 'color', 'dark'), root('--bs-gray-500')],
  // Bootstrap's own, the pink tinted 40% towards white.
  ['code', value('code', 'color', 'dark'), tint(root('--bs-pink'), 0.4)],
  // Bootstrap's own, the yellow tinted halfway to white.
  [
    "focused fields' borders",
    value('.form-control:focus', 'border-color', 'dark'),
    tint(root('--bs-primary'), 0.5)
  ],
  [
    'outline buttons in the light grey',
    value(['.btn', '.btn-outline-secondary'], '--bs-btn-color', 'dark'),
    root('--bs-secondary')
  ]
])
  if (!sameColour(actual, expected))
    failures.push(`Dark mode ${what} changed colour: ${actual}, where it was ${expected}`);

// Text on buttons in each state, which is the same in both modes but for the buttons dark mode
// recolours. Discord's buttons hold only its logo, which needs 3:1.
const buttons = everywhere
  .flatMap((rule) => rule.selectors)
  .filter((selector) => /^(\[data-bs-theme=dark\] )?\.btn-[a-z]+$/.test(selector))
  .filter((selector) => !/\.btn-(link|close|check|group|toolbar|wrapper|lg|sm)$/.test(selector));
assert.ok(buttons.length > 10, `Found only ${buttons.length} button colours`);
for (const selector of new Set(buttons)) {
  const mode = selector.startsWith('[') ? 'dark' : 'light';
  const button = selector.replace('[data-bs-theme=dark] ', '');
  const background = value(button, '--bs-btn-bg', mode);
  if (!colour(background)) continue;
  for (const state of ['', 'hover-', 'active-'])
    check(
      `Text on ${selector}${state ? `, ${state.slice(0, -1)}` : ''}`,
      value(button, `--bs-btn-${state}color`, mode),
      value(button, `--bs-btn-${state}bg`, mode),
      button === '.btn-discord' ? 3 : 4.5
    );
}

// Badges in the colours the site gives them, with Discord's logo again needing 3:1.
for (const name of ['primary', 'secondary', 'info', 'success', 'danger', 'github', 'discord'])
  check(
    `Text on .badge.bg-${name}`,
    value(`.badge.bg-${name}`, 'color', 'light'),
    value(`.bg-${name}`, 'background-color', 'light'),
    name === 'discord' ? 3 : 4.5
  );

// Discord's logo stays white on its buttons and badge.
for (const [what, logo] of [
  ["Discord's buttons", value(['.btn', '.btn-discord'], '--bs-btn-color', 'light')],
  ["Discord's buttons, hovered", value(['.btn', '.btn-discord'], '--bs-btn-hover-color', 'light')],
  ["Discord's buttons, pressed", value(['.btn', '.btn-discord'], '--bs-btn-active-color', 'light')],
  ["Discord's badge", value('.badge.bg-discord', 'color', 'light')]
])
  if (!sameColour(logo, '#fff')) failures.push(`${what} show the logo in ${logo}, not white`);

// Outline buttons in the colours the site uses for them: the light grey of the Copy button on EOS
// player pages. Their text and border are on the card, and hovered or pressed they fill with their
// colour.
for (const name of ['secondary'])
  for (const [mode, card] of [
    ['Light', backgrounds.light.page],
    ['Dark', backgrounds.dark.card]
  ]) {
    const button = ['.btn', `.btn-outline-${name}`];
    const at = (variable) => value(button, `--bs-btn-${variable}`, mode.toLowerCase());
    check(`${mode} mode text on .btn-outline-${name}`, at('color'), card, 4.5);
    check(`${mode} mode border of .btn-outline-${name}`, at('border-color'), card, 3);
    for (const state of ['hover', 'active'])
      check(
        `${mode} mode text on .btn-outline-${name}, ${state === 'hover' ? 'hovered' : 'pressed'}`,
        at(`${state}-color`),
        at(`${state}-bg`),
        4.5
      );
  }

// Red alerts, such as the disclaimer on player pages, keep the red they had in both modes, as their
// text could already be read on them.
const red = root('--bs-red');
for (const [mode, was] of [
  [
    'light',
    {
      '--bs-danger-text-emphasis': shade(red, 0.6),
      '--bs-danger-bg-subtle': tint(red, 0.8),
      '--bs-danger-border-subtle': tint(red, 0.6)
    }
  ],
  [
    'dark',
    {
      '--bs-danger-text-emphasis': tint(red, 0.4),
      '--bs-danger-bg-subtle': shade(red, 0.8),
      '--bs-danger-border-subtle': shade(red, 0.4)
    }
  ]
]) {
  for (const [name, expected] of Object.entries(was))
    if (!sameColour(root(name, mode), expected))
      failures.push(
        `Red alerts' ${name} changed in ${mode} mode: ${root(name, mode)}, where it was ${expected}`
      );
  check(
    `Text on red alerts in ${mode} mode`,
    root('--bs-danger-text-emphasis', mode),
    root('--bs-danger-bg-subtle', mode),
    4.5
  );
}

// The error message's white text across its red gradient.
const gradient = value('.bg-gradient-danger', 'background', 'light');
const gradientStops = split(/linear-gradient\((.*)\)/.exec(gradient)?.[1] ?? '', ',')
  .slice(1)
  .map((stop) => split(stop, ' ')[0]);
assert.equal(gradientStops.length, 2, `Found no gradient in ${gradient}`);
for (const stop of gradientStops)
  check('Error message text', value('.modal-danger .modal-content', 'color', 'light'), stop, 4.5);

// Field borders against the white page and the dark card.
check(
  'Light mode field borders',
  root('--cbl-input-border-color', 'light'),
  backgrounds.light.page,
  3
);
check(
  'Dark mode field borders',
  root('--cbl-input-border-color', 'dark'),
  backgrounds.dark.card,
  3
);
if (!declared('.form-control', 'border', 'light')?.includes('var(--cbl-input-border-color)'))
  failures.push(`Fields' borders are ${declared('.form-control', 'border', 'light')}`);
check(
  "Light mode focused fields' borders",
  value('.form-control:focus', 'border-color', 'light'),
  backgrounds.light.page,
  3
);
check(
  "Dark mode focused fields' borders",
  value('.form-control:focus', 'border-color', 'dark'),
  backgrounds.dark.card,
  3
);

// Focus rings: on every background a focused control can be on, one of a ring's bands stands out.
const buttonNames = [
  'primary',
  'secondary',
  'outline-secondary',
  'info',
  'success',
  'danger',
  'default',
  'github',
  'discord',
  'steam'
];
const focusRings = [
  ...buttonNames.map((name) => [
    `.btn-${name} buttons`,
    ['.btn', `.btn-${name}`],
    '--bs-btn-focus-box-shadow'
  ]),
  // The shadow a focused button is given, which shows the ring.
  ...buttonNames.map((name) => [
    `.btn-${name} buttons with keyboard focus`,
    ['.btn', `.btn-${name}`, '.btn:focus-visible', `.btn-${name}:focus-visible`],
    'box-shadow'
  ]),
  ['nav links and menu toggles', '.nav-link:focus-visible', 'box-shadow'],
  ['fields', '.form-control:focus', 'box-shadow'],
  ['lists to choose from', '.form-select:focus', 'box-shadow'],
  ['invalid fields', '.form-control.is-invalid:focus', 'box-shadow'],
  ['the search box', '.input-group:has(> .form-control:focus)', 'box-shadow'],
  ["the search box's button", '.input-group > .btn:focus-visible', 'box-shadow'],
  ['the menu buttons', '.navbar-toggler:focus', 'box-shadow'],
  ['close buttons', '.btn-close', '--bs-btn-close-focus-shadow']
];
const focusBackgrounds = [
  ['light mode page', backgrounds.light.page, 'light'],
  ['light mode table header', backgrounds.light['table header'], 'light'],
  ['light mode footer', backgrounds.light.footer, 'light'],
  ['light mode navbar', backgrounds.navbar, 'light'],
  ['dark mode page', backgrounds.dark.page, 'dark'],
  ['dark mode card', backgrounds.dark.card, 'dark'],
  ['dark mode navbar', backgrounds.navbar, 'dark']
];
function checkRing(what, shadowIn) {
  for (const [where, background, mode] of focusBackgrounds) {
    const shadow = shadowIn(mode);
    const colours = rings(shadow);
    const best = Math.max(0, ...colours.map((ring) => contrast(ring, background)));
    if (!(best >= 3))
      failures.push(
        `Focus ring on ${what}, on the ${where}: ` +
          (colours.length ? `"${shadow}" is ${best.toFixed(2)}:1` : `"${shadow}" has no colour`)
      );
  }
}
for (const [what, selectors, property] of focusRings)
  checkRing(what, (mode) => value(selectors, property, mode));

// No rule takes the ring away from a button with keyboard focus. A rule that gives a focused button
// a shadow includes the ring. A rule that gives a hovered button a shadow leaves out buttons with
// keyboard focus, or a later rule for the same button with keyboard focus puts the ring back. What
// a selector says of the button itself is its last part, after any combinator, outside :not() and
// :has().
const lastPart = (selector) => split(selector.replace(/\s*([>+~])\s*/g, ' $1 '), ' ').at(-1);
const own = (part) => part.replace(/:(not|has)\((?:[^()]|\([^()]*\))*\)/g, '');
const isButton = (part) => /\.btn(-(?!close|check|group|toolbar)[\w-]+)?(?![\w-])/.test(own(part));
const states = (part) => own(part).match(/(?<!:):[\w-]+/g) ?? [];
let buttonShadows = 0;
rules.forEach((rule, index) => {
  const shadow = rule.declarations.findLast(({ property }) => property === 'box-shadow')?.value;
  if (shadow === undefined) return;
  for (const selector of rule.selectors) {
    const part = lastPart(selector);
    if (!isButton(part)) continue;
    buttonShadows++;
    const ringIn = (mode) => fill(shadow, '.btn', mode);
    if (states(part).some((state) => state === ':focus-visible' || state === ':focus'))
      checkRing(`buttons matching ${selector}`, ringIn);
    else if (states(part).includes(':hover')) {
      const leavesOut = /:not\([^)]*:focus/.test(part);
      const focused = selector.replace(':hover', ':focus-visible');
      const putBack = rules
        .slice(index + 1)
        .some(
          (later) =>
            later.selectors.includes(focused) &&
            later.declarations.some(({ property }) => property === 'box-shadow')
        );
      if (!leavesOut && !putBack) checkRing(`hovered buttons matching ${selector}`, ringIn);
    }
  }
});
assert.ok(buttonShadows > 5, `Found only ${buttonShadows} rules with shadows for buttons`);

// The search box's ring shows while its field has focus, not while its button has, so the button's
// own ring stands out.
for (const rule of rules)
  if (
    rule.selectors.includes('.input-group:focus-within') &&
    rule.declarations.some(({ property }) => property === 'box-shadow')
  )
    failures.push('The search box keeps its ring while its button has focus');

// The same goes for the focus colour of the field's and icon's borders, which the icon takes only
// while the field has focus.
const declares = (rule, property) =>
  rule.declarations.some((declaration) => declaration.property === property);
for (const rule of rules)
  if (
    rule.selectors.some((selector) => selector.startsWith('.input-group:focus-within')) &&
    declares(rule, 'border-color')
  )
    failures.push("The search box's borders take the focus colour while its button has focus");
if (
  !rules.some(
    (rule) =>
      rule.selectors.some((selector) =>
        /^\.input-group:has\(.*\.form-control:focus.*\) > \.input-group-text$/.test(selector)
      ) && declares(rule, 'border-color')
  )
)
  failures.push("The search box's icon does not take the focus colour while its field has focus");

// A selector's specificity as [ids, classes, elements], for the selectors used here: :where()
// counts nothing, and :has(), :is() and :not() count as their argument.
function specificity(selector) {
  let text = selector;
  for (let previous; previous !== text;) {
    previous = text;
    text = text.replace(/:where\([^()]*\)/g, '').replace(/:(?:has|is|not)\(([^()]*)\)/g, ' $1 ');
  }
  return [
    (text.match(/#[\w-]+/g) ?? []).length,
    (text.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) ?? []).length,
    (text.match(/(?:^|[\s>+~])[a-z][\w-]*|::[\w-]+/gi) ?? []).length
  ];
}
const higher = (a, b) => {
  const index = a.findIndex((n, i) => n !== b[i]);
  return index !== -1 && a[index] > b[index];
};

// An invalid search box keeps its red border while its field has focus: for the field and the icon,
// the invalid rule wins over the focus rule, by specificity or by coming later.
for (const part of ['.form-control', '.input-group-text']) {
  const isFocus = (selector) =>
    selector.startsWith('.input-group:has(') &&
    selector.includes('.form-control:focus') &&
    selector.endsWith(`> ${part}`);
  const isInvalid = (selector) => selector === `.input-group.is-invalid > ${part}`;
  const find = (test) =>
    rules.findLastIndex((rule) => rule.selectors.some(test) && declares(rule, 'border-color'));
  const focus = find(isFocus);
  const invalid = find(isInvalid);
  if (invalid === -1) {
    failures.push(`An invalid search box's ${part} has no red border`);
    continue;
  }
  if (focus === -1) continue;
  const focusSpecificity = specificity(rules[focus].selectors.find(isFocus));
  const invalidSpecificity = specificity(rules[invalid].selectors.find(isInvalid));
  if (
    !higher(invalidSpecificity, focusSpecificity) &&
    (higher(focusSpecificity, invalidSpecificity) || invalid < focus)
  )
    failures.push(`An invalid search box's ${part} loses its red border while its field has focus`);
}

// Browsers leave shadows out when a device forces its own colours, so each control that shows the
// ring also has an outline, which is transparent until then.
for (const selector of [
  '.btn:focus-visible',
  '.btn-close:focus',
  '.form-control:focus',
  '.form-select:focus',
  '.nav-link:focus-visible',
  '.navbar-toggler:focus',
  '.input-group:has(> .form-control:focus)'
]) {
  const outline = declared(selector, 'outline', 'light');
  if (!/^[1-9][\d.]*px solid\b/.test(outline ?? ''))
    failures.push(`${selector} has no outline for forced colours: ${outline}`);
}

// Links in sentences and lists are underlined, so they stand out without relying on colour.
for (const selector of ['p a:not([class])', 'li a:not([class])'])
  if (value(selector, 'text-decoration', 'light') !== 'underline')
    failures.push(`Links matching ${selector} are not underlined`);

// On phones, held either way, and small tablets, fields have a 16px font, as iOS Safari zooms in on
// a focused field whose font is smaller. The widest phone held sideways is 932px wide.
const phoneFont = (selector) =>
  rules.find(
    (rule) =>
      rule.selectors.includes(selector) &&
      rule.media.some((media) => Number(/max-width: ([\d.]+)px/.exec(media)?.[1] ?? 0) >= 932) &&
      rule.declarations.some(({ property, value }) => property === 'font-size' && value === '1rem')
  );
for (const selector of ['.form-control', '.form-select', '.input-group-text'])
  if (!phoneFont(selector)) failures.push(`${selector} is not 16px on phones`);

// For visitors who ask for less motion, every transition and animation ends at once, and the home
// page's cards do not lift.
const stillness = rules.find(
  (rule) => rule.selectors.includes('*') && rule.media.includes('(prefers-reduced-motion: reduce)')
);
const sets = (property, wanted) =>
  stillness?.declarations.some(
    (declaration) =>
      declaration.property === property && declaration.important && wanted(declaration.value)
  );
const instant = (time) => parseFloat(time) <= (time.endsWith('ms') ? 0.01 : 0.00001);
if (
  !sets('transition-duration', instant) ||
  !sets('animation-duration', instant) ||
  !sets('animation-iteration-count', (count) => count === '1')
)
  failures.push('Transitions and animations do not stop for visitors who ask for less motion');
if (
  !rules.some(
    (rule) =>
      rule.selectors.includes('.card-lift--hover:hover') &&
      rule.media.includes('(prefers-reduced-motion: reduce)') &&
      rule.declarations.some(({ property, value }) => property === 'transform' && value === 'none')
  )
)
  failures.push("The home page's cards still lift for visitors who ask for less motion");

// Bootstrap warns when no text colour reaches $min-contrast-ratio on one of its backgrounds.
for (const warning of warnings)
  if (/contrast ratio/.test(warning)) failures.push(`Bootstrap: ${warning.split('\n')[0]}`);

assert.deepStrictEqual(failures, [], `The stylesheet fails ${failures.length} checks`);

console.log(
  `Stylesheet checks passed: text, field borders and focus rings can be seen in light and dark mode, focused controls keep their ring and have an outline for forced colours, links in sentences are underlined, fields are 16px on phones, and motion stops when asked.`
);
