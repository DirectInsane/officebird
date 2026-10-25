import { loadSettings, saveSettings, normalizeSettings } from "../background/settings.js";

/* global qolDateFormat */ // from ../experiments/qol/dateformat.js

const BIMI_ORIGINS = { origins: ["https://*/*"] };
// Feeds and newsgroups carry no Authentication-Results.
const HIDDEN_SERVER_TYPES = ["rss", "nntp"];
const SAVE_DELAY_MS = 150;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const form = document.getElementById("form");

// Right after Thunderbird starts (or the add-on updates) the background may
// not be listening yet; retry instead of leaving a dead page.
async function ask(message, tries = 40) {
  for (let i = 1; ; i++) {
    try {
      return await browser.runtime.sendMessage(message);
    } catch (e) {
      if (i >= tries) {
        throw e;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
const storage = browser.storage.local;
const servers = (await ask({ type: "listServers" })).filter(
  server => !HIDDEN_SERVER_TYPES.includes(server.type)
);

// data-thunderbird marks Thunderbird's own settings, data-no-setting helper controls;
// neither is stored with the add-on's settings.
function fields() {
  return [...form.querySelectorAll("[name]:not([data-no-setting]):not([data-thunderbird])")];
}

function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let target = object;
  for (const key of keys) {
    target = target[key] ??= {};
  }
  target[last] = value;
}

const splitList = text => text.split(/[\s,;]+/).filter(Boolean);

function accountInputs() {
  return [...document.querySelectorAll("#accounts .account input")];
}

function renderAccounts() {
  const template = document.getElementById("accountRow");
  const rows = servers.map(server => {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.serverKey = server.key;
    row.querySelector(".account-name").textContent = server.name;
    row.querySelector(".detect").addEventListener("click", () => detect(row));
    return row;
  });
  document.getElementById("accounts").replaceChildren(...rows);
}

function render(settings) {
  for (const input of accountInputs()) {
    const key = input.closest(".account").dataset.serverKey;
    input.value = (Object.hasOwn(settings.icons.trustedByServer, key) ? settings.icons.trustedByServer[key] : []).join(", ");
  }
  for (const field of fields()) {
    const value = getPath(settings, field.name);
    if (field.type === "checkbox") {
      field.checked = value;
    } else if (field.type === "radio") {
      field.checked = field.value === value;
    } else if (Array.isArray(value)) {
      field.value = value.join(", ");
    } else {
      field.value = value;
    }
  }
  document.getElementById("linkTones").checked = settings.style.readSender === settings.style.readSubject;
  renderDerived(settings);
}

function readForm() {
  const raw = {};
  for (const field of fields()) {
    if (field.type === "radio") {
      if (field.checked) {
        setPath(raw, field.name, field.value);
      }
      continue;
    }
    let value = field.type === "checkbox" ? field.checked : field.value;
    if (field.name === "icons.freemailExtra") {
      value = splitList(value);
    }
    setPath(raw, field.name, value);
  }
  // Only accounts that still exist are kept.
  raw.icons.trustedByServer = Object.fromEntries(
    accountInputs().map(input => [input.closest(".account").dataset.serverKey, splitList(input.value)])
  );
  return normalizeSettings(raw);
}

function hexToRgba(hex, opacity) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
}

function renderDerived(settings) {
  document.querySelector('[data-section="icons"]').classList.toggle("off", !settings.icons.enabled);
  document.querySelector('[data-section="preview"]').classList.toggle("off", !settings.preview.enabled);

  for (const output of document.querySelectorAll("output[data-for]")) {
    output.textContent = getPath(settings, output.dataset.for) + (output.dataset.unit ? ` ${output.dataset.unit}` : "");
  }

  const now = new Date();
  const samples = [new Date(now - 2 * HOUR), new Date(now - 3 * DAY), new Date(now - 400 * DAY)];
  for (const example of document.querySelectorAll("[data-example]")) {
    const style = example.dataset.example;
    example.textContent = samples.map(d => qolDateFormat.format(d, style, now)).join(" · ");
  }

  const preview = document.querySelector(".preview-panel");
  preview.classList.toggle("no-icons", !settings.icons.enabled);
  preview.classList.toggle("no-preview", !settings.preview.enabled);
  preview.classList.toggle("outlook", settings.style.outlook);
  for (const look of ["theme", "outline", "filled", "both"]) {
    preview.classList.toggle(`look-${look}`, settings.style.cardLook === look);
  }
  preview.style.setProperty("--qol-bar-width", `${settings.style.barWidth}px`);
  preview.style.setProperty("--qol-card-radius", `${settings.style.cardRadius}px`);
  preview.style.setProperty("--qol-read-sender", `${settings.style.readSender}%`);
  preview.style.setProperty("--qol-read-subject", `${settings.style.readSubject}%`);
  preview.style.setProperty("--qol-preview-tone", `${settings.preview.tone}%`);
  const tones = `${settings.style.readSender},${settings.style.readSubject}`;
  const presets = [...form.querySelectorAll('[name="readPreset"]')];
  const match = presets.find(radio => radio.value === tones);
  for (const radio of presets) {
    radio.checked = radio === (match ?? presets.find(r => r.value === "custom"));
  }
  document.querySelector('[data-section="view"]').classList.toggle("outlook-on", settings.style.outlook);
  for (const el of preview.querySelectorAll("[data-mock-preview]")) {
    el.style.webkitLineClamp = el.dataset.mockPreview === "cards" ? settings.preview.lines : settings.preview.tableLines;
  }
  const mockDates = [new Date(now - 2 * HOUR), new Date(now - 2 * HOUR), new Date(now - 3 * DAY)];
  const style = settings.table.dateStyle === "thunderbird" ? "datetime" : settings.table.dateStyle;
  for (const el of preview.querySelectorAll("[data-mock-date]")) {
    const date = mockDates[el.dataset.mockDate];
    el.textContent = qolDateFormat.format(date, el.dataset.mockDate === "0" ? "smart" : style, now);
    el.title = qolDateFormat.full(date);
  }
  const bar = document.getElementById("mockBar");
  bar.style.background = hexToRgba(settings.bar.background, settings.bar.opacity);
  bar.style.color = settings.bar.text;
  bar.classList.toggle("compact", settings.bar.compact);
}

async function renderStatus() {
  const status = await ask({ type: "getStatus" });
  const pill = document.getElementById("statusPill");
  pill.textContent = status.trustedConfigured ? "Active" : "Set up verification";
  pill.classList.toggle("warn", !status.trustedConfigured);
  const names = {
    cards: "Cards view",
    table: "Table view",
    preview: "Previews",
    warningBar: "Remote content bar",
    composeRibbon: "Compose ribbon",
  };
  const list = document.getElementById("status");
  list.replaceChildren(
    ...Object.entries(names)
      .filter(([key]) => key in status.features)
      .map(([key, label]) => {
        const li = document.createElement("li");
        const ok = status.features[key];
        li.className = ok ? "" : "problem";
        li.textContent = `${label}: ${ok ? "active" : "unavailable in this Thunderbird version"}`;
        return li;
      })
  );
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(storage, readForm());
    await renderStatus();
  }, SAVE_DELAY_MS);
}

