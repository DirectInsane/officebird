// Privileged code: it works only with Thunderbird's compose windows and never touches the network.
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");

const COMPOSE_URL = "chrome://messenger/content/messengercompose/messengercompose.xhtml";
const SHEET_PATH = "experiments/compose/ribbon.css";
// Must match ribbon.css, which hides Thunderbird's own bars only while it is set.
const ATTACHED_ATTR = "data-qol-ribbon";
// Classic scripts in load order, each with the one global it defines.
const SCRIPTS = [
  ["qolFormatting", "experiments/compose/formatting.js"],
  ["qolComposeLabels", "experiments/compose/labels.js"],
  ["qolRibbonDefinition", "experiments/compose/definition.js"],
  ["qolRibbonView", "experiments/compose/view.js"],
  ["qolComposeEngine", "experiments/compose/engine.js"],
  ["qolComposeCommands", "experiments/compose/commands.js"],
];
// Without these a window keeps Thunderbird's own bars.
const REQUIRED_IDS = ["compose-toolbox", "composeToolbar2", "FormatToolbar", "cmd_sendButton"];
const SYNC_DELAY_MS = 50;
// Drafts, templates and a reply from a template are left out: they keep their style set.
const DEFAULT_SET_TYPES = new Set([
  Ci.nsIMsgCompType.New, Ci.nsIMsgCompType.MailToUrl, Ci.nsIMsgCompType.NewsPost,
  Ci.nsIMsgCompType.Reply, Ci.nsIMsgCompType.ReplyAll, Ci.nsIMsgCompType.ReplyToSender,
  Ci.nsIMsgCompType.ReplyToGroup, Ci.nsIMsgCompType.ReplyToSenderAndGroup, Ci.nsIMsgCompType.ReplyToList,
  Ci.nsIMsgCompType.ForwardInline, Ci.nsIMsgCompType.ForwardAsAttachment,
]);
const OP_STATES = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikethrough",
  subscript: "subscript",
  superscript: "superscript",
  bulletList: "insertUnorderedList",
  numberList: "insertOrderedList",
};
const ALIGN_STATES = { left: "justifyLeft", center: "justifyCenter", right: "justifyRight", justify: "justifyFull" };

function log(...args) {
  console.warn("[qolCompose]", ...args);
}

// loadSubScript refuses add-on package URLs in privileged code.
function loadAddonScript(extension, path) {
  const channel = NetUtil.newChannel({ uri: extension.rootURI.resolve(path), loadUsingSystemPrincipal: true });
  const stream = channel.open();
  try {
    const source = NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
    const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxName: `qol:${path}` });
    Cu.evalInSandbox(source, sandbox, "latest", path, 1);
    return sandbox;
  } finally {
    stream.close();
  }
}

function hasEditor(win) {
  try {
    return Boolean(win.GetCurrentEditor());
  } catch (e) {
    return false;
  }
}

function sizeText(pt) {
  if (!Number.isFinite(pt)) {
    return "";
  }
  return Number.isInteger(pt) ? String(pt) : pt.toFixed(1);
}

