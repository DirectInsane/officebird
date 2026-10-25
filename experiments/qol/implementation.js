// Privileged code: works only with Thunderbird's UI and local message data, never the network.
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
var { MimeParser } = ChromeUtils.importESModule("resource:///modules/mimeParser.sys.mjs");
var { MsgHdrToMimeMessage } = ChromeUtils.importESModule("resource:///modules/gloda/MimeMessage.sys.mjs");
var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
var { XULStoreUtils } = ChromeUtils.importESModule("resource:///modules/XULStoreUtils.sys.mjs");
var { setTimeout, clearTimeout, setInterval, clearInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const MAX_ENTRIES = 5000;
const MAX_HEADER_BYTES = 65536;
const CARD_BATCH_MS = 50;
const PREVIEW_BATCH_MS = 100;
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const PREVIEW_READ_BYTES = 256 * 1024;
const PREVIEW_RETRY_MS = 30000;
const PREVIEW_MAX_TRIES = 3;
const MAX_PARALLEL_PARSES = 2;
const PREVIEW_MAX_CHARS = 600;
// Provider detection reads each message from disk on the main thread.
const MAX_SCAN_PER_FOLDER = 200;
// Icons the background may hand over; anything else is dropped.
const ICON_DATA_URL = /^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp);base64,/;
// Line height factors match .qol-preview in styles.mjs; the gap is the flex
// gap the card column adds in front of the preview element.
const PREVIEW_LINE_FACTOR = 1.35 * 0.9;
const PREVIEW_GAP_PX = 6;
const TABLE_PREVIEW_GAP_PX = 4;
const DATE_REFRESH_MS = 60000;
const LIST_VIEW_PREF = "mail.threadpane.listview";
const MARK_READ_PREF = "mailnews.mark_message_read.auto";
const GLODA_INDEX_PREF = "mailnews.database.global.indexer.enabled";
const MESSAGE_WINDOW_URL = "chrome://messenger/content/messageWindow.xhtml";
// Defaults Thunderbird uses for folders it hasn't stored a view for yet.
const DEFAULT_VIEW_FLAGS_PREF = "mailnews.default_view_flags";
const DEFAULT_SORT_TYPE_PREF = "mailnews.default_sort_type";
const DEFAULT_SORT_ORDER_PREF = "mailnews.default_sort_order";
const DEFAULT_CARD_GAP = 4;
// Group header height as a multiple of the UI font size.
const GROUP_HEADER_FACTOR = 2.5;
const GROUP_HEADER_MIN_PX = 26;
const COLLAPSED_GROUPS_PROPERTY = "officebirdCollapsedGroups";
const UPDATE_NOTICE = "officebird-update";
const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";

function log(...args) {
  console.warn("[qol]", ...args);
}

class CappedMap extends Map {
  set(key, value) {
    this.delete(key);
    super.set(key, value);
    if (this.size > MAX_ENTRIES) {
      this.delete(this.keys().next().value);
    }
    return this;
  }
}

// Thunderbird's database keeps only the last Authentication-Results, which the sender
// controls, so the local copy is read. Returns all occurrences, topmost first, one per
// line, or null when there is no local copy yet.
function readAuthResults(hdr) {
  if (!hdr.folder.hasMsgOffline(hdr.messageKey)) {
    return null;
  }
  const text = readLocalCopy(hdr, MAX_HEADER_BYTES, true);
  const end = text.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? text.slice(0, end) : text).replace(/^>?From [^\r\n]*\r?\n/, "");
  const values = MimeParser.extractHeaders(block + "\r\n\r\n").getRawHeader("authentication-results") || [];
  return values.map(v => v.replace(/\r?\n[ \t]+/g, " ").replace(/[\r\n]/g, " ")).join("\n");
}

// Up to `max` bytes of the local copy, as a binary string.
function readLocalCopy(hdr, max, headersOnly = false) {
  const limit = Math.min(max, hdr.getUint32Property("offlineMsgSize") || hdr.messageSize || max);
  const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
  sis.init(hdr.folder.getMsgInputStream(hdr));
  let text = "";
  try {
    while (text.length < limit) {
      const available = sis.available();
      if (!available) {
        break;
      }
      text += sis.readBytes(Math.min(available, 65536, limit - text.length));
      if (headersOnly && /\r?\n\r?\n/.test(text)) {
        break;
      }
    }
  } catch (e) {
    // The store refuses reads past the message end; what we have is enough.
  } finally {
    sis.close();
  }
  return text;
}

// For mails too large for the full parser. Text parts come before the attachments,
// so the start of the message holds them.
function readStartPreview(hdr, pickBody) {
  const raw = readLocalCopy(hdr, PREVIEW_READ_BYTES).replace(/^>?From [^\r\n]*\r?\n/, "");
  const parts = new Map();
  MimeParser.parseSync(
    raw,
    {
      startPart(num, headers) {
        const disposition = headers.getRawHeader("content-disposition")?.[0] || "";
        const { mediatype, subtype } = headers.contentType;
        parts.set(num, { type: `${mediatype}/${subtype}`, attachment: /^\s*attachment/i.test(disposition), data: "" });
      },
      deliverPartData(num, data) {
        parts.get(num).data += data;
      },
    },
    { bodyformat: "decode", strformat: "unicode" }
  );
  const body = pickBody([...parts.values()]);
  if (body?.type !== "text/html") {
    return body?.data || "";
  }
  const flags = Ci.nsIDocumentEncoder.OutputNoScriptContent | Ci.nsIDocumentEncoder.OutputNoFramesContent;
  return Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils).convertToPlainText(body.data, flags, 0);
}

// loadSubScript refuses add-on package URLs in privileged code, hence the sandbox.
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

// The view the search experiment shows its results in: a search view without a folder
// of its own. Saved searches open as a multi-folder view of their virtual folder.
function isSearchView(win) {
  const wrapper = win.gViewWrapper;
  return Boolean(wrapper?.isSearch && !wrapper.displayedFolder);
}

// Message keys get reused (compacting a local folder, deleting and recreating one),
// so the Message-ID is part of the cache key.
function cardId(hdr) {
  return `${hdr.folder.URI}#${hdr.messageKey}#${hdr.messageId}`;
}