const field = name => form.querySelector(`[name="${name}"]`);

function syncTones(target) {
  const sender = field("style.readSender");
  const subject = field("style.readSubject");
  const link = document.getElementById("linkTones");
  if (target.name === "readPreset") {
    [sender.value, subject.value] = target.value.split(",");
    link.checked = sender.value === subject.value;
  } else if (link.checked && target === sender) {
    subject.value = sender.value;
  } else if (link.checked && (target === subject || target === link)) {
    sender.value = subject.value;
  }
}

form.addEventListener("input", event => {
  if (event.target.dataset.thunderbird !== undefined) {
    return;
  }
  syncTones(event.target);
  renderDerived(readForm());
  scheduleSave();
});

form.addEventListener("change", async event => {
  const { name, type, value, checked, dataset } = event.target;
  if (dataset.thunderbird !== undefined) {
    await ask({ type: "setThunderbirdSetting", name, value: type === "checkbox" ? checked : value });
    return;
  }
  const bimiSwitch = form.querySelector('[name="icons.bimi.enabled"]');
  if (event.target === bimiSwitch && bimiSwitch.checked) {
    // Must run directly in the user gesture.
    const granted = await browser.permissions.request(BIMI_ORIGINS);
    if (!granted) {
      bimiSwitch.checked = false;
    }
  }
  renderDerived(readForm());
  scheduleSave();
});

