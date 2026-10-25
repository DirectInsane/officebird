// Settings defaults, validation and mapping to the experiment config.

const STORAGE_KEY = "settings";

export const DEFAULT_SETTINGS = Object.freeze({
  icons: {
    enabled: true,
    trustedByServer: {},
    freemailExtra: [],
    bimi: { enabled: false, resolver: "cloudflare" },
  },
  preview: { enabled: true, lines: 2, tableLines: 1, tone: 45 },
  bar: { background: "#e8e8e8", text: "#333333", opacity: 60, compact: false },
  table: { dateStyle: "smart" },
  // Tones are how much of the normal text color read mail and previews keep, in %.
  style: { outlook: true, barWidth: 3, cardRadius: 7, cardGap: 4, readSender: 62, readSubject: 100, groupHeaders: true, expandGroups: true, cardLook: "theme" },
  compose: { ribbon: true, styleSet: "default" },
  search: { enabled: true, scope: "folder" },
});

// Ribbon UI state, not a user setting.
export const COMPOSE_STATE_KEY = "composeState";
export const DEFAULT_COMPOSE_STATE = Object.freeze({
  collapsed: false,
  recentFonts: Object.freeze([]),
  lastColors: Object.freeze({ text: "#c00000", highlight: "#ffff00" }),
});
const RECENT_FONTS_MAX = 5;
const FONT_NAME_MAX = 100;

const RESOLVER_NAMES = ["cloudflare", "quad9"];
// Must match CARD_LOOKS in experiments/qol/styles.mjs.
export const CARD_LOOKS = ["theme", "outline", "filled", "both"];
// Must match qolFormatting.STYLE_SET_KEYS in experiments/compose/formatting.js.
export const STYLE_SETS = ["default", "modern", "classic", "compact"];
export const SEARCH_SCOPES = ["folder", "all"];
// Must match qolDateFormat.STYLES in experiments/qol/dateformat.js.
export const DATE_STYLES = ["smart", "relative", "date", "datetime", "thunderbird"];
// Thunderbird's incoming server keys look like "server1".
const SERVER_KEY = /^[A-Za-z0-9_-]{1,64}$/;

function obj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function bool(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

function int(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function color(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function list(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const items = value
    .filter(v => typeof v === "string")
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(items)];
}

// Unlike list(), font names keep their case.
function fontNames(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const names = value
    .filter(v => typeof v === "string")
    .map(v => v.trim())
    .filter(v => v.length >= 1 && v.length <= FONT_NAME_MAX);
  return [...new Set(names)].slice(0, RECENT_FONTS_MAX);
}

function serverLists(value) {
  const entries = Object.entries(obj(value))
    .filter(([key]) => SERVER_KEY.test(key))
    .map(([key, ids]) => [key, list(ids)])
    .filter(([, ids]) => ids.length);
  return Object.fromEntries(entries);
}

export function normalizeSettings(raw) {
  const d = DEFAULT_SETTINGS;
  const r = obj(raw);
  const icons = obj(r.icons);
  const bimi = obj(icons.bimi);
  const preview = obj(r.preview);
  const bar = obj(r.bar);
  const table = obj(r.table);
  const style = obj(r.style);
  const compose = obj(r.compose);
  const search = obj(r.search);
  return {
    icons: {
      enabled: bool(icons.enabled, d.icons.enabled),
      trustedByServer: serverLists(icons.trustedByServer),
      freemailExtra: list(icons.freemailExtra),
      bimi: {
        enabled: bool(bimi.enabled, d.icons.bimi.enabled),
        resolver: RESOLVER_NAMES.includes(bimi.resolver) ? bimi.resolver : d.icons.bimi.resolver,
      },
    },
    preview: {
      enabled: bool(preview.enabled, d.preview.enabled),
      lines: int(preview.lines, 1, 5, d.preview.lines),
      tableLines: int(preview.tableLines, 1, 3, d.preview.tableLines),
      tone: int(preview.tone, 30, 80, d.preview.tone),
    },
    bar: {
      background: color(bar.background, d.bar.background),
      text: color(bar.text, d.bar.text),
      opacity: int(bar.opacity, 0, 100, d.bar.opacity),
      compact: bool(bar.compact, d.bar.compact),
    },
    table: {
      dateStyle: DATE_STYLES.includes(table.dateStyle) ? table.dateStyle : d.table.dateStyle,
    },
    style: {
      outlook: bool(style.outlook, d.style.outlook),
      barWidth: int(style.barWidth, 2, 6, d.style.barWidth),
      cardRadius: int(style.cardRadius, 0, 12, d.style.cardRadius),
      cardGap: int(style.cardGap, 0, 12, d.style.cardGap),
      readSender: int(style.readSender, 40, 100, d.style.readSender),
      readSubject: int(style.readSubject, 40, 100, d.style.readSubject),
      groupHeaders: bool(style.groupHeaders, d.style.groupHeaders),
      expandGroups: bool(style.expandGroups, d.style.expandGroups),
      cardLook: CARD_LOOKS.includes(style.cardLook) ? style.cardLook : d.style.cardLook,
    },
    compose: {
      ribbon: bool(compose.ribbon, d.compose.ribbon),
      styleSet: STYLE_SETS.includes(compose.styleSet) ? compose.styleSet : d.compose.styleSet,
    },
    search: {
      enabled: bool(search.enabled, d.search.enabled),
      scope: SEARCH_SCOPES.includes(search.scope) ? search.scope : d.search.scope,
    },
  };
}

export function normalizeComposeState(raw) {
  const d = DEFAULT_COMPOSE_STATE;
  const r = obj(raw);
  const colors = obj(r.lastColors);
  return {
    collapsed: bool(r.collapsed, d.collapsed),
    recentFonts: fontNames(r.recentFonts),
    lastColors: {
      text: color(colors.text, d.lastColors.text),
      highlight: color(colors.highlight, d.lastColors.highlight),
    },
  };
}

// Trust is per account: one account's authserv-id proves nothing about mail to
// another account, whose server may not add (or strip) Authentication-Results.
export function trustedIdsFor(s, serverKey) {
  const lists = s.icons.trustedByServer;
  return typeof serverKey === "string" && Object.hasOwn(lists, serverKey) ? lists[serverKey] : [];
}

// Drops lists of deleted accounts so a later account reusing the server key
// doesn't inherit them.
export function pruneServers(s, serverKeys) {
  const keep = Object.entries(s.icons.trustedByServer).filter(([key]) => serverKeys.includes(key));
  return { ...s, icons: { ...s.icons, trustedByServer: Object.fromEntries(keep) } };
}

export function toExperimentConfig(s) {
  return {
    iconsEnabled: s.icons.enabled,
    preview: { ...s.preview },
    bar: { ...s.bar },
    table: { ...s.table },
    style: { ...s.style },
    compose: { ribbon: s.compose.ribbon, styleSet: s.compose.styleSet },
    search: { enabled: s.search.enabled, scope: s.search.scope },
  };
}

export async function loadSettings(storageArea) {
  const stored = await storageArea.get(STORAGE_KEY);
  return normalizeSettings(stored?.[STORAGE_KEY]);
}

export async function saveSettings(storageArea, settings) {
  await storageArea.set({ [STORAGE_KEY]: normalizeSettings(settings) });
}