// Also scheduled after every ribbon action: a typing style set at the cursor fires neither
// selectionchange nor input. The delay lets the engine's own selection moves settle first.
function createStateSync(win, controller, definition) {
  const controls = [...definition.quickAccess, ...definition.tabs.flatMap(t => t.groups.flatMap(g => g.controls))];
  let doc = null;
  let timer = null;

  function schedule() {
    if (timer !== null) {
      win.clearTimeout(timer);
    }
    timer = win.setTimeout(syncState, SYNC_DELAY_MS);
  }

  function unbind() {
    doc?.removeEventListener("selectionchange", schedule);
    doc?.removeEventListener("input", schedule);
    doc = null;
  }

  // The editor gets a new document after a re-init.
  function bind() {
    let next = null;
    try {
      next = win.GetCurrentEditor()?.document ?? null;
    } catch (e) {
      // No editor yet.
    }
    if (next !== doc) {
      unbind();
      doc = next;
      doc?.addEventListener("selectionchange", schedule);
      doc?.addEventListener("input", schedule);
    }
    schedule();
  }

  function commandState(command) {
    try {
      return doc.queryCommandState(command);
    } catch (e) {
      return false;
    }
  }

  function syncState() {
    timer = null;
    const { view, engine } = controller;
    // A live preview is not the mail's format; the engine asks for a sync once it ends.
    if (!doc || !view || !engine?.isHTML() || engine.previewActive) {
      return;
    }
    let format;
    try {
      format = engine.formatAt();
    } catch (e) {
      log("state sync failed", e);
      return;
    }
    for (const c of controls) {
      if (c.kind === "font") {
        view.setValue(c.id, format.family);
      } else if (c.kind === "size") {
        view.setValue(c.id, sizeText(format.sizePt));
      } else if (c.kind === "gallery") {
        view.setValue(c.id, format.style);
      } else if (c.kind === "styleSet") {
        view.setValue(c.id, engine.activeSet);
      } else if (c.kind === "toggle" && c.op?.op === "align") {
        view.setPressed(c.id, commandState(ALIGN_STATES[c.op.value]));
      } else if (c.kind === "toggle" && OP_STATES[c.op?.op]) {
        view.setPressed(c.id, commandState(OP_STATES[c.op.op]));
      }
    }
  }

  function destroy() {
    if (timer !== null) {
      win.clearTimeout(timer);
      timer = null;
    }
    unbind();
  }

  bind();
  return { bind, schedule, syncState, destroy };
}

class RibbonManager {
  constructor(extension) {
    this.extension = extension;
    this.config = null;
    this.features = { composeRibbon: true };
    this.listenerId = `${extension.id}-compose`;
    this.sheetURL = extension.rootURI.resolve(SHEET_PATH);
    this.windows = new Map();
    this.listeners = new Set();
    this.defaultListeners = new Set();
    this.started = false;
    this.warned = false;
    this.libs = null;
    this.fonts = null;
    try {
      this.libs = Object.fromEntries(SCRIPTS.map(([name, path]) => [name, loadAddonScript(extension, path)[name]]));
    } catch (e) {
      this.unavailable("ribbon scripts not loaded", e);
    }
  }

  // Lifecycle

  init(config) {
    this.config = config;
    if (this.started) {
      this.refreshAll();
    } else {
      this.started = true;
      // Also runs for compose windows that are already open.
      ExtensionSupport.registerWindowListener(this.listenerId, {
        chromeURLs: [COMPOSE_URL],
        onLoadWindow: win => this.watch(win),
      });
    }
    return { ...this.features };
  }

  updateConfig(config) {
    this.config = config;
    this.refreshAll();
    this.shareState();
  }

  teardown() {
    if (this.started) {
      ExtensionSupport.unregisterWindowListener(this.listenerId);
      this.started = false;
    }
    for (const win of [...this.windows.keys()]) {
      this.forget(win);
    }
    this.listeners.clear();
    this.defaultListeners.clear();
  }

  unavailable(reason, error) {
    this.features.composeRibbon = false;
    if (!this.warned) {
      this.warned = true;
      log(`ribbon unavailable: ${reason}`, error ?? "");
    }
  }

  // Windows

  watch(win) {
    if (this.windows.has(win)) {
      return;
    }
    // compose-editor-ready fires after the load and again whenever the window is initialized
    // anew; attach is idempotent, and applyDefaultSet acts only the first time.
    const onReady = () => {
      this.refresh(win);
      this.applyDefaultSet(win);
    };
    const onUnload = () => this.forget(win);
    win.addEventListener("compose-editor-ready", onReady);
    win.addEventListener("unload", onUnload, { once: true });
    this.windows.set(win, { onReady, onUnload, opened: false });
    this.refresh(win);
  }