class QolState {
  constructor(extension) {
    this.extension = extension;
    this.config = null;
    this.sheetURI = null;
    this.features = { cards: true, table: true, preview: true, warningBar: false, groupHeaders: true, expandGroups: true, readerAvatar: true };
    this.dateFormat = null;
    this.dateTimer = null;
    try {
      this.dateFormat = loadAddonScript(extension, "experiments/qol/dateformat.js").qolDateFormat;
    } catch (e) {
      log("date formatter not loaded", e);
    }
    this.previewClean = text => (text || "").replace(/\s+/g, " ").trim();
    this.pickBody = null;
    try {
      ({ clean: this.previewClean, pickBody: this.pickBody } = loadAddonScript(extension, "experiments/qol/previewtext.js").qolPreviewText);
    } catch (e) {
      log("preview text cleanup not loaded", e);
    }
    this.cardMenu = null;
    try {
      this.cardMenu = loadAddonScript(extension, "experiments/qol/cardmenu.js").qolCardMenu;
    } catch (e) {
      log("card menu placement not loaded", e);
    }
    this.groupRows = null;
    try {
      this.groupRows = loadAddonScript(extension, "experiments/qol/grouprows.js").qolGroupRows;
    } catch (e) {
      log("group row layout not loaded", e);
      this.features.groupHeaders = false;
    }
    this.icons = new CappedMap();
    this.dataUrls = new Map();
    this.auth = new CappedMap();
    this.requested = new Set();
    // Bumped by clearIcons(); results for older card batches are dropped.
    this.generation = 0;
    this.pending = new Map(); // id → message header
    // Window → number of folders in its search results, for the folder labels.
    this.searchFolderCounts = new WeakMap();
    this.pendingTimer = null;
    this.previewTries = new CappedMap(); // id → { count, at }
    this.previewQueue = new Map();
    this.previewTimer = null;
    this.previewText = new CappedMap(); // id → text from the full parser
    this.parseQueue = [];
    this.parsing = 0;
    this.expandingGroups = false;
    this.listeners = new Set();
    this.windows = new Map(); // about:3pane window → restore function
    this.readers = new Map(); // about:message window → restore function
    this.tabMonitors = new Map(); // messenger window → { monitor, onUnload }
    this.watchedBrowsers = new Map(); // tab browser → load listener
    this.started = false;
    this.tornDown = false;
    this.updateVersion = null;
    this.updateTexts = null;
    this.updateListening = false;
  }

  // Lifecycle

  init(config, css) {
    this.config = config;
    this.applySheet(css);
    if (!this.dateTimer) {
      this.dateTimer = setInterval(() => this.refreshDates(), DATE_REFRESH_MS);
    }
    if (!this.started) {
      this.started = true;
      ExtensionSupport.registerWindowListener(this.extension.id, {
        chromeURLs: [MESSENGER_URL],
        onLoadWindow: win => this.watchMessengerWindow(win),
      });
      ExtensionSupport.registerWindowListener(`${this.extension.id}-reader`, {
        chromeURLs: [MESSAGE_WINDOW_URL],
        onLoadWindow: win => this.watchMessageBrowser(win.document.getElementById("messageBrowser")),
      });
    }
    return this.features;
  }

  updateConfig(config, css) {
    const old = this.config;
    this.config = config;
    this.applySheet(css);
    const heightChanged =
      !old ||
      old.preview.enabled !== config.preview.enabled ||
      old.preview.lines !== config.preview.lines ||
      old.preview.tableLines !== config.preview.tableLines ||
      old.style?.outlook !== config.style?.outlook ||
      old.style?.cardGap !== config.style?.cardGap ||
      old.style?.groupHeaders !== config.style?.groupHeaders;
    for (const win of this.windows.keys()) {
      this.refreshWindow(win, heightChanged);
      if (config.style?.expandGroups && !old?.style?.expandGroups) {
        this.expandGroups(win);
      }
    }
    this.refreshReaders(() => true);
  }

  teardown() {
    this.tornDown = true;
    clearInterval(this.dateTimer);
    for (const [browser, onLoad] of this.watchedBrowsers) {
      browser.removeEventListener("load", onLoad, { capture: true });
    }
    this.watchedBrowsers.clear();
    clearTimeout(this.pendingTimer);
    clearTimeout(this.previewTimer);
    if (this.started) {
      ExtensionSupport.unregisterWindowListener(this.extension.id);
      ExtensionSupport.unregisterWindowListener(`${this.extension.id}-reader`);
    }
    for (const [win, { monitor, onUnload }] of this.tabMonitors) {
      win.removeEventListener("unload", onUnload);
      win.document.getElementById("tabmail")?.unregisterTabMonitor(monitor);
    }
    this.tabMonitors.clear();
    for (const restore of [...this.windows.values(), ...this.readers.values()]) {
      try {
        restore();
      } catch (e) {
        log("restore failed", e);
      }
    }
    this.windows.clear();
    this.readers.clear();
    this.applySheet(null);
    this.listeners.clear();
    this.removeUpdateNotices();
  }

  // Update notice: the update waits for the next start, the bar says so.

  showUpdateNotice(version) {
    if (this.tornDown) {
      return;
    }
    const notice = loadAddonScript(this.extension, "experiments/qol/updatenotice.js").qolUpdateNotice;
    this.updateVersion = String(version);
    this.updateTexts = notice.texts(notice.pickLanguage(Services.locale.appLocaleAsBCP47), this.updateVersion);
    if (this.updateListening) {
      for (const win of Services.wm.getEnumerator("mail:3pane")) {
        this.appendUpdateNotice(win);
      }
      return;
    }
    this.updateListening = true;
    // Also runs for the main windows already open.
    ExtensionSupport.registerWindowListener(`${this.extension.id}-update`, {
      chromeURLs: [MESSENGER_URL],
      onLoadWindow: win => this.appendUpdateNotice(win),
    });
  }

  async appendUpdateNotice(win) {
    try {
      const box = win.specialTabs?.msgNotificationBar;
      if (!box || !this.updateTexts) {
        return;
      }
      const old = box.getNotificationWithValue(UPDATE_NOTICE);
      if (old) {
        box.removeNotification(old, true);
      }
      const { message, restart } = this.updateTexts;
      const notification = await box.appendNotification(UPDATE_NOTICE, { label: message, priority: box.PRIORITY_INFO_MEDIUM }, [
        {
          label: restart,
          // Asks about unsaved drafts like any quit; the bar stays if the restart is cancelled.
          callback: () => {
            MailUtils.restartApplication();
            return true;
          },
        },
      ]);
      notification.dataset.version = this.updateVersion;
    } catch (e) {
      log("update notice not shown", e);
    }
  }