async function detect(row) {
  const result = row.querySelector(".detect-result");
  result.className = "detect-result";
  result.textContent = "Reading recent mail…";
  const { ranked, dominant } = await ask({ type: "detectAuthservIds", serverKey: row.dataset.serverKey });
  if (!ranked.length) {
    result.textContent = "No verification stamps found in this account's mail on this computer.";
    return;
  }
  if (!dominant) {
    const top = ranked.slice(0, 3).map(o => `${o.id} (${o.count})`).join(", ");
    result.textContent = `No clear winner: ${top}. Enter the right one by hand.`;
    return;
  }
  const best = ranked.find(o => o.id === dominant);
  const input = row.querySelector("input");
  const current = splitList(input.value);
  if (!current.includes(dominant)) {
    input.value = [...current, dominant].join(", ");
  }
  result.className = "detect-result ok";
  result.textContent = `✓ Verified by ${dominant} (found in ${best?.count ?? "most"} mails).`;
  renderDerived(readForm());
  scheduleSave();
}

const CONFIRM_MS = 4000;
for (const button of document.querySelectorAll("[data-view-all]")) {
  let timer = null;
  button.addEventListener("click", async () => {
    const result = document.getElementById("viewAllResult");
    if (!button.classList.contains("confirm")) {
      button.classList.add("confirm");
      button.textContent = "Click again to apply";
      timer = setTimeout(() => {
        button.classList.remove("confirm");
        button.textContent = button.dataset.label;
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    button.classList.remove("confirm");
    button.textContent = button.dataset.label;
    result.className = "detect-result";
    result.textContent = "Updating folders…";
    const mode = button.dataset.viewAll;
    const { changed, failed } = await ask({ type: "applyViewToAllFolders", mode });
    result.className = failed ? "detect-result" : "detect-result ok";
    const what = mode === "grouped" ? "grouped by date" : "showing conversations";
    result.textContent = `✓ ${changed} folders ${what}.` + (failed ? ` ${failed} could not be changed.` : "");
  });
}

document.getElementById("clearCache").addEventListener("click", async event => {
  const button = event.currentTarget;
  await ask({ type: "clearCache" });
  button.textContent = "Cleared ✓";
  setTimeout(() => (button.textContent = "Clear icon cache"), 1500);
});

async function renderThunderbirdSettings() {
  const values = await ask({ type: "getThunderbirdSettings" });
  for (const input of form.querySelectorAll("[data-thunderbird]")) {
    if (input.type === "radio") {
      input.checked = input.value === values[input.name];
    } else {
      input.checked = values[input.name];
    }
  }
}

// The ribbon's "Set as default" changes the style set for new mails too.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) {
    return;
  }
  const styleSet = normalizeSettings(changes.settings.newValue).compose.styleSet;
  for (const radio of form.querySelectorAll('[name="compose.styleSet"]')) {
    radio.checked = radio.value === styleSet;
  }
});

renderAccounts();
render(await loadSettings(storage));
await renderThunderbirdSettings();
// Thunderbird's own menus and settings can change them too.
window.addEventListener("focus", renderThunderbirdSettings);
await renderStatus();
