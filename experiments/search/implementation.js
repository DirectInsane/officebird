// Privileged code: it reads only Thunderbird's message databases and full-text index and
// never touches the network.
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

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
  // The panel's tip shows for the first TIP_RUNS searches.
  const TIP_PREF = "extensions.officebird.search.tipCount";
  const TIP_RUNS = 5;
  // Tabs in which Ctrl/Cmd+K focuses the field.
  const SHORTCUT_TABS = ["mail3PaneTab", "mailMessageTab"];

  function isMailTab(tab) {
    return tab?.mode?.name === "mail3PaneTab";
  }

  function paneOf(tab) {
    return tab?.chromeBrowser?.contentWindow ?? null;
  }

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

  // The search field of one main window and the searches of its mail tabs.
  class SearchController {
    constructor(manager, win) {
      this.manager = manager;
      this.win = win;
      this.libs = manager.libs;
      this.panel = null;
      this.lang = manager.libs.qolSearchLabels.pickLanguage(Services.locale.appLocaleAsBCP47);
      this.observer = null;
      // Mail tab -> { text, search, blocked }. search: the running or shown search, { tab,
      // pane, scope, sets, shown, started, searching, notices, hdr, run, folderLabel,
      // criteria }; blocked: the criteria of a search that could not run.
      this.tabs = new Map();
      // about:3pane windows -> their folder pane listeners.
      this.panes = new Map();
      this.lastMailTab = null;
      this.closedTabs = new WeakSet();
      this.originalFocus = null;
      this.onKeyDown = event => this.handleKeyDown(event);
      this.tabMonitor = {
        monitorName: "qolSearch",
        onTabTitleChanged() {},
        onTabSwitched: (tab, oldTab) => this.tabSwitched(tab, oldTab),
        onTabOpened() {},
        onTabPersist() {},
        onTabRestored() {},
        onTabClosing: tab => this.tabClosing(tab),
      };
    }

    start() {
      const { win, libs } = this;
      const doc = win.document;
      this.panel = libs.qolSearchPanel.install(win, {
        lang: this.lang,
        sheetURL: this.manager.sheetURL,
        defaultScope: () => this.manager.config?.scope ?? "folder",
        tipShown: () => Services.prefs.getIntPref(TIP_PREF, 0) < TIP_RUNS,
        onSearch: (text, scope) => this.search(text, scope),
        onEnd: () => this.end(),
        onScope: scope => this.setScope(scope),
        onTurnOnIndex: () => this.manager.turnOnIndex(),
        onDismissNotice: kind => this.manager.dismissNotice(kind),
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
      const current = win.gTabmail.currentTabInfo;
      if (isMailTab(current)) {
        this.lastMailTab = current;
      }
      win.gTabmail.registerTabMonitor(this.tabMonitor);
    }

    destroy() {
      const { win } = this;
      try {
        this.endAll();
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
      for (const pane of [...this.panes.keys()]) {
        this.unwatchPane(pane);
      }
      this.tabs.clear();
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

    // Ctrl/Cmd+K wherever the focus is in a mail tab; other tabs (web pages) keep the key.
    handleKeyDown(event) {
      const mac = Services.appinfo.OS === "Darwin";
      const accel = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!accel || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "k") {
        return;
      }
      if (!SHORTCUT_TABS.includes(this.win.gTabmail.currentTabInfo?.mode?.name) || !this.fieldShown()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.panel.focus();
    }

    // Tabs

    tabState(tab) {
      let state = this.tabs.get(tab);
      if (!state) {
        state = { text: "", search: null, blocked: null };
        this.tabs.set(tab, state);
      }
      return state;
    }

    isCurrent(tab) {
      return this.win.gTabmail.currentTabInfo === tab;
    }

    // The field shows the query of the active mail tab; other tabs show it empty.
    tabSwitched(tab, oldTab) {
      if (oldTab && isMailTab(oldTab) && !this.closedTabs.has(oldTab)) {
        this.tabState(oldTab).text = this.panel.getQuery();
      }
      if (isMailTab(tab)) {
        this.lastMailTab = tab;
        const state = this.tabs.get(tab);
        this.panel.setQuery(state?.text ?? "");
        this.panel.setScope(state?.search?.scope ?? null);
      } else {
        this.panel.setQuery("");
        this.panel.setScope(null);
      }
    }

    tabClosing(tab) {
      this.closedTabs.add(tab);
      const state = this.tabs.get(tab);
      if (state?.search) {
        this.finish(state.search);
      }
      this.tabs.delete(tab);
      const pane = paneOf(tab);
      if (pane) {
        this.unwatchPane(pane);
        this.panel.clearResults(pane);
      }
      if (this.lastMailTab === tab) {
        this.lastMailTab = null;
      }
    }

    // The mail tab to show results in: the current one, else the one used last.
    searchTab() {
      const tabmail = this.win.gTabmail;
      const current = tabmail.currentTabInfo;
      if (isMailTab(current)) {
        return current;
      }
      const recent = this.lastMailTab && tabmail.tabInfo.includes(this.lastMailTab) ? this.lastMailTab : null;
      const tab = recent ?? tabmail.tabInfo.find(isMailTab);
      if (tab) {
        tabmail.switchToTab(tab);
      }
      return tab ?? null;
    }

    // Selecting a folder ends the search, also clicking the folder already selected.
    watchPane(pane) {
      if (this.panes.has(pane)) {
        return;
      }
      const stateOf = () => [...this.tabs].find(([tab]) => paneOf(tab) === pane)?.[1] ?? null;
      const searchOf = () => stateOf()?.search ?? null;
      const listeners = {
        // Runs after the folder pane's own handler, which has shown the folder by now.
        select: () => {
          const state = stateOf();
          if (state?.search) {
            this.finish(state.search);
            this.libs.qolSearchResults.end(pane);
          } else if (state?.blocked) {
            state.blocked = null;
            this.panel.clearResults(pane);
          }
        },
        // The row itself, not its twisty, which only opens or closes the subfolders.
        click: event => {
          const row = event.target.closest?.("li");
          const search = searchOf();
          if (search && row && row === pane.folderTree.selectedRow && !event.target.closest(".twisty")) {
            this.endSearch(search);
          }
        },
      };
      pane.folderTree.addEventListener("select", listeners.select);
      pane.folderTree.addEventListener("click", listeners.click);
      this.panes.set(pane, listeners);
    }

    unwatchPane(pane) {
      const listeners = this.panes.get(pane);
      this.panes.delete(pane);
      try {
        pane.folderTree?.removeEventListener("select", listeners.select);
        pane.folderTree?.removeEventListener("click", listeners.click);
      } catch (e) {
        // The tab is gone.
      }
    }

    // Searching

    search(text, scope) {
      const { qolSearchQuery, qolSearchEngine } = this.libs;
      const query = qolSearchQuery.parse(text);
      if (!query.or.length) {
        this.end();
        return;
      }
      const tab = this.searchTab();
      const pane = tab && paneOf(tab);
      if (!pane) {
        log("no mail tab to show results in");
        return;
      }
      const state = this.tabState(tab);
      state.text = text;
      this.panel.setQuery(text);
      this.watchPane(pane);
      const criteria = this.criteria(query);
      if (criteria.some(terms => terms.some(term => term.blocking))) {
        // Whatever the tab shows stays as it is.
        state.blocked = criteria;
        if (state.search) {
          this.render(state.search);
        } else {
          this.panel.setResults({ pane, criteria });
        }
        return;
      }
      state.blocked = null;
      const previous = state.search;
      previous?.run?.cancel();
      // A new search in the same list keeps the list switched until its first report.
      const search = {
        tab,
        pane,
        scope,
        sets: { folder: new Set(), all: new Set() },
        shown: previous?.shown ?? new Set(),
        started: previous?.started ?? false,
        searching: true,
        notices: [],
        // Notice kind -> the notice shown instead (null: none), after its cause changed
        // while the search ran.
        replacedNotices: new Map(),
        hdr: null,
        run: null,
        folderLabel: this.folderLabel(pane, query),
        criteria,
      };
      state.search = search;
      this.panel.setScope(scope);
      Services.prefs.setIntPref(TIP_PREF, Services.prefs.getIntPref(TIP_PREF, 0) + 1);
      const run = qolSearchEngine.run(pane, query, { current: pane.gFolder, scopeDefault: scope }, progress => this.progress(search, progress));
      search.run = run;
      if (!this.isShown(search)) {
        // Ended while it reported for the first time.
        run.cancel();
        return;
      }
      run.done.then(null, e => {
        log("search failed", e);
        if (this.isShown(search) && search.searching) {
          search.searching = false;
          this.render(search);
        }
      });
    }

    isShown(search) {
      return this.tabs.get(search.tab)?.search === search;
    }

    folderInfos() {
      const infos = [];
      for (const folder of MailServices.accounts.allFolders) {
        if (!folder.isServer) {
          infos.push({ uri: folder.URI, name: folder.localizedName, account: folder.server.prettyName });
        }
      }
      return infos;
    }

    // The query's alternatives as printed terms; invalid dates and unknown folders carry
    // their error, and an unknown folder blocks the search.
    criteria(query) {
      const { qolSearchQuery, qolSearchTerms, qolSearchLabels } = this.libs;
      const hasFolder = query.or.some(terms => terms.some(leaf => leaf.field === "in"));
      const infos = hasFolder ? this.folderInfos() : [];
      return query.or.map(terms =>
        terms.map(leaf => {
          const unknown = leaf.field === "in" && !leaf.error && !qolSearchTerms.matchFolders(infos, leaf.value).length;
          let error = null;
          if (leaf.error === "date") {
            error = qolSearchLabels.label(this.lang, "badDate");
          } else if (unknown) {
            error = qolSearchLabels.label(this.lang, "unknownFolder", { name: leaf.value });
          }
          return { text: qolSearchQuery.print({ or: [[leaf]] }, this.lang), error, blocking: unknown };
        })
      );
    }

    folderLabel(pane, query) {
      const chosen = query.or.flat().find(leaf => leaf.field === "in" && !leaf.negated && !leaf.error);
      return chosen ? chosen.value : pane.gFolder?.localizedName ?? "";
    }

    progress(search, state) {
      if (!this.isShown(search)) {
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
      // Ids whose mail can still be read, with its header.
      const readable = list => {
        const found = [];
        for (const id of list) {
          const hdr = search.hdr?.(id);
          if (hdr) {
            found.push([id, hdr]);
          }
        }
        return found;
      };
      try {
        if (!search.started || [...search.shown].some(id => !ids.has(id))) {
          const found = readable(ids);
          results.show(pane, found.map(([, hdr]) => hdr));
          search.shown = new Set(found.map(([id]) => id));
          search.started = true;
        } else {
          const fresh = readable([...ids].filter(id => !search.shown.has(id)));
          if (fresh.length) {
            results.add(pane, fresh.map(([, hdr]) => hdr));
            for (const [id] of fresh) {
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
      this.setHeader(pane, search.shown.size);
      if (this.isCurrent(search.tab)) {
        this.panel.setScope(search.scope);
      }
      this.panel.setResults({
        pane,
        folderLabel: search.folderLabel,
        folderCount: search.sets.folder.size,
        allCount: search.sets.all.size,
        active: search.scope,
        searching: search.searching,
        notices: search.notices
          .map(notice => (search.replacedNotices.has(notice.kind) ? search.replacedNotices.get(notice.kind) : notice))
          .filter(notice => notice && !this.manager.dismissed.has(notice.kind)),
        criteria: this.tabs.get(search.tab).blocked ?? search.criteria,
        empty: !search.searching && !search.shown.size,
      });
    }

    // After a notice was closed or its cause changed; `replacement` is shown in its place.
    replaceNotice(kind, replacement = null) {
      for (const { search } of this.tabs.values()) {
        if (search?.notices.some(notice => notice.kind === kind)) {
          search.replacedNotices.set(kind, replacement);
          this.render(search);
        }
      }
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

    // Switches between the result sets of the current tab's search; no new search.
    setScope(scope) {
      const search = this.tabs.get(this.win.gTabmail.currentTabInfo)?.search;
      if (!search || search.scope === scope) {
        return;
      }
      search.scope = scope;
      this.render(search);
    }

    // Esc, ✕, Clear: the current tab's folder comes back as it was.
    end() {
      const tab = this.win.gTabmail.currentTabInfo;
      const state = this.tabs.get(tab);
      if (!state) {
        return;
      }
      state.text = "";
      state.blocked = null;
      const pane = paneOf(tab);
      if (pane) {
        this.panel.clearResults(pane);
      }
      if (state.search) {
        this.endSearch(state.search);
      }
    }

    // Ends the searches of every tab and empties the field.
    endAll() {
      this.panel?.setQuery("");
      for (const [tab, state] of this.tabs) {
        state.text = "";
        state.blocked = null;
        const pane = paneOf(tab);
        if (pane) {
          this.panel.clearResults(pane);
        }
        if (state.search) {
          this.endSearch(state.search);
        }
      }
    }

    endSearch(search) {
      this.finish(search);
      const results = this.libs.qolSearchResults;
      if (results.isActive(search.pane)) {
        results.end(search.pane);
      }
      search.pane.threadPaneHeader?.onFolderSelected();
    }

    // Stops the search and its chips; the list is left as it is.
    finish(search) {
      const state = this.tabs.get(search.tab);
      if (state?.search === search) {
        state.search = null;
        state.blocked = null;
      }
      search.run?.cancel();
      this.panel?.clearResults(search.pane);
      if (this.isCurrent(search.tab)) {
        this.panel?.setScope(null);
      }
    }
  }

  class SearchManager {
    constructor(extension) {
      this.extension = extension;
      this.config = null;
      this.features = { search: true };
      this.listenerId = `${extension.id}-search`;
      this.sheetURL = extension.rootURI.resolve(SHEET_PATH);
      // Window -> its unload listener.
      this.windows = new Map();
      this.started = false;
      // Notice kinds closed with ✕: not shown again until Thunderbird restarts.
      this.dismissed = new Set();
      this.indexListeners = new Set();
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
        for (const win of this.windows.keys()) {
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
      for (const win of [...this.windows.keys()]) {
        this.forget(win);
      }
    }

    unavailable(reason, error) {
      this.features.search = false;
      log(`search unavailable: ${reason}`, error ?? "");
    }

    // The background turns the index on through the Thunderbird settings allowlist. Gloda
    // reads that pref at startup, so an index that is not running needs a restart.
    turnOnIndex() {
      for (const fire of this.indexListeners) {
        fire.async();
      }
      let running = false;
      try {
        running = ChromeUtils.importESModule("resource:///modules/gloda/GlodaIndexer.sys.mjs").GlodaIndexer.enabled;
      } catch (e) {
        log("full-text indexer not available", e);
      }
      const replacement = running ? null : { kind: "glodaRestart" };
      this.eachController(controller => controller.replaceNotice("glodaOff", replacement));
    }

    dismissNotice(kind) {
      this.dismissed.add(kind);
      this.eachController(controller => controller.replaceNotice(kind));
    }

    eachController(fn) {
      for (const win of this.windows.keys()) {
        if (win.qolSearch) {
          fn(win.qolSearch.controller);
        }
      }
    }

    // Windows

    watch(win) {
      if (this.windows.has(win)) {
        return;
      }
      const onUnload = () => this.forget(win);
      this.windows.set(win, onUnload);
      win.addEventListener("unload", onUnload, { once: true });
      this.refresh(win);
    }

    forget(win) {
      const onUnload = this.windows.get(win);
      if (!onUnload) {
        return;
      }
      this.windows.delete(win);
      win.removeEventListener("unload", onUnload);
      this.detach(win);
    }

    // A window that failed before gets another try with every new config.
    refreshAll() {
      this.features.search = Boolean(this.libs);
      for (const win of this.windows.keys()) {
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
      win.qolSearch = { libs: this.libs, controller, end: () => controller.endAll() };
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

    getAPI(context) {
      if (!this.manager) {
        this.manager = new SearchManager(this.extension);
      }
      const manager = this.manager;
      return {
        qolSearch: {
          init: async config => manager.init(config),
          updateConfig: async config => manager.updateConfig(config),
          getFeatures: async () => ({ ...manager.features }),
          onTurnOnIndex: new ExtensionCommon.EventManager({
            context,
            name: "qolSearch.onTurnOnIndex",
            register: fire => {
              manager.indexListeners.add(fire);
              return () => manager.indexListeners.delete(fire);
            },
          }).api(),
        },
      };
    }
  };
})();