  removeUpdateNotices() {
    if (!this.updateListening) {
      return;
    }
    this.updateListening = false;
    ExtensionSupport.unregisterWindowListener(`${this.extension.id}-update`);
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      try {
        const box = win.specialTabs?.msgNotificationBar;
        const notification = box?.getNotificationWithValue(UPDATE_NOTICE);
        if (notification) {
          box.removeNotification(notification, true);
        }
      } catch (e) {
        log("update notice not removed", e);
      }
    }
  }

  // Stylesheet

  applySheet(css) {
    const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
    if (this.sheetURI && sss.sheetRegistered(this.sheetURI, sss.AUTHOR_SHEET)) {
      sss.unregisterSheet(this.sheetURI, sss.AUTHOR_SHEET);
    }
    this.sheetURI = null;
    if (css === null) {
      return;
    }
    try {
      this.sheetURI = Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(css));
      sss.loadAndRegisterSheet(this.sheetURI, sss.AUTHOR_SHEET);
      this.features.warningBar = true;
    } catch (e) {
      log("stylesheet registration failed", e);
      this.features.warningBar = false;
    }
  }

  // Window and tab tracking

  watchMessengerWindow(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    const monitor = {
      monitorName: "officebird",
      onTabOpened: tab => this.watchTab(tab),
      onTabSwitched: tab => this.watchTab(tab),
      onTabTitleChanged() {},
      onTabClosing: tab => this.unwatchTab(tab),
      onTabPersist() {},
      onTabRestored() {},
    };
    tabmail.registerTabMonitor(monitor);
    const onUnload = () => this.tabMonitors.delete(win);
    this.tabMonitors.set(win, { monitor, onUnload });
    win.addEventListener("unload", onUnload, { once: true });
    for (const tab of tabmail.tabInfo) {
      this.watchTab(tab);
    }
  }

  watchTab(tab) {
    const mode = tab?.mode?.name;
    const browser = mode === "mail3PaneTab" || mode === "mailMessageTab" ? tab.chromeBrowser : null;
    if (!browser || this.tornDown) {
      return;
    }
    // On large profiles about:3pane can finish loading long after startup,
    // and it can be reloaded; check again whenever it loads.
    if (!this.watchedBrowsers.has(browser)) {
      const onLoad = () => this.watchTab(tab);
      browser.addEventListener("load", onLoad, { capture: true });
      this.watchedBrowsers.set(browser, onLoad);
    }
    const win = browser.contentWindow;
    if (win?.location.href === "about:message") {
      this.watchReader(win);
      return;
    }
    if (!win || this.windows.has(win) || win.location.href !== "about:3pane") {
      return;
    }
    // about3Pane.js resolves this once its DOMContentLoaded setup (thread
    // pane included) is done.
    const loaded = win.hasDOMContentLoaded?.promise ?? Promise.resolve();
    loaded.then(() => {
      if (!this.tornDown && !win.closed && !this.windows.has(win) && win.threadPane && win.threadTree) {
        this.attach(win);
      }
    });
  }

  unwatchTab(tab) {
    const browser = tab?.chromeBrowser;
    const onLoad = browser && this.watchedBrowsers.get(browser);
    if (onLoad) {
      browser.removeEventListener("load", onLoad, { capture: true });
      this.watchedBrowsers.delete(browser);
    }
  }

  attach(win) {
    const cardClass = win.customElements.get("thread-card");
    const proto = cardClass?.prototype;
    const threadPane = win.threadPane;
    if (typeof proto?.fillRow !== "function") {
      log("thread-card.fillRow not found; icons and previews disabled");
      this.features.cards = false;
      this.features.preview = false;
      return;
    }
    const restores = [];
    const state = this;

    const originalFill = proto.fillRow;
    proto.fillRow = function (...args) {
      const result = originalFill.apply(this, args);
      try {
        state.decorate(win, this);
      } catch (e) {
        log("decorate failed", e);
      }
      return result;
    };
    restores.push(() => {
      proto.fillRow = originalFill;
    });

    const rowClass = win.customElements.get("thread-row");
    const rowProto = rowClass?.prototype;
    if (typeof rowProto?.fillRow === "function") {
      const originalRowFill = rowProto.fillRow;
      rowProto.fillRow = function (...args) {
        const result = originalRowFill.apply(this, args);
        try {
          state.decorate(win, this);
        } catch (e) {
          log("decorate (table) failed", e);
        }
        return result;
      };
      restores.push(() => {
        rowProto.fillRow = originalRowFill;
      });
    } else {
      log("thread-row.fillRow not found; table view features disabled");
      this.features.table = false;
    }

    if (typeof threadPane?.densityChange === "function" && typeof threadPane.updateThreadItemSize === "function") {
      const originalDensity = threadPane.densityChange;
      threadPane.densityChange = async function (...args) {
        const result = await originalDensity.apply(this, args);
        state.adjustCardHeight(win, cardClass);
        state.adjustRowHeight(win, rowClass);
        return result;
      };
      restores.push(() => {
        threadPane.densityChange = originalDensity;
      });
    } else {
      log("threadPane.densityChange not found; preview lines disabled");
      this.features.preview = false;
    }

    // A rowCount of 2 makes Thunderbird draw its 2-row card (icons next to the subject),
    // so the card reads sender / subject / preview.
    const rowCount = Object.getOwnPropertyDescriptor(threadPane ?? {}, "rowCount");
    if (rowCount?.configurable && rowCount.get) {
      Object.defineProperty(threadPane, "rowCount", {
        configurable: true,
        enumerable: rowCount.enumerable,
        get() {
          return state.config?.preview.enabled && state.features.preview ? 2 : rowCount.get.call(this);
        },
      });
      restores.push(() => Object.defineProperty(threadPane, "rowCount", rowCount));
    }

    this.installGroupRows(win, restores);
    this.installGroupExpansion(win, restores);

    const messageBrowser = win.messageBrowser;
    if (messageBrowser) {
      const unwatch = this.watchMessageBrowser(messageBrowser);
      restores.push(unwatch);
    }

    // Capture phase: the read toggle must act before the tree selects the row.
    const onToggle = event => {
      const button = event.target.closest?.(".qol-read-toggle");
      if (!button) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "click") {
        this.toggleRead(button.closest("tr"));
      }
    };
    for (const type of ["mousedown", "click", "dblclick"]) {
      win.threadTree?.addEventListener(type, onToggle, true);
      restores.push(() => win.threadTree?.removeEventListener(type, onToggle, true));
    }

    const onUnload = () => this.windows.delete(win);
    win.addEventListener("unload", onUnload, { once: true });
    restores.push(() => win.removeEventListener("unload", onUnload));

    this.windows.set(win, () => {
      for (const restore of restores.reverse()) {
        restore();
      }
      for (const el of win.document.querySelectorAll(".qol-avatar, .qol-preview, .qol-read-toggle, .qol-delete")) {
        el.remove();
      }
      for (const card of win.document.querySelectorAll(".card-container")) {
        this.cardMenu?.place(card, false);
      }
      for (const card of win.document.querySelectorAll("[data-qol-id]")) {
        delete card.dataset.qolId;
      }
      for (const row of win.document.querySelectorAll(".qol-two-line")) {
        row.classList.remove("qol-two-line");
      }
      win.threadTree?.style.removeProperty("--qol-subject-indent");
      threadPane?.updateThreadItemSize?.();
    });
    this.refreshWindow(win, true);
  }

  // Reading pane avatar

  watchMessageBrowser(browser) {
    if (!browser) {
      return () => {};
    }
    const onLoad = () => this.watchReader(browser.contentWindow);
    browser.addEventListener("load", onLoad, { capture: true });
    onLoad();
    return () => browser.removeEventListener("load", onLoad, { capture: true });
  }

  watchReader(win) {
    if (!win || win.closed || this.tornDown || this.readers.has(win) || win.location.href !== "about:message") {
      return;
    }
    if (win.customElements.get("header-recipient")) {
      this.attachReader(win);
    } else {
      win.customElements.whenDefined("header-recipient").then(() => this.attachReader(win));
    }
  }

  attachReader(win) {
    if (this.tornDown || win.closed || this.readers.has(win)) {
      return;
    }
    const proto = win.customElements.get("header-recipient")?.prototype;
    if (typeof proto?._updateAvatar !== "function") {
      log("header-recipient._updateAvatar not found; reading pane avatars disabled");
      this.features.readerAvatar = false;
      return;
    }
    const state = this;
    const original = proto._updateAvatar;
    proto._updateAvatar = function (...args) {
      const result = original.apply(this, args);
      try {
        state.decorateReader(win, this);
      } catch (e) {
        log("reading pane avatar failed", e);
      }
      return result;
    };
    const onUnload = () => this.readers.delete(win);
    win.addEventListener("unload", onUnload, { once: true });
    this.readers.set(win, () => {
      win.removeEventListener("unload", onUnload);
      proto._updateAvatar = original;
      for (const recipient of this.readerSenders(win)) {
        delete recipient.dataset.qolId;
        recipient.avatar?.classList.remove("qol-reader-avatar");
        recipient.avatar?.removeAttribute("data-unverified");
        original.call(recipient);
      }
    });
    for (const recipient of this.readerSenders(win)) {
      recipient._updateAvatar();
    }
  }

  readerSenders(win) {
    return [...win.document.querySelectorAll('li[is="header-recipient"][id="fromRecipient0"]')];
  }

  // Runs after Thunderbird drew the avatar; an address-book photo (has-avatar) stays.
  decorateReader(win, recipient) {
    const avatar = recipient.avatar;
    const hdr = win.gMessage;
    if (recipient.id !== "fromRecipient0" || !avatar) {
      return;
    }
    avatar.classList.remove("qol-reader-avatar");
    avatar.removeAttribute("data-unverified");
    delete recipient.dataset.qolId;
    if (!this.config?.iconsEnabled || !hdr?.folder || avatar.classList.contains("has-avatar")) {
      return;
    }
    const id = cardId(hdr);
    recipient.dataset.qolId = id;
    let result = this.icons.get(id);
    if (result?.pending && hdr.folder.hasMsgOffline(hdr.messageKey)) {
      this.icons.delete(id);
      result = undefined;
    }
    if (!result) {
      // Keep Thunderbird's letter until the icon arrives (redecorate).
      this.queueCard(hdr, id);
      return;
    }
    const el = win.document.createElement(result.dataUrl ? "img" : "span");
    if (result.dataUrl) {
      el.setAttribute("src", result.dataUrl);
      el.setAttribute("alt", "");
    } else {
      el.textContent = result.initials ?? "";
      el.style.backgroundColor = result.color ?? "rgba(128, 128, 128, 0.25)";
      el.setAttribute("aria-hidden", "true");
    }
    avatar.replaceChildren(el);
    avatar.classList.add("qol-reader-avatar");
    avatar.toggleAttribute("data-unverified", Boolean(result.unverified));
  }

  refreshReaders(wanted) {
    for (const win of this.readers.keys()) {
      for (const recipient of this.readerSenders(win)) {
        if (wanted(recipient.dataset.qolId)) {
          try {
            recipient._updateAvatar();
          } catch (e) {
            log("reading pane avatar refresh failed", e);
          }
        }
      }
    }
  }

  // The list assumes every row is ROW_HEIGHT tall; with compact group headers its scroll
  // position, spacers and scroll-to-row are converted to real heights (grouprows.js).
  installGroupRows(win, restores) {
    const tree = win.threadTree;
    const spacers = [tree?.table?.spacerTop, tree?.table?.spacerBottom];
    const find = name => {
      for (let o = tree; o; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, name);
        if (d) {
          return d;
        }
      }
      return null;
    };
    const scrollTop = tree && find("scrollTop");
    const ownNames = ["scrollTop", "scrollTo", "scrollToIndex", "invalidate", "reset"];
    if (
      !this.groupRows ||
      !scrollTop?.get ||
      !scrollTop.set ||
      spacers.some(sp => typeof sp?.setHeight !== "function") ||
      ["scrollTo", "scrollToIndex", "invalidate", "reset"].some(n => typeof tree[n] !== "function") ||
      ownNames.some(n => Object.hasOwn(tree, n)) ||
      spacers.some(sp => Object.hasOwn(sp, "setHeight"))
    ) {
      log("message list internals changed; compact group headers disabled");
      this.features.groupHeaders = false;
      return;
    }
    const state = this;
    const original = {
      scrollTo: tree.scrollTo,
      scrollToIndex: tree.scrollToIndex,
      invalidate: tree.invalidate,
      reset: tree.reset,
      top: spacers[0].setHeight,
      bottom: spacers[1].setHeight,
    };
    let cache = null;

    const current = () => {
      if (
        !state.config?.style?.groupHeaders ||
        !win.gViewWrapper?.showGroupedBySort ||
        tree._rowElementName !== "thread-card" ||
        !win.gDBView
      ) {
        return null;
      }
      const count = win.gDBView.rowCount;
      const rowHeight = tree._rowElementClass.ROW_HEIGHT;
      const headerHeight = Math.max(GROUP_HEADER_MIN_PX, Math.round(state.fontSize(win) * GROUP_HEADER_FACTOR));
      if (cache?.count !== count || cache.rowHeight !== rowHeight || cache.headerHeight !== headerHeight) {
        const headers = [];
        for (let i = 0; i < count; i++) {
          if (win.gViewWrapper.isGroupedByHeaderAtIndex(i)) {
            headers.push(i);
          }
        }
        tree.style.setProperty("--qol-group-header-height", `${headerHeight}px`);
        cache = { count, rowHeight, headerHeight, layout: state.groupRows.layout(headers, rowHeight, headerHeight) };
      }
      return cache.layout;
    };

    Object.defineProperty(tree, "scrollTop", {
      configurable: true,
      get() {
        const y = scrollTop.get.call(this);
        return current()?.toVirtual(y) ?? y;
      },
      set(v) {
        scrollTop.set.call(this, current()?.toReal(v) ?? v);
      },
    });
    tree.scrollTo = function (a, b) {
      const layout = current();
      if (layout && a && typeof a === "object" && "top" in a) {
        return original.scrollTo.call(this, { ...a, top: layout.toReal(a.top) });
      }
      if (layout && typeof b === "number") {
        return original.scrollTo.call(this, a, layout.toReal(b));
      }
      return original.scrollTo.call(this, a, b);
    };
    tree.scrollToIndex = function (index, instant = false) {
      const layout = current();
      if (!layout || index < 0 || index >= win.gDBView.rowCount) {
        return original.scrollToIndex.call(this, index, instant);
      }
      const { top, bottom } = layout.rowSpan(index);
      const y = scrollTop.get.call(this);
      const height = this.clientHeight - (this.querySelector("thead")?.getBoundingClientRect().height ?? 0);
      let target = y;
      if (top < y) {
        target = top;
      } else if (bottom > y + height) {
        target = bottom - height;
      }
      return original.scrollTo.call(this, { top: target, behavior: instant ? "instant" : "auto" });
    };
    // Rows can move between groups without the row count changing.
    tree.invalidate = function (...args) {
      cache = null;
      return original.invalidate.apply(this, args);
    };
    tree.reset = function (...args) {
      cache = null;
      return original.reset.apply(this, args);
    };
    spacers[0].setHeight = function (height) {
      return original.top.call(this, current()?.topSpacer(height) ?? height);
    };
    spacers[1].setHeight = function (height) {
      return original.bottom.call(this, current()?.bottomSpacer(height, win.gDBView?.rowCount ?? 0) ?? height);
    };

    restores.push(() => {
      for (const name of ownNames) {
        delete tree[name];
      }
      for (const sp of spacers) {
        delete sp.setHeight;
      }
      tree.style.removeProperty("--qol-group-header-height");
      tree.reset();
    });
  }

  // Thunderbird remembers only "all expanded" or "all collapsed" per folder, so date
  // groups open collapsed in some folders. With expandGroups every group opens
  // expanded except the ones collapsed by hand, which are kept per folder.
  installGroupExpansion(win, restores) {
    const threadPane = win.threadPane;
    const tree = win.threadTree;
    if (typeof threadPane?.restoreThreadState !== "function" || typeof tree?.collapseRowAtIndex !== "function") {
      log("thread state internals changed; expanded date groups disabled");
      this.features.expandGroups = false;
      return;
    }
    const state = this;
    const original = threadPane.restoreThreadState;
    threadPane.restoreThreadState = function (setState = true, ...rest) {
      const result = original.call(this, setState, ...rest);
      if (setState) {
        state.expandGroups(win);
      }
      return result;
    };
    const onToggle = event => this.rememberGroup(win, event.detail, event.type === "collapsed");
    tree.addEventListener("expanded", onToggle);
    tree.addEventListener("collapsed", onToggle);
    restores.push(() => {
      threadPane.restoreThreadState = original;
      tree.removeEventListener("expanded", onToggle);
      tree.removeEventListener("collapsed", onToggle);
    });
  }

  groupFolder(win) {
    const wrapper = win.gViewWrapper;
    // displayedFolder is also set for virtual folders such as the unified ones. Search
    // results have no folder to keep their groups in.
    if (!this.config?.style?.expandGroups || !wrapper?.showGroupedBySort || !win.gDBView || isSearchView(win)) {
      return null;
    }
    return wrapper.displayedFolder ?? null;
  }

  collapsedGroups(folder) {
    try {
      const list = JSON.parse(folder.msgDatabase.dBFolderInfo.getCharProperty(COLLAPSED_GROUPS_PROPERTY) || "[]");
      return new Set(Array.isArray(list) ? list.filter(v => typeof v === "string") : []);
    } catch (e) {
      return new Set();
    }
  }

  expandGroups(win) {
    const folder = this.groupFolder(win);
    if (!folder || this.expandingGroups) {
      return;
    }
    const view = win.gDBView;
    const collapsed = this.collapsedGroups(folder);
    this.expandingGroups = true;
    win.threadPane.saveSelection?.();
    try {
      if (!(view.viewFlags & Ci.nsMsgViewFlagsType.kExpandAll)) {
        view.doCommand(Ci.nsMsgViewCommandType.expandAll);
        win.gViewWrapper._threadExpandAll = true;
      }
      // Bottom up, so collapsing a group doesn't move the ones still to check.
      for (let i = view.rowCount - 1; i >= 0; i--) {
        const header = win.gViewWrapper.isGroupedByHeaderAtIndex(i) && view.isContainerOpen(i);
        if (header && collapsed.has(view.cellTextForColumn(i, "subjectCol"))) {
          win.threadTree.collapseRowAtIndex(i);
        }
      }
    } catch (e) {
      log("expanding date groups failed", e);
    } finally {
      win.threadPane.restoreSelection?.();
      this.expandingGroups = false;
    }
  }

  rememberGroup(win, index, collapsed) {
    const folder = this.groupFolder(win);
    if (!folder || this.expandingGroups || !win.gViewWrapper.isGroupedByHeaderAtIndex(index)) {
      return;
    }
    const groups = this.collapsedGroups(folder);
    const name = win.gDBView.cellTextForColumn(index, "subjectCol");
    if (collapsed) {
      groups.add(name);
    } else {
      groups.delete(name);
    }
    try {
      folder.msgDatabase.dBFolderInfo.setCharProperty(COLLAPSED_GROUPS_PROPERTY, groups.size ? JSON.stringify([...groups]) : "");
    } catch (e) {
      log("could not save collapsed groups", e);
    }
  }

  // Thunderbird's own settings, changed where Thunderbird keeps them.

  getThunderbirdSettings() {
    return {
      // View > Message List > Cards / Table (0 = cards, 1 = table).
      listView: Services.prefs.getIntPref(LIST_VIEW_PREF, 0) === 1 ? "table" : "cards",
      // Settings > Reading & Display > Automatically mark messages as read.
      markReadOnView: Services.prefs.getBoolPref(MARK_READ_PREF, true),
      unifiedFolders: this.folderModes()[0] === "smart",
      // Settings > General > Global search and indexer.
      glodaIndex: Services.prefs.getBoolPref(GLODA_INDEX_PREF, true),
    };
  }

  setThunderbirdSetting(name, value) {
    if (name === "listView") {
      Services.prefs.setIntPref(LIST_VIEW_PREF, value === "table" ? 1 : 0);
    } else if (name === "markReadOnView") {
      Services.prefs.setBoolPref(MARK_READ_PREF, Boolean(value));
    } else if (name === "unifiedFolders") {
      this.setUnifiedFolders(Boolean(value));
    } else if (name === "glodaIndex") {
      Services.prefs.setBoolPref(GLODA_INDEX_PREF, Boolean(value));
    }
  }

  // Folder pane modes as in its ⋯ menu, top to bottom; "smart" is Unified Folders.
  folderModes() {
    const value = XULStoreUtils.getValue("messenger", "folderTree", "mode");
    return value ? value.split(",") : ["all"];
  }

  setUnifiedFolders(on) {
    const modes = this.folderModes().filter(mode => mode !== "smart");
    if (on) {
      modes.unshift("smart");
    }
    // Each tab has its own folder pane; the setter also stores the modes for new ones.
    let applied = false;
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      for (const tab of win.gTabmail?.tabInfo ?? []) {
        const folderPane = tab.mode?.name === "mail3PaneTab" ? tab.chromeBrowser?.contentWindow?.folderPane : null;
        if (folderPane) {
          folderPane.activeModes = modes;
          applied = true;
        }
      }
    }
    if (!applied) {
      XULStoreUtils.setValue("messenger", "folderTree", "mode", (modes.length ? modes : ["all"]).join(","));
    }
  }

  applyViewToAllFolders(mode) {
    const F = Ci.nsMsgViewFlagsType;
    const target = mode === "grouped" ? F.kThreadedDisplay | F.kGroupBySort : F.kThreadedDisplay;
    const flagsFor = old => (old & ~(F.kThreadedDisplay | F.kGroupBySort)) | target;
    const displayed = new Set();
    for (const win of this.windows.keys()) {
      if (win.gViewWrapper?.displayedFolder) {
        displayed.add(win.gViewWrapper.displayedFolder.URI);
      }
    }
    let changed = 0;
    let failed = 0;
    for (const folder of MailServices.accounts.allFolders) {
      if (folder.isServer) {
        continue;
      }
      // Open folders are switched through their view below, which saves
      // itself; writing their database directly gets overwritten.
      if (displayed.has(folder.URI)) {
        changed++;
        continue;
      }
      try {
        const info = folder.msgDatabase.dBFolderInfo;
        info.viewFlags = flagsFor(info.viewFlags);
        if (mode === "grouped") {
          info.sortType = Ci.nsMsgViewSortType.byDate;
          info.sortOrder = Ci.nsMsgViewSortOrder.descending;
        }
        // Like Thunderbird: let go of databases nobody is looking at.
        folder.msgDatabase = null;
        changed++;
      } catch (e) {
        failed++;
        log(`could not set the view of ${folder.URI}`, e);
      }
    }
    Services.prefs.setIntPref(DEFAULT_VIEW_FLAGS_PREF, flagsFor(Services.prefs.getIntPref(DEFAULT_VIEW_FLAGS_PREF, 1)));
    if (mode === "grouped") {
      Services.prefs.setIntPref(DEFAULT_SORT_TYPE_PREF, Ci.nsMsgViewSortType.byDate);
      Services.prefs.setIntPref(DEFAULT_SORT_ORDER_PREF, Ci.nsMsgViewSortOrder.descending);
    }
    for (const win of this.windows.keys()) {
      const wrapper = win.gViewWrapper;
      if (!wrapper?.displayedFolder) {
        continue;
      }
      try {
        if (mode === "grouped") {
          const byDate =
            wrapper.primarySortType === Ci.nsMsgViewSortType.byDate &&
            wrapper.primarySortOrder === Ci.nsMsgViewSortOrder.descending;
          if (wrapper.showGroupedBySort && byDate) {
            continue;
          }
          // Sorting a grouped view makes Thunderbird save an empty sort type,
          // so leave the groups first.
          if (wrapper.showGroupedBySort) {
            wrapper.showThreaded = true;
          }
          wrapper.sort(Ci.nsMsgViewSortType.byDate, Ci.nsMsgViewSortOrder.descending);
          wrapper.showGroupedBySort = true;
        } else {
          wrapper.showThreaded = true;
        }
      } catch (e) {
        log("could not switch an open folder", e);
      }
    }
    return { changed, failed };
  }

  refreshWindow(win, heightChanged) {
    if (heightChanged && typeof win.threadPane?.updateThreadItemSize === "function") {
      win.threadPane.updateThreadItemSize();
    } else {
      win.threadTree?.invalidate();
    }
  }

  fontSize(win) {
    return win.UIFontSize?.size || parseFloat(win.getComputedStyle(win.document.documentElement).fontSize) || 13;
  }

  adjustCardHeight(win, cardClass) {
    // Thunderbird leaves 4px between cards; the Outlook style makes it adjustable.
    if (this.config?.style?.outlook) {
      cardClass.ROW_HEIGHT += (this.config.style.cardGap ?? DEFAULT_CARD_GAP) - DEFAULT_CARD_GAP;
    }
    if (!this.config?.preview.enabled || !this.features.preview) {
      return;
    }
    cardClass.ROW_HEIGHT += Math.ceil(this.config.preview.lines * PREVIEW_LINE_FACTOR * this.fontSize(win)) + PREVIEW_GAP_PX;
  }

  adjustRowHeight(win, rowClass) {
    if (!rowClass || !this.config?.preview.enabled || !this.features.preview || !this.features.table) {
      return;
    }
    const lines = this.config.preview.tableLines ?? 1;
    rowClass.ROW_HEIGHT += Math.ceil(lines * PREVIEW_LINE_FACTOR * this.fontSize(win)) + TABLE_PREVIEW_GAP_PX;
  }

  refreshDates() {
    const style = this.config?.table?.dateStyle;
    if (style !== "smart" && style !== "relative") {
      return;
    }
    for (const win of this.windows.keys()) {
      if (win.document.querySelector("tr[is=thread-row]")) {
        win.threadTree?.invalidate();
      }
    }
  }

  // Card decoration

  decorate(win, card) {
    const index = card._index;
    let hdr = null;
    if (!win.gViewWrapper?.isGroupedByHeaderAtIndex?.(index)) {
      try {
        hdr = card.view?.getMsgHdrAt(index);
      } catch (e) {
        hdr = null;
      }
    }
    const isRow = card.classList.contains("table-layout");
    if (!isRow) {
      this.cardMenu?.place(card, Boolean(this.config?.style?.outlook));
      if (hdr) {
        this.cardMenu?.addDelete(card);
      } else {
        // Cards are reused; group headers get no delete button.
        card.querySelector(".qol-delete")?.remove();
      }
    }
    if (!hdr || !this.config) {
      card.querySelector(".qol-avatar")?.remove();
      card.querySelector(".qol-preview")?.remove();
      card.querySelector(".qol-folder-label")?.remove();
      card.classList.remove("qol-two-line");
      delete card.dataset.qolId;
      return;
    }
    const id = cardId(hdr);
    card.dataset.qolId = id;

    const viewEnabled = isRow ? this.features.table : this.features.cards;
    if (this.config.iconsEnabled && viewEnabled) {
      this.renderAvatar(card, hdr, id);
    } else {
      card.querySelector(".qol-avatar")?.remove();
    }
    const showPreview = this.config.preview.enabled && this.features.preview && viewEnabled;
    if (showPreview) {
      this.renderPreview(card, hdr, id);
    } else {
      card.querySelector(".qol-preview")?.remove();
    }
    if (isRow) {
      card.classList.toggle("qol-two-line", showPreview);
      this.renderDate(card, hdr);
    } else {
      this.renderReadToggle(card, hdr);
      this.renderFolderLabel(win, card, hdr);
    }
  }

  renderFolderLabel(win, card, hdr) {
    const text = this.folderLabel(win, hdr.folder);
    let label = card.querySelector(".qol-folder-label");
    const container = card.querySelector(".thread-card-subject-container");
    if (!text || !container) {
      label?.remove();
      return;
    }
    if (!label) {
      label = card.ownerDocument.createElement("span");
      label.className = "qol-folder-label";
      container.append(label);
    }
    label.textContent = text;
  }

  // Only search results from several folders name the folder; the account is added when
  // another folder of the results has the same name.
  folderLabel(win, folder) {
    const folders = isSearchView(win) ? win.gViewWrapper.searchFolders : null;
    if (folders) {
      this.noteSearchFolders(win, folders.length);
    }
    if (!folders || folders.length < 2) {
      return null;
    }
    const name = folder.localizedName;
    const shared = folders.some(other => other.URI !== folder.URI && other.localizedName === name);
    return shared ? `${name} · ${folder.server.prettyName}` : name;
  }

  // Hits added later can bring more folders, which changes the labels of the cards
  // already shown; the list redraws only the new rows by itself.
  noteSearchFolders(win, count) {
    const last = this.searchFolderCounts.get(win);
    this.searchFolderCounts.set(win, count);
    if (last !== undefined && last !== count) {
      win.setTimeout(() => win.threadTree?.invalidate(), 0);
    }
  }

  renderReadToggle(card, hdr) {
    const container = card.querySelector(".card-container");
    let button = container?.querySelector(":scope > .qol-read-toggle");
    if (!this.config.style?.outlook || !container) {
      button?.remove();
      return;
    }
    if (!button) {
      button = card.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "qol-read-toggle";
      button.tabIndex = -1;
      container.prepend(button);
    }
    const german = Services.locale.appLocaleAsBCP47.startsWith("de");
    const label = hdr.isRead
      ? german ? "Als ungelesen markieren" : "Mark as unread"
      : german ? "Als gelesen markieren" : "Mark as read";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  toggleRead(card) {
    let hdr = null;
    try {
      hdr = card?.view?.getMsgHdrAt(card._index);
    } catch (e) {
      return;
    }
    if (hdr) {
      // markMessagesRead also syncs the flag to the IMAP server.
      hdr.folder.markMessagesRead([hdr], !hdr.isRead);
    }
  }

  // Every row has a cell per column, hidden ones included; use the visible
  // one that shows who the mail is from.
  senderCell(row) {
    const win = row.ownerDocument.defaultView;
    const column = win.threadPane?.columns?.find(c => !c.hidden && (c.id === "correspondentCol" || c.id === "senderCol"));
    return column ? row.querySelector(`.${column.id.toLowerCase()}-column`) : null;
  }

  alignTablePreview(row, preview) {
    const win = row.ownerDocument.defaultView;
    const tree = win.threadTree;
    if (!tree || tree.style.getPropertyValue("--qol-subject-indent")) {
      return;
    }
    const line = preview.parentElement;
    const icon = line.querySelector(":scope > img");
    const text = line.querySelector(":scope > span");
    const indent = icon && text ? text.getBoundingClientRect().left - icon.getBoundingClientRect().left : 0;
    if (indent > 0) {
      tree.style.setProperty("--qol-subject-indent", `${Math.round(indent)}px`);
    }
  }

  renderDate(row, hdr) {
    const style = this.config.table?.dateStyle;
    if (!this.dateFormat || !style || style === "thunderbird") {
      return;
    }
    const locale = Services.locale.regionalPrefsLocales[0];
    const now = new Date();
    // To milliseconds: hdr.date is in microseconds, dateReceived in seconds.
    const cells = [
      [row.querySelector(".datecol-column"), hdr.date / 1000],
      [row.querySelector(".receivedcol-column"), hdr.getUint32Property("dateReceived") * 1000],
    ];
    for (const [cell, ms] of cells) {
      if (!cell || !ms) {
        continue;
      }
      const date = new Date(ms);
      const text = this.dateFormat.format(date, style, now, locale);
      if (text) {
        cell.textContent = text;
        // The tooltip comes from Fluent (".title = { $title }"), so pass the
        // full date as its argument rather than setting title directly.
        const l10nId = cell.getAttribute("data-l10n-id");
        if (l10nId) {
          row.ownerDocument.l10n.setAttributes(cell, l10nId, { title: this.dateFormat.full(date, locale) });
        }
      }
    }
  }

  renderAvatar(card, hdr, id) {
    const container = card.classList.contains("table-layout")
      ? this.senderCell(card)
      : card.querySelector(".card-container");
    if (!container) {
      return;
    }
    let result = this.icons.get(id);
    if (result?.pending && hdr.folder.hasMsgOffline(hdr.messageKey)) {
      // The message has been downloaded since; check its headers now.
      this.icons.delete(id);
      result = undefined;
    }
    const tag = result?.dataUrl ? "img" : "span";
    let el = container.querySelector(":scope > .qol-avatar");
    if (!el || el.localName !== tag) {
      const fresh = card.ownerDocument.createElement(tag);
      fresh.className = "qol-avatar";
      if (el) {
        el.replaceWith(fresh);
      } else {
        container.prepend(fresh);
      }
      el = fresh;
    }
    if (result?.dataUrl) {
      if (el.getAttribute("src") !== result.dataUrl) {
        el.setAttribute("src", result.dataUrl);
      }
      el.setAttribute("alt", "");
    } else {
      el.textContent = result?.initials ?? "";
      el.style.backgroundColor = result?.color ?? "rgba(128, 128, 128, 0.25)";
    }
    el.toggleAttribute("data-unverified", Boolean(result?.unverified));
    if (!result) {
      this.queueCard(hdr, id);
    }
  }

  // Runs inside fillRow, so it only notes the card; the disk read for the
  // headers happens once per batch in flushCards().
  queueCard(hdr, id) {
    if (this.requested.has(id) || this.pending.has(id)) {
      return;
    }
    this.pending.set(id, hdr);
    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => this.flushCards(), CARD_BATCH_MS);
    }
  }

  describeCard(id, hdr) {
    let authResults = this.auth.get(id);
    if (authResults === undefined) {
      try {
        authResults = readAuthResults(hdr);
      } catch (e) {
        authResults = "";
      }
      if (authResults !== null) {
        this.auth.set(id, authResults);
      }
    }
    const sender = MailServices.headerParser.parseEncodedHeaderW(hdr.author)[0];
    return {
      id,
      email: (sender?.email || "").toLowerCase(),
      displayName: sender?.name || "",
      authResults,
      // Trust is per account: only this account's provider vouches for it.
      serverKey: hdr.folder.server.key,
      generation: this.generation,
    };
  }

  flushCards() {
    this.pendingTimer = null;
    const pending = [...this.pending];
    this.pending.clear();
    if (!pending.length || !this.listeners.size) {
      return;
    }
    const cards = [];
    for (const [id, hdr] of pending) {
      try {
        cards.push(this.describeCard(id, hdr));
      } catch (e) {
        // The folder was closed or the message deleted since it was drawn.
        continue;
      }
      this.requested.add(id);
    }
    if (!cards.length) {
      return;
    }
    for (const fire of this.listeners) {
      fire.async(cards);
    }
  }

  sanitizeResult(result) {
    let dataUrl = typeof result.dataUrl === "string" && ICON_DATA_URL.test(result.dataUrl) ? result.dataUrl : null;
    if (dataUrl) {
      // Every batch arrives as a fresh copy; keep one string per icon.
      if (!this.dataUrls.has(dataUrl)) {
        if (this.dataUrls.size >= MAX_ENTRIES) {
          this.dataUrls.clear();
        }
        this.dataUrls.set(dataUrl, dataUrl);
      }
      dataUrl = this.dataUrls.get(dataUrl);
    }
    return {
      dataUrl,
      unverified: result.unverified === true,
      pending: result.pending === true,
      initials: typeof result.initials === "string" ? Array.from(result.initials).slice(0, 4).join("") : "",
      color: typeof result.color === "string" ? result.color.slice(0, 64) : null,
    };
  }

  setIcons(map) {
    const ids = new Set();
    for (const [id, result] of Object.entries(map || {})) {
      if (!result || typeof result !== "object") {
        continue;
      }
      if (result.generation !== this.generation) {
        continue;
      }
      this.icons.set(id, this.sanitizeResult(result));
      this.requested.delete(id);
      ids.add(id);
    }
    this.redecorate(ids);
  }

  clearIcons() {
    this.generation++;
    this.icons.clear();
    this.dataUrls.clear();
    this.requested.clear();
    for (const win of this.windows.keys()) {
      win.threadTree?.invalidate();
    }
    this.refreshReaders(() => true);
  }

  redecorate(ids) {
    this.refreshReaders(id => ids.has(id));
    for (const win of this.windows.keys()) {
      for (const card of win.document.querySelectorAll("[data-qol-id]")) {
        if (ids.has(card.dataset.qolId)) {
          try {
            this.decorate(win, card);
          } catch (e) {
            log("redecorate failed", e);
          }
        }
      }
    }
  }

  // Provider detection

  listServers() {
    return MailServices.accounts.accounts
      .map(account => account.incomingServer)
      .filter(Boolean)
      .map(server => ({ key: server.key, name: server.prettyName, type: server.type }));
  }

  sampleAuthResults(perFolder, serverKey) {
    const folders = new Map();
    for (const server of MailServices.accounts.allServers) {
      const inbox = server.rootFolder?.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
      if (inbox) {
        folders.set(inbox.URI, inbox);
      }
    }
    for (const win of this.windows.keys()) {
      if (win.gFolder) {
        folders.set(win.gFolder.URI, win.gFolder);
      }
    }
    const samples = {};
    for (const folder of folders.values()) {
      const key = folder.server.key;
      if (serverKey && key !== serverKey) {
        continue;
      }
      const list = (samples[key] ??= []);
      let taken = 0;
      let scanned = 0;
      try {
        for (const hdr of folder.msgDatabase.reverseEnumerateMessages()) {
          if (taken >= perFolder || scanned >= MAX_SCAN_PER_FOLDER) {
            break;
          }
          scanned++;
          const value = readAuthResults(hdr);
          if (value) {
            list.push(value);
            taken++;
          }
        }
      } catch (e) {
        log("sampling failed for", folder.URI, e);
      }
    }
    return samples;
  }

  // Preview lines

  renderPreview(card, hdr, id) {
    let el = card.querySelector(".qol-preview");
    if (!el) {
      // Cards: grid area "qolpreview" in styles.mjs. Table rows: inside the subject line,
      // so the preview follows the thread indentation.
      const row = card.querySelector(".thread-card-dynamic-row, .subjectcol-column .subject-line");
      if (!row) {
        return;
      }
      el = card.ownerDocument.createElement("div");
      el.className = "qol-preview";
      row.append(el);
    }
    const text = this.previewClean(hdr.getStringProperty("preview") || this.previewText.get(id));
    el.textContent = text;
    if (card.classList.contains("table-layout")) {
      this.alignTablePreview(card, el);
    }
    if (!text) {
      this.queuePreview(hdr, id);
    }
  }

  queuePreview(hdr, id) {
    // A server fetch can fail (no connection yet, server busy); try again later.
    const tries = this.previewTries.get(id) || { count: 0, at: 0 };
    if (this.previewText.has(id) || tries.count >= PREVIEW_MAX_TRIES || Date.now() - tries.at < PREVIEW_RETRY_MS) {
      return;
    }
    this.previewTries.set(id, { count: tries.count + 1, at: Date.now() });
    const folderURI = hdr.folder.URI;
    if (!this.previewQueue.has(folderURI)) {
      this.previewQueue.set(folderURI, { folder: hdr.folder, keys: [], ids: new Set() });
    }
    const entry = this.previewQueue.get(folderURI);
    entry.keys.push(hdr.messageKey);
    entry.ids.add(id);
    if (!this.previewTimer) {
      this.previewTimer = setTimeout(() => this.flushPreviews(), PREVIEW_BATCH_MS);
    }
  }

  flushPreviews() {
    this.previewTimer = null;
    const batches = [...this.previewQueue.values()];
    this.previewQueue.clear();
    for (const { folder, keys, ids } of batches) {
      // Thunderbird's own extraction first. For IMAP it may also ask the
      // server for messages without a local copy and finish later.
      const finish = () => {
        this.redecorate(ids);
        this.parseMissingPreviews(folder, keys, ids);
      };
      let isAsync = false;
      try {
        isAsync = folder.fetchMsgPreviewText(keys, {
          OnStartRunningUrl() {},
          OnStopRunningUrl: finish,
        });
      } catch (e) {
        // One unreadable message fails the whole batch; retry one by one.
        for (const key of keys) {
          try {
            folder.fetchMsgPreviewText([key], null);
          } catch (inner) {
            // Left for the full parser below.
          }
        }
      }
      if (isAsync) {
        // Locally stored messages are already done; show them now.
        this.redecorate(ids);
      } else {
        finish();
      }
    }
  }

  // Thunderbird's quick extraction reads only the start of the body, so newsletters with
  // large style blocks come back empty; those go through the full MIME parser.
  parseMissingPreviews(folder, keys, ids) {
    for (const key of keys) {
      let hdr;
      try {
        hdr = folder.GetMessageHeader(key);
      } catch (e) {
        continue;
      }
      const id = cardId(hdr);
      if (
        !ids.has(id) ||
        hdr.getStringProperty("preview") ||
        this.previewText.has(id) ||
        !folder.hasMsgOffline(key)
      ) {
        continue;
      }
      if (hdr.messageSize > MAX_PARSE_BYTES) {
        let text = "";
        try {
          text = this.pickBody ? readStartPreview(hdr, this.pickBody) : "";
        } catch (e) {
          log("preview from message start failed", e);
        }
        this.previewText.set(id, this.previewClean(text).slice(0, PREVIEW_MAX_CHARS));
        this.redecorate(new Set([id]));
        continue;
      }
      this.parseQueue.push({ hdr, id });
    }
    this.pumpParseQueue();
  }

  pumpParseQueue() {
    while (this.parsing < MAX_PARALLEL_PARSES && this.parseQueue.length) {
      const { hdr, id } = this.parseQueue.shift();
      this.parsing++;
      const done = text => {
        this.parsing--;
        this.previewText.set(id, this.previewClean(text).slice(0, PREVIEW_MAX_CHARS));
        this.redecorate(new Set([id]));
        this.pumpParseQueue();
      };
      try {
        MsgHdrToMimeMessage(
          hdr,
          null,
          (msgHdr, mime) => {
            let text = "";
            try {
              text = mime ? mime.coerceBodyToPlaintext(msgHdr.folder) : "";
            } catch (e) {
              text = "";
            }
            done(text);
          },
          false,
          { saneBodySize: false, partsOnDemand: true, examineEncryptedParts: false }
        );
      } catch (e) {
        done("");
      }
    }
  }
}