  forget(win) {
    const entry = this.windows.get(win);
    if (!entry) {
      return;
    }
    this.windows.delete(win);
    win.removeEventListener("compose-editor-ready", entry.onReady);
    win.removeEventListener("unload", entry.onUnload);
    this.detach(win);
  }

  refreshAll() {
    for (const win of this.windows.keys()) {
      this.refresh(win);
    }
  }

  refresh(win) {
    if (this.config?.ribbon && this.libs) {
      this.attach(win);
    } else {
      this.detach(win);
    }
  }

  attach(win) {
    if (win.qolCompose) {
      // The editor got ready anew, perhaps with a new document.
      win.qolCompose.sync?.bind();
      return;
    }
    if (!win.composeEditorReady) {
      return;
    }
    const doc = win.document;
    const missing = REQUIRED_IDS.filter(id => !doc.getElementById(id));
    if (!hasEditor(win)) {
      missing.push("GetCurrentEditor()");
    }
    if (missing.length) {
      this.unavailable(`compose window lacks ${missing.join(", ")}`);
      return;
    }
    const manager = this;
    const controller = {
      win, root: null, view: null, commands: null, engine: null, sync: null, detach: () => this.detach(win),
      get defaultStyleSet() {
        return manager.config?.styleSet ?? "default";
      },
    };
    win.qolCompose = controller;
    try {
      win.windowUtils.loadSheetUsingURIString(this.sheetURL, win.windowUtils.AUTHOR_SHEET);
      const { qolFormatting, qolComposeLabels, qolRibbonDefinition, qolRibbonView, qolComposeEngine, qolComposeCommands } = this.libs;
      controller.view = qolRibbonView.create(win, {
        definition: qolRibbonDefinition.DEFINITION,
        labels: qolComposeLabels,
        lang: qolComposeLabels.pickLanguage(Services.locale.appLocaleAsBCP47),
        mac: Services.appinfo.OS === "Darwin",
        state: this.config?.state ?? {},
        formatting: qolFormatting,
        fontNames: async () => this.fontNames(),
        // Looked up per click: the commands are created after the view.
        onAction: (id, extra) => {
          try {
            // Every action (sending too) sees the mail without a preview.
            controller.engine?.cancelPreview();
            controller.commands?.run(id, extra);
          } finally {
            controller.sync?.schedule();
          }
        },
        onPick: (id, op) => {
          try {
            return controller.commands?.pick(id, op) ?? false;
          } finally {
            controller.sync?.schedule();
          }
        },
        onHover: (id, op) => {
          if (op) {
            controller.engine?.preview(op);
          } else {
            controller.engine?.cancelPreview();
          }
        },
        onStateChange: partial => this.changeState(partial),
        onSetDefault: () => this.setDefaultStyleSet(controller.engine?.activeSet ?? "default"),
      });
      controller.root = controller.view.root;
      // Below the titlebar row (macOS window buttons), where Thunderbird's compose toolbar starts.
      doc.getElementById("composeToolbar2").before(controller.root);
      // Before the commands, which keep the engine they are given.
      const { quickAccess, tabs } = qolRibbonDefinition.DEFINITION;
      const painterIds = [...quickAccess, ...tabs.flatMap(t => t.groups.flatMap(g => g.controls))]
        .filter(c => c.action === "painter")
        .map(c => c.id);
      controller.engine = qolComposeEngine.create(win, {
        formatting: qolFormatting,
        onPreviewEnd: () => controller.sync?.schedule(),
        onPaintChange: () => {
          for (const id of painterIds) {
            controller.view?.setPressed(id, controller.engine?.paint.active);
          }
          controller.sync?.schedule();
        },
      });
      controller.view.setFormattingEnabled(controller.engine.isHTML());
      controller.commands = qolComposeCommands.create(win, {
        view: controller.view,
        definition: qolRibbonDefinition.DEFINITION,
        engine: controller.engine,
        formatting: qolFormatting,
      });
      controller.sync = createStateSync(win, controller, qolRibbonDefinition.DEFINITION);
      doc.documentElement.setAttribute(ATTACHED_ATTR, "true");
    } catch (e) {
      log("attach failed", e);
      this.detach(win);
    }
  }

