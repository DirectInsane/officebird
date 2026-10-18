import { test } from "node:test";
import assert from "node:assert/strict";

const event = () => {
  const listeners = [];
  return { listeners, addListener: fn => listeners.push(fn) };
};

function stubs({ compose, qolUpdateConfig, storageSet } = {}) {
  const calls = [];
  const record = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  const api = {
    qol: {
      listServers: record("qol.listServers", []),
      init: record("qol.init", undefined),
      updateConfig: qolUpdateConfig ?? record("qol.updateConfig", undefined),
      clearIcons: record("qol.clearIcons", undefined),
      setIcons: record("qol.setIcons", undefined),
      getFeatures: record("qol.getFeatures", { cards: true }),
      onCardsRendered: event(),
    },
    storage: {
      local: {
        get: record("storage.get", {}),
        set: storageSet ?? record("storage.set", undefined),
      },
      onChanged: event(),
    },
    permissions: { contains: record("permissions.contains", false), onAdded: event(), onRemoved: event() },
    contacts: { onCreated: event(), onUpdated: event(), onDeleted: event() },
    runtime: { onMessage: event() },
  };
  if (typeof compose === "function") {
    Object.defineProperty(api, "qolCompose", { get: compose });
  } else if (compose !== undefined) {
    api.qolCompose = compose;
  }
  return { api, calls };
}

function workingCompose(calls) {
  const record = name => (...args) => {
    calls.push([name, ...args]);
    return Promise.resolve(name === "qolCompose.getFeatures" ? { composeRibbon: true } : undefined);
  };
  return {
    init: record("qolCompose.init"),
    updateConfig: record("qolCompose.updateConfig"),
    getFeatures: record("qolCompose.getFeatures"),
    onStateChanged: event(),
    onDefaultStyleSetChanged: event(),
  };
}

// Keeps the failures the page logs and survives out of the test output.
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));
console.log = () => {};

let loads = 0;
async function loadBackground(api) {
  globalThis.browser = globalThis.messenger = api;
  // idbStore() opens its database when the page loads; never answered here.
  globalThis.indexedDB = { open: () => ({}) };
  await import(`../background/main.js?load=${++loads}`);
}

async function getStatus(api) {
  return api.runtime.onMessage.listeners[0]({ type: "getStatus" });
}

for (const [name, compose, ribbon] of [
  ["missing", undefined, false],
  ["throwing when read", () => { throw new Error("no qolCompose"); }, false],
  // The ribbon itself still works; only its state is not stored.
  ["with a throwing onStateChanged", { ...workingCompose([]), onStateChanged: { addListener() { throw new Error("broken"); } } }, true],
  ["with failing calls", { init: () => { throw new Error("init"); }, updateConfig: () => Promise.reject(new Error("update")), getFeatures: () => Promise.reject(new Error("features")), onStateChanged: event() }, false],
]) {
  test(`a qolCompose namespace ${name} leaves the rest of the add-on working`, async () => {
    const { api, calls } = stubs({ compose });
    await loadBackground(api);
    assert.ok(calls.some(([n]) => n === "qol.init"), "the message list experiment starts");
    assert.equal(api.qol.onCardsRendered.listeners.length, 1, "icons and cards keep working");
    assert.equal(api.storage.onChanged.listeners.length, 1);
    assert.equal(api.runtime.onMessage.listeners.length, 1);
    const status = await getStatus(api);
    assert.equal(status.features.composeRibbon, ribbon);
    assert.equal(status.features.cards, true);
    await api.storage.onChanged.listeners[0]({ settings: { newValue: {} } }, "local");
    assert.ok(calls.some(([n]) => n === "qol.updateConfig"));
  });
}

test("a working qolCompose gets init and reports its features", async () => {
  const { api, calls } = stubs();
  api.qolCompose = workingCompose(calls);
  await loadBackground(api);
  assert.ok(calls.some(([n]) => n === "qolCompose.init"));
  assert.equal(api.qolCompose.onStateChanged.listeners.length, 1);
  assert.equal((await getStatus(api)).features.composeRibbon, true);
});

test("a settings change still reaches the ribbon when the message list experiment rejects it", async () => {
  const { api, calls } = stubs({ qolUpdateConfig: () => Promise.reject(new Error("qol failed")) });
  api.qolCompose = workingCompose(calls);
  await loadBackground(api);
  const [onChanged] = api.storage.onChanged.listeners;
  await onChanged({ settings: { newValue: { compose: { ribbon: false } } } }, "local");
  const update = calls.find(([n]) => n === "qolCompose.updateConfig");
  assert.ok(update, "the ribbon gets the new settings");
  assert.equal(update[1].ribbon, false);
});

test("a state change the storage refuses does not reject", async () => {
  // Only the compose state is refused (settings migration writes too).
  const storageSet = items => ("composeState" in items ? Promise.reject(new Error("quota")) : Promise.resolve());
  const { api, calls } = stubs({ storageSet });
  api.qolCompose = workingCompose(calls);
  await loadBackground(api);
  const [onStateChanged] = api.qolCompose.onStateChanged.listeners;
  await assert.doesNotReject(onStateChanged({ collapsed: true }));
  await api.storage.onChanged.listeners[0]({ settings: { newValue: {} } }, "local");
  const update = calls.findLast(([n]) => n === "qolCompose.updateConfig");
  assert.equal(update[1].state.collapsed, true);
});

test("the ribbon gets the style set new mails start with", async () => {
  const { api, calls } = stubs();
  api.qolCompose = workingCompose(calls);
  await loadBackground(api);
  const init = calls.find(([n]) => n === "qolCompose.init");
  assert.equal(init[1].styleSet, "default");
  await api.storage.onChanged.listeners[0]({ settings: { newValue: { compose: { styleSet: "classic" } } } }, "local");
  assert.equal(calls.findLast(([n]) => n === "qolCompose.updateConfig")[1].styleSet, "classic");
});

test("a style set the ribbon makes the default is stored in the settings", async () => {
  const { api, calls } = stubs();
  api.qolCompose = workingCompose(calls);
  await loadBackground(api);
  const [onDefault] = api.qolCompose.onDefaultStyleSetChanged.listeners;
  await onDefault("modern");
  const stored = calls.findLast(([n, items]) => n === "storage.set" && items.settings);
  assert.equal(stored[1].settings.compose.styleSet, "modern");
  assert.equal(stored[1].settings.compose.ribbon, true, "the other settings stay");
  await onDefault("fancy");
  assert.equal(calls.findLast(([n, items]) => n === "storage.set" && items.settings)[1].settings.compose.styleSet, "default");
});