var qol = class extends ExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (!isAppShutdown) {
      this.state?.teardown();
    }
  }

  getAPI(context) {
    if (!this.state) {
      this.state = new QolState(this.extension);
    }
    const state = this.state;
    return {
      qol: {
        init: async (config, css) => state.init(config, css),
        updateConfig: async (config, css) => state.updateConfig(config, css),
        setIcons: async map => state.setIcons(map),
        clearIcons: async () => state.clearIcons(),
        getFeatures: async () => ({ ...state.features }),
        getThunderbirdSettings: async () => state.getThunderbirdSettings(),
        setThunderbirdSetting: async (name, value) => state.setThunderbirdSetting(name, value),
        applyViewToAllFolders: async mode => state.applyViewToAllFolders(mode === "threaded" ? "threaded" : "grouped"),
        listServers: async () => state.listServers(),
        sampleAuthResults: async (perFolder, serverKey) => state.sampleAuthResults(perFolder, serverKey),
        showUpdateNotice: async version => state.showUpdateNotice(version),
        onCardsRendered: new ExtensionCommon.EventManager({
          context,
          name: "qol.onCardsRendered",
          register: fire => {
            state.listeners.add(fire);
            return () => state.listeners.delete(fire);
          },
        }).api(),
      },
    };
  }
};
