// Privileged code: it reads only Thunderbird's message databases and full-text index and
// never touches the network.
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");

// Experiment scripts share one global: only the API class is defined there.
var qolSearch = (() => {
  const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";
  const SHEET_PATH = "experiments/search/search.css";
  // Must match search.css, which hides Thunderbird's search bar only while it is set.
  const ATTACHED_ATTR = "data-qol-search";
  // Classic scripts in load order, each with the one global it defines.
  const SCRIPTS = [
    ["qolSearchQuery", "experiments/search/query.js"],
    ["qolSearchSets", "experiments/search/sets.js"],
    ["qolSearchTerms", "experiments/search/terms.js"],
    ["qolSearchPanelModel", "experiments/search/panelmodel.js"],
    ["qolSearchLabels", "experiments/search/labels.js"],
    ["qolSearchEngine", "experiments/search/engine.js"],
    ["qolSearchResults", "experiments/search/results.js"],
    ["qolSearchPanel", "experiments/search/panel.js"],
  ];
  // Without these a window keeps Thunderbird's own search bar.
  const REQUIRED_IDS = ["unifiedToolbarContent", "tabmail"];

  function log(...args) {
    console.warn("[qolSearch]", ...args);
  }

  // One sandbox for all scripts: the later ones use the globals of the earlier ones. Without
  // Xrays, so they see Thunderbird's own globals of the windows they are given.
  function loadAddonScripts(extension) {
    const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxName: "qol:search", wantXrays: false });
    for (const [, path] of SCRIPTS) {
      // loadSubScript refuses add-on package URLs in privileged code.
      const channel = NetUtil.newChannel({ uri: extension.rootURI.resolve(path), loadUsingSystemPrincipal: true });
      const stream = channel.open();
      try {
        const source = NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
        Cu.evalInSandbox(source, sandbox, "latest", path, 1);
      } finally {
        stream.close();
      }
    }
    return Object.fromEntries(SCRIPTS.map(([name]) => [name, sandbox[name]]));
  }

  // The search field of one main window and the search it runs.
  class SearchController {
    constructor(manager, win) {
      this.manager = manager;
      this.win = win;
      this.libs = manager.libs;
      this.panel = null;
      this.lang = manager.libs.qolSearchLabels.pickLanguage(Services.locale.appLocaleAsBCP47);
      this.observer = null;
      // The running or shown search: { pane, scope, sets, shown, started, searching, notices, hdr, run, folderLabel }.
      this.active = null;
      // about:3pane windows -> their folder pane listeners.
      this.panes = new Map();
      this.originalFocus = null;
      this.onKeyDown = event => this.handleKeyDown(event);
      this.tabMonitor = {
        monitorName: "qolSearch",
        onTabTitleChanged() {},
        onTabSwitched() {},
        onTabOpened() {},
        onTabPersist() {},
        onTabRestored() {},
        onTabClosing: tab => {
          if (this.active && tab.chromeBrowser?.contentWindow === this.active.pane) {
            this.finish(this.active);
          }
        },
      };
    }

    start() {
      const { win, libs } = this;
      const doc = win.document;
      this.panel = libs.qolSearchPanel.install(win, {
        lang: this.lang,
        sheetURL: this.manager.sheetURL,
        defaultScope: () => this.manager.config?.scope ?? "folder",
        onSearch: (text, scope) => this.search(text, scope),
        onEnd: () => this.end(),
        onScope: scope => this.setScope(scope),
        onTurnOnIndex: () => this.manager.turnOnIndex(),
      });
      this.place();
      // Customizing the toolbar or switching spaces rebuilds the toolbar's items.
      this.observer = new win.MutationObserver(() => this.place());
      this.observer.observe(doc.getElementById("unifiedToolbarContent"), { childList: true, subtree: true });
      doc.documentElement.setAttribute(ATTACHED_ATTR, "true");

      // Thunderbird's search shortcut (Ctrl/Cmd+K and the menu) calls QuickSearchFocus.
      this.originalFocus = win.QuickSearchFocus;
      this.quickSearchFocus = () => {
        if (this.fieldShown()) {
          this.panel.focus();
        } else {
          this.originalFocus?.call(win);
        }
      };
      win.QuickSearchFocus = this.quickSearchFocus;
      win.addEventListener("keydown", this.onKeyDown, true);
      win.gTabmail.registerTabMonitor(this.tabMonitor);
    }

    destroy() {
      const { win } = this;
      try {
        this.end();
      } catch (e) {
        log("search not ended", e);
      }
      this.observer?.disconnect();
      win.removeEventListener("keydown", this.onKeyDown, true);
      if (this.originalFocus && win.QuickSearchFocus === this.quickSearchFocus) {
        win.QuickSearchFocus = this.originalFocus;
      }
      try {
        win.gTabmail?.unregisterTabMonitor(this.tabMonitor);
      } catch (e) {
        // Not registered.
      }
      for (const [pane, listeners] of this.panes) {
        try {
          pane.folderTree?.removeEventListener("select", listeners.select);
          pane.folderTree?.removeEventListener("click", listeners.click);
        } catch (e) {
          // The tab is gone.
        }
      }
      this.panes.clear();
      try {
        this.panel?.destroy();
      } catch (e) {
        log("panel cleanup failed", e);
      }
      win.document.documentElement.removeAttribute(ATTACHED_ATTR);
    }

    // In place of Thunderbird's search bar; without one in the toolbar, at its start.
    place() {
      const root = this.panel?.root;
      const content = this.win.document.getElementById("unifiedToolbarContent");
      if (!root || !content) {
        return;
      }
      const item =
        content.querySelector('li[item-id="search-bar"]:not([hidden])') ?? content.querySelector('li[item-id="search-bar"]');
      if (item) {
        if (root.parentElement !== item) {
          item.append(root);
        }
      } else if (root.nextElementSibling !== content) {
        content.before(root);
      }
    }

    fieldShown() {
      const root = this.panel?.root;
      return Boolean(root?.isConnected && root.getBoundingClientRect().width > 0);
    }

    handleKeyDown(event) {
      const mac = Services.appinfo.OS === "Darwin";
      const accel = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!accel || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "k" || !this.fieldShown()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.panel.focus();
    }

    // The mail tab to show results in: the current one, else the first.
    searchPane() {
      const tabmail = this.win.gTabmail;
      if (tabmail.currentAbout3Pane) {
        return tabmail.currentAbout3Pane;
      }
      const tab = tabmail.tabInfo.find(info => info.mode.name === "mail3PaneTab");
      if (!tab) {
        return null;
      }
      tabmail.switchToTab(tab);
      return tab.chromeBrowser.contentWindow;
    }

    // Selecting a folder ends the search, also clicking the folder already selected.
    watchPane(pane) {
      if (this.panes.has(pane)) {
        return;
      }
      const listeners = {
        // Runs after the folder pane's own handler, which has shown the folder by now.
        select: () => {
          const search = this.active;
          if (search?.pane === pane) {
            this.finish(search);
            this.libs.qolSearchResults.end(pane);
          }
        },
        click: event => {
          const row = event.target.closest?.("li");
          if (this.active?.pane === pane && row && row === pane.folderTree.selectedRow) {
            this.end();
          }
        },
      };
      pane.folderTree.addEventListener("select", listeners.select);
      pane.folderTree.addEventListener("click", listeners.click);
      this.panes.set(pane, listeners);
    }

    search(text, scope) {
      const { qolSearchQuery, qolSearchEngine } = this.libs;
      const query = qolSearchQuery.parse(text);
      if (!query.or.length) {
        this.end();
        return;
      }
      const pane = this.searchPane();
      if (!pane) {
        log("no mail tab to show results in");
        return;
      }
      if (this.active && this.active.pane !== pane) {
        this.end();
      }
      const previous = this.active;
      previous?.run?.cancel();
      // A new search in the same list keeps the list switched until its first report.
      const search = {
        pane,
        scope,
        sets: { folder: new Set(), all: new Set() },
        shown: previous?.shown ?? new Set(),
        started: previous?.started ?? false,
        searching: true,
        notices: [],
        hdr: null,
        run: null,
        folderLabel: this.folderLabel(pane, query),
      };
      this.active = search;
      this.watchPane(pane);
      const run = qolSearchEngine.run(pane, query, { current: pane.gFolder, scopeDefault: scope }, state => this.progress(search, state));
      search.run = run;
      if (this.active !== search) {
        // Ended while it reported for the first time.
        run.cancel();
        return;
      }
      run.done.then(null, e => {
        log("search failed", e);
        if (this.active === search && search.searching) {
          search.searching = false;
          this.render(search);
        }
      });
    }

    folderLabel(pane, query) {
      const chosen = query.or.flat().find(leaf => leaf.field === "in" && !leaf.negated && !leaf.error);
      return chosen ? chosen.value : pane.gFolder?.localizedName ?? "";
    }

    progress(search, state) {
      if (this.active !== search) {
        return;
      }
      search.sets = { folder: state.folderIds, all: state.allIds };
      search.searching = state.searching;
      search.notices = state.notices;
      search.hdr = state.hdr;
      this.render(search);
    }

    // Shows the active scope's hits: new ones are added, a set that lost hits is shown anew.
    render(search) {
      const results = this.libs.qolSearchResults;
      const { pane } = search;
      if (search.started && !results.isActive(pane)) {
        // Thunderbird replaced the list, for example for another folder.
        this.finish(search);
        return;
      }
      const ids = search.sets[search.scope];
      const hdrs = list => (search.hdr ? list.map(id => search.hdr(id)).filter(Boolean) : []);
      try {
        if (!search.started || [...search.shown].some(id => !ids.has(id))) {
          results.show(pane, hdrs([...ids]));
          search.shown = new Set(ids);
          search.started = true;
        } else {
          const fresh = [...ids].filter(id => !search.shown.has(id));
          if (fresh.length) {
            results.add(pane, hdrs(fresh));
            for (const id of fresh) {
              search.shown.add(id);
            }
          }
        }
      } catch (e) {
        // show() has brought the folder back.
        log("results not shown", e);
        this.finish(search);
        return;
      }
      this.setHeader(pane, ids.size);
      this.panel.setResults({
        pane,
        folderLabel: search.folderLabel,
        folderCount: search.sets.folder.size,
        allCount: search.sets.all.size,
        active: search.scope,
        searching: search.searching,
        notices: search.notices,
      });
    }

    setHeader(pane, count) {
      const doc = pane.document;
      const name = doc.getElementById("threadPaneFolderName");
      const folderCount = doc.getElementById("threadPaneFolderCount");
      if (!name) {
        return;
      }
      const label = this.libs.qolSearchLabels.label(this.lang, "results");
      name.textContent = `${label} · ${count}`;
      name.title = name.textContent;
      name.hidden = false;
      if (folderCount) {
        folderCount.hidden = true;
      }
    }

    // Switches between the result sets of the search that ran; no new search.
    setScope(scope) {
      const search = this.active;
      if (!search || search.scope === scope) {
        return;
      }
      search.scope = scope;
      this.render(search);
    }

    // Esc, ✕, Clear, clicking the selected folder: the folder comes back as it was.
    end() {
      const search = this.active;
      if (!search) {
        return;
      }
      this.finish(search);
      const results = this.libs.qolSearchResults;
      if (results.isActive(search.pane)) {
        results.end(search.pane);
      }
      search.pane.threadPaneHeader?.onFolderSelected();
    }

    // Stops the search and its chips; the list is left as it is.
    finish(search) {
      if (this.active === search) {
        this.active = null;
      }
      search.run?.cancel();
      this.panel?.clearResults();
    }
  }

  class SearchManager {
    constructor(extension) {
      this.extension = extension;
      this.config = null;
      this.features = { search: true };
      this.listenerId = `${extension.id}-search`;
      this.sheetURL = extension.rootURI.resolve(SHEET_PATH);
      this.windows = new Set();
      this.started = false;
      this.libs = null;
      try {
        this.libs = loadAddonScripts(extension);
      } catch (e) {
        this.unavailable("search scripts not loaded", e);
      }
    }

    // Lifecycle

    // Attaches anew to every window: the background starts over.
    init(config) {
      this.config = config;
      if (this.started) {
        for (const win of this.windows) {
          this.detach(win);
        }
        this.refreshAll();
      } else {
        this.started = true;
        this.features.search = Boolean(this.libs);
        // Also runs for windows that are already open.
        ExtensionSupport.registerWindowListener(this.listenerId, {
          chromeURLs: [MESSENGER_URL],
          onLoadWindow: win => this.watch(win),
        });
      }
      return { ...this.features };
    }

    updateConfig(config) {
      this.config = config;
      this.refreshAll();
    }

    teardown() {
      if (this.started) {
        ExtensionSupport.unregisterWindowListener(this.listenerId);
        this.started = false;
      }
      for (const win of [...this.windows]) {
        this.forget(win);
      }
    }

    unavailable(reason, error) {
      this.features.search = false;
      log(`search unavailable: ${reason}`, error ?? "");
    }

    // Not wired up yet: the index stays as it is.
    turnOnIndex() {}

    // Windows

    watch(win) {
      if (this.windows.has(win)) {
        return;
      }
      this.windows.add(win);
      win.addEventListener("unload", () => this.forget(win), { once: true });
      this.refresh(win);
    }

    forget(win) {
      if (this.windows.delete(win)) {
        this.detach(win);
      }
    }

    // A window that failed before gets another try with every new config.
    refreshAll() {
      this.features.search = Boolean(this.libs);
      for (const win of this.windows) {
        this.refresh(win);
      }
    }

    refresh(win) {
      if (this.config?.enabled && this.libs) {
        this.attach(win);
      } else {
        this.detach(win);
      }
    }

    attach(win) {
      if (win.qolSearch) {
        return;
      }
      const missing = REQUIRED_IDS.filter(id => !win.document.getElementById(id));
      if (!win.gTabmail || typeof win.QuickSearchFocus !== "function") {
        missing.push("gTabmail, QuickSearchFocus()");
      }
      if (missing.length) {
        this.unavailable(`main window lacks ${missing.join(", ")}`);
        return;
      }
      const controller = new SearchController(this, win);
      win.qolSearch = { libs: this.libs, controller, end: () => controller.end() };
      try {
        controller.start();
      } catch (e) {
        this.unavailable("attach failed", e);
        this.detach(win);
      }
    }

    detach(win) {
      const entry = win.qolSearch;
      if (!entry) {
        return;
      }
      delete win.qolSearch;
      try {
        entry.controller.destroy();
      } catch (e) {
        log("detach failed", e);
      }
    }
  }

  return class extends ExtensionCommon.ExtensionAPI {
    onShutdown(isAppShutdown) {
      if (!isAppShutdown) {
        this.manager?.teardown();
      }
    }

    getAPI() {
      if (!this.manager) {
        this.manager = new SearchManager(this.extension);
      }
      const manager = this.manager;
      return {
        qolSearch: {
          init: async config => manager.init(config),
          updateConfig: async config => manager.updateConfig(config),
          getFeatures: async () => ({ ...manager.features }),
        },
      };
    }
  };
})();
