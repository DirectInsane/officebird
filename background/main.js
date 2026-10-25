// Wires settings, the icon resolver and the qol, qolCompose and qolSearch experiments together.
import {
  normalizeSettings,
  toExperimentConfig,
  pruneServers,
  normalizeComposeState,
  COMPOSE_STATE_KEY,
} from "./settings.js";
import { createIconResolver } from "./icons.js";
import { IconCache, idbStore } from "./cache.js";
import { lookupContactPhoto, clearContactPhotoCache } from "./contacts.js";
import { rankAuthservIds, dominantAuthservId } from "./auth.js";
import { buildStylesheet } from "../experiments/qol/styles.mjs";
import { initialsFor, colorFor } from "../experiments/qol/avatar.mjs";

const BIMI_ORIGINS = { origins: ["https://*/*"] };
const RESULT_BATCH_MS = 30;
const SAMPLES_PER_FOLDER = 50;
const THUNDERBIRD_SETTINGS = ["listView", "markReadOnView", "unifiedFolders"];

async function loadStoredSettings() {
  const storage = browser.storage.local;
  const servers = await messenger.qol.listServers();
  const keys = servers.map(server => server.key);
  const { settings: stored } = await storage.get("settings");
  let loaded = normalizeSettings(stored);
  const pruned = keys.length ? pruneServers(loaded, keys) : loaded;
  if (JSON.stringify(pruned) !== JSON.stringify(loaded)) {
    loaded = pruned;
    await storage.set({ settings: loaded });
  }
  return loaded;
}

let settings = await loadStoredSettings();
let composeState = normalizeComposeState((await browser.storage.local.get(COMPOSE_STATE_KEY))[COMPOSE_STATE_KEY]);
let bimiAllowed = await browser.permissions.contains(BIMI_ORIGINS);
const cache = new IconCache(idbStore());

// BIMI stays off until the optional host permission has been granted.
function effectiveSettings() {
  if (!settings.icons.bimi.enabled || bimiAllowed) {
    return settings;
  }
  return { ...settings, icons: { ...settings.icons, bimi: { ...settings.icons.bimi, enabled: false } } };
}

const resolver = createIconResolver({
  cache,
  fetchFn: (url, options) => fetch(url, options),
  lookupContactPhoto,
  getSettings: effectiveSettings,
});

// Sent in small batches as they arrive so one slow fetch doesn't hold back the other cards.
let outgoing = {};
let outgoingTimer = null;
function sendResult(id, result) {
  outgoing[id] = result;
  if (!outgoingTimer) {
    outgoingTimer = setTimeout(() => {
      const map = outgoing;
      outgoing = {};
      outgoingTimer = null;
      messenger.qol.setIcons(map);
    }, RESULT_BATCH_MS);
  }
}

messenger.qol.onCardsRendered.addListener(cards => {
  for (const card of cards) {
    const avatar = { initials: initialsFor(card.displayName, card.email), color: colorFor(card.email) };
    resolver
      .resolve(card)
      .catch(e => {
        console.warn("[qol] icon resolution failed", e);
        return { dataUrl: null, unverified: false };
      })
      .then(result => sendResult(card.id, { ...result, ...avatar, generation: card.generation }));
  }
});

function applyConfig(method) {
  const config = toExperimentConfig(settings);
  return messenger.qol[method](config, buildStylesheet(config));
}

// The compose ribbon is a separate experiment: any failure there (missing namespace,
// throw, rejection) must only disable the ribbon, never icons, cards or previews.
async function callCompose(method, ...args) {
  try {
    return await messenger.qolCompose[method](...args);
  } catch (e) {
    console.warn("[qol] compose ribbon", method, e);
    return undefined;
  }
}

function applyComposeConfig(method) {
  const config = { ...toExperimentConfig(settings).compose, state: composeState };
  return callCompose(method, config);
}