  detach(win) {
    const controller = win.qolCompose;
    if (!controller) {
      return;
    }
    delete win.qolCompose;
    win.document.documentElement.removeAttribute(ATTACHED_ATTR);
    try {
      // First: the mail must not keep a preview, nor the painter stay on.
      controller.engine?.paint.stop();
      controller.engine?.cancelPreview();
    } catch (e) {
      log("painter and preview cleanup failed", e);
    }
    controller.sync?.destroy();
    try {
      // Before the view: Thunderbird's popups go back into its toolbar.
      controller.commands?.destroy();
    } catch (e) {
      log("commands cleanup failed", e);
    }
    try {
      controller.engine?.destroy();
    } catch (e) {
      log("engine cleanup failed", e);
    }
    try {
      controller.view?.destroy();
    } catch (e) {
      log("view cleanup failed", e);
    }
    controller.root?.remove();
    try {
      win.windowUtils.removeSheetUsingURIString(this.sheetURL, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      // The sheet was never loaded.
    }
  }

  // Once per window, from onReady: mails already open when the ribbon is turned on or the
  // add-on is updated keep their style set.
  applyDefaultSet(win) {
    const entry = this.windows.get(win);
    if (!entry || entry.opened) {
      return;
    }
    entry.opened = true;
    const key = this.config?.styleSet ?? "default";
    if (key === "default" || !DEFAULT_SET_TYPES.has(win.gMsgCompose?.type)) {
      return;
    }
    try {
      win.qolCompose?.engine?.applyOpeningSet(key);
      win.qolCompose?.sync?.schedule();
    } catch (e) {
      log("default style set not applied", e);
    }
  }

  setDefaultStyleSet(key) {
    if (this.config) {
      this.config.styleSet = key;
    }
    for (const fire of this.defaultListeners) {
      fire.async(key);
    }
  }

  // State sync

  changeState(partial) {
    const state = { ...(this.config?.state ?? {}), ...partial };
    if (this.config) {
      this.config.state = state;
    }
    this.shareState();
    this.reportState(state);
  }

  shareState() {
    const state = this.config?.state;
    if (!state) {
      return;
    }
    for (const win of this.windows.keys()) {
      try {
        win.qolCompose?.view?.updateState(state);
      } catch (e) {
        log("state update failed", e);
      }
    }
  }

  fontNames() {
    if (!this.fonts) {
      try {
        const enumerator = Cc["@mozilla.org/gfx/fontenumerator;1"].getService(Ci.nsIFontEnumerator);
        this.fonts = Object.freeze([...new Set(enumerator.EnumerateAllFonts())]);
      } catch (e) {
        log("font list unavailable", e);
        this.fonts = Object.freeze([]);
      }
    }
    return this.fonts;
  }

  reportState(state) {
    for (const fire of this.listeners) {
      fire.async(state);
    }
  }
}

var qolCompose = class extends ExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (!isAppShutdown) {
      this.manager?.teardown();
    }
  }

  getAPI(context) {
    if (!this.manager) {
      this.manager = new RibbonManager(this.extension);
    }
    const manager = this.manager;
    return {
      qolCompose: {
        init: async config => manager.init(config),
        updateConfig: async config => manager.updateConfig(config),
        getFeatures: async () => ({ ...manager.features }),
        onStateChanged: new ExtensionCommon.EventManager({
          context,
          name: "qolCompose.onStateChanged",
          register: fire => {
            manager.listeners.add(fire);
            return () => manager.listeners.delete(fire);
          },
        }).api(),
        onDefaultStyleSetChanged: new ExtensionCommon.EventManager({
          context,
          name: "qolCompose.onDefaultStyleSetChanged",
          register: fire => {
            manager.defaultListeners.add(fire);
            return () => manager.defaultListeners.delete(fire);
          },
        }).api(),
      },
    };
  }
};