// The search is a separate experiment too: a failure there only disables the search.
async function callSearch(method, ...args) {
  try {
    return await messenger.qolSearch[method](...args);
  } catch (e) {
    console.warn("[qol] search", method, e);
    return undefined;
  }
}

function applySearchConfig(method) {
  return callSearch(method, toExperimentConfig(settings).search);
}

try {
  messenger.qolCompose.onStateChanged.addListener(async state => {
    composeState = normalizeComposeState(state);
    try {
      await browser.storage.local.set({ [COMPOSE_STATE_KEY]: composeState });
    } catch (e) {
      console.warn("[qol] compose state not stored", e);
    }
  });
} catch (e) {
  console.warn("[qol] compose ribbon unavailable", e);
}

// "Set as default" in the ribbon is stored like an options page change, so it
// reaches every compose window.
try {
  messenger.qolCompose.onDefaultStyleSetChanged.addListener(async styleSet => {
    try {
      await browser.storage.local.set({ settings: normalizeSettings({ ...settings, compose: { ...settings.compose, styleSet } }) });
    } catch (e) {
      console.warn("[qol] default style set not stored", e);
    }
  });
} catch (e) {
  console.warn("[qol] default style set unavailable", e);
}

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) {
    return;
  }
  const before = JSON.stringify(settings.icons);
  settings = normalizeSettings(changes.settings.newValue);
  try {
    await applyConfig("updateConfig");
  } catch (e) {
    console.warn("[qol] settings not applied", e);
  }
  await applyComposeConfig("updateConfig");
  await applySearchConfig("updateConfig");
  if (JSON.stringify(settings.icons) !== before) {
    await messenger.qol.clearIcons();
  }
});

async function onPermissionsChanged() {
  bimiAllowed = await browser.permissions.contains(BIMI_ORIGINS);
  await messenger.qol.clearIcons();
}
browser.permissions.onAdded.addListener(onPermissionsChanged);
browser.permissions.onRemoved.addListener(onPermissionsChanged);

async function onContactsChanged() {
  clearContactPhotoCache();
  await messenger.qol.clearIcons();
}
messenger.contacts.onCreated.addListener(onContactsChanged);
messenger.contacts.onUpdated.addListener(onContactsChanged);
messenger.contacts.onDeleted.addListener(onContactsChanged);

browser.runtime.onMessage.addListener(async message => {
  switch (message?.type) {
    case "getStatus":
      return {
        features: {
          ...(await messenger.qol.getFeatures()),
          ...((await callCompose("getFeatures")) ?? { composeRibbon: false }),
          ...((await callSearch("getFeatures")) ?? { search: false }),
        },
        trustedConfigured: Object.keys(settings.icons.trustedByServer).length > 0,
        bimiAllowed,
      };
    case "listServers":
      return messenger.qol.listServers();
    case "getThunderbirdSettings":
      return messenger.qol.getThunderbirdSettings();
    case "setThunderbirdSetting":
      if (!THUNDERBIRD_SETTINGS.includes(message.name)) {
        return undefined;
      }
      return messenger.qol.setThunderbirdSetting(message.name, message.name === "listView" ? message.value : Boolean(message.value));
    case "applyViewToAllFolders":
      return messenger.qol.applyViewToAllFolders(message.mode === "threaded" ? "threaded" : "grouped");
    case "detectAuthservIds": {
      const samples = await messenger.qol.sampleAuthResults(SAMPLES_PER_FOLDER, message.serverKey);
      const ranked = rankAuthservIds(samples[message.serverKey] ?? []);
      return { ranked, dominant: dominantAuthservId(ranked) };
    }
    case "clearCache":
      await cache.clear();
      clearContactPhotoCache();
      await messenger.qol.clearIcons();
      return { ok: true };
  }
  return undefined;
});

try {
  await applyConfig("init");
} finally {
  await applyComposeConfig("init");
  await applySearchConfig("init");
}
console.log("[qol] background started");
