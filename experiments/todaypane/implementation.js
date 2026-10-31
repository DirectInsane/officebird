// Privileged code: restyles Thunderbird's Today Pane in the main window. It only adds
// attributes, a title element and a stylesheet, and moves the new event button. It also
// changes the Today Pane's own Thunderbird settings for the options page.
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");

// Experiment scripts share one global: only the API class is defined there.
var qolTodayPane = (() => {
  const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";
  const SHEET_PATH = "experiments/todaypane/todaypane.css";
  const MODEL_PATH = "experiments/todaypane/model.js";
  // Must match todaypane.css, which applies only while it is set.
  const ATTACHED_ATTR = "data-qol-todaypane";
  const REQUIRED_IDS = ["today-pane-panel", "today-pane-header", "buttonspacer", "todaypane-new-event-button", "agenda", "today-minimonth"];
  // Once per profile: the mini calendar instead of the mini day, and a wider pane.
  const LAYOUT_PREF = "extensions.officebird.todayPane.layout";
  const PANE_WIDTH = 280;
  const XHTML = "http://www.w3.org/1999/xhtml";
  const WEEK_NUMBER_PREF = "calendar.view-minimonth.showWeekNumber";
  const AGENDA_DAYS_PREF = "calendar.agenda.days";
  // Thunderbird's own limits for the agenda.
  const AGENDA_DAYS = { min: 1, max: 28, fallback: 14 };
  const HEX = /^#[0-9a-f]{6}$/i;

  function log(...args) {
    console.warn("[qolTodayPane]", ...args);
  }

  function loadModel(extension) {
    const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxName: "qol:todaypane", wantXrays: false });
    // loadSubScript refuses add-on package URLs in privileged code.
    const channel = NetUtil.newChannel({ uri: extension.rootURI.resolve(MODEL_PATH), loadUsingSystemPrincipal: true });
    const stream = channel.open();
    try {
      const source = NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
      Cu.evalInSandbox(source, sandbox, "latest", MODEL_PATH, 1);
    } finally {
      stream.close();
    }
    return sandbox.qolTodayModel;
  }

  function applyLayoutOnce(win) {
    if (Services.prefs.getBoolPref(LAYOUT_PREF, false)) {
      return;
    }
    const doc = win.document;
    const panel = doc.getElementById("today-pane-panel");
    const modes = (panel.getAttribute("mode") || "").split(",").filter(Boolean);
    const collapsed = {
      "today-minimonth-box": "",
      "mini-day-box": modes.join(","),
      "today-none-box": modes.join(","),
    };
    for (const [id, value] of Object.entries(collapsed)) {
      const box = doc.getElementById(id);
      if (box) {
        box.setAttribute("collapsedinmodes", value);
        Services.xulStore.persist(box, "collapsedinmodes");
      }
    }
    panel.setAttribute("modewidths", modes.map(() => String(PANE_WIDTH)).join(","));
    Services.xulStore.persist(panel, "modewidths");
    panel.style.width = `${PANE_WIDTH}px`;
    win.TodayPane.displayMiniSection("minimonth");
    Services.prefs.setBoolPref(LAYOUT_PREF, true);
  }

  // View > Today Pane in the mail tab, like the menu item and F11.
  function isShownInMail(win) {
    return win.document.getElementById("today-pane-panel").isVisible("mail");
  }

  function showInMail(win, shown) {
    const panel = win.document.getElementById("today-pane-panel");
    if (panel.currentMode === "mail") {
      panel.setVisible(shown, true, true);
    } else {
      const modes = (panel.getAttribute("collapsedinmodes") || "").split(",").filter(mode => mode && mode !== "mail");
      if (!shown) {
        modes.push("mail");
      }
      // Thunderbird writes "," for an empty list.
      panel.setAttribute("collapsedinmodes", modes.join(",") || ",");
      Services.xulStore.persist(panel, "collapsedinmodes");
    }
    win.TodayPane.updateDisplay();
    win.TodayPane.updateSplitterState();
  }

  // The look of one main window; destroy() puts everything back.
  class PaneController {
    constructor(manager, win) {
      this.manager = manager;
      this.win = win;
      this.locale = Services.locale.appLocaleAsBCP47;
      this.undo = [];
      this.pending = false;
    }

    start() {
      const { win } = this;
      const doc = win.document;

      win.windowUtils.loadSheetUsingURIString(this.manager.sheetURL, win.windowUtils.AUTHOR_SHEET);
      this.undo.push(() => win.windowUtils.removeSheetUsingURIString(this.manager.sheetURL, win.windowUtils.AUTHOR_SHEET));
      doc.documentElement.setAttribute(ATTACHED_ATTR, "true");
      this.undo.push(() => doc.documentElement.removeAttribute(ATTACHED_ATTR));

      // The new event button moves from above the agenda to the header.
      const button = doc.getElementById("todaypane-new-event-button");
      const home = button.parentNode;
      const next = button.nextSibling;
      doc.getElementById("buttonspacer").before(button);
      this.undo.push(() => home.insertBefore(button, next));

      const agenda = doc.getElementById("agenda");
      this.title = doc.createElementNS(XHTML, "div");
      this.title.id = "qol-agenda-title";
      this.month = doc.createElementNS(XHTML, "span");
      // Shown while another day is picked: back to today and the days after it.
      this.todayButton = doc.createElementNS(XHTML, "button");
      this.todayButton.type = "button";
      this.todayButton.className = "qol-agenda-today";
      doc.l10n.setAttributes(this.todayButton, "calendar-today");
      this.todayButton.addEventListener("click", () => this.showToday());
      this.title.append(this.month, this.todayButton);
      agenda.before(this.title);
      this.undo.push(() => this.title.remove());

      const observer = new win.MutationObserver(() => this.schedule());
      observer.observe(agenda, { childList: true });
      this.undo.push(() => observer.disconnect());

      // Picking a day sets TodayPane.start, also when the agenda stays empty.
      const minimonth = doc.getElementById("today-minimonth");
      const onChange = () => this.schedule();
      minimonth.addEventListener("change", onChange);
      this.undo.push(() => minimonth.removeEventListener("change", onChange));

      this.undo.push(() => {
        for (const header of agenda.querySelectorAll(".agenda-date-header")) {
          delete header.dataset.qolWeekday;
          delete header.dataset.qolDay;
          delete header.dataset.qolToday;
        }
      });

      this.undo.push(() => {
        doc.documentElement.style.removeProperty("--qol-today-highlight");
        doc.documentElement.style.removeProperty("--qol-today-on-highlight");
      });
      this.applyHighlight();

      try {
        applyLayoutOnce(win);
      } catch (e) {
        log("layout not applied", e);
      }
      this.update();
    }

    // Red needs nothing: todaypane.css falls back to it.
    applyHighlight() {
      const { highlight, customColor } = this.manager.config ?? {};
      const style = this.win.document.documentElement.style;
      if (highlight === "accent") {
        style.setProperty("--qol-today-highlight", "var(--selected-item-color)");
        style.setProperty("--qol-today-on-highlight", "var(--selected-item-text-color)");
      } else if (highlight === "custom" && HEX.test(customColor ?? "")) {
        style.setProperty("--qol-today-highlight", customColor);
        style.setProperty("--qol-today-on-highlight", this.manager.model.textOn(customColor));
      } else {
        style.removeProperty("--qol-today-highlight");
        style.removeProperty("--qol-today-on-highlight");
      }
    }

    schedule() {
      if (this.pending) {
        return;
      }
      this.pending = true;
      this.win.requestAnimationFrame(() => {
        this.pending = false;
        this.update();
      });
    }

    update() {
      const { win } = this;
      const model = this.manager.model;
      const now = new Date();
      const agenda = win.document.getElementById("agenda");
      for (const row of agenda.children) {
        const header = row.querySelector(":scope > .agenda-date-header");
        const parts = header && model.dayParts(row.dateString, now, this.locale);
        if (!parts) {
          continue;
        }
        header.dataset.qolWeekday = parts.weekday;
        header.dataset.qolDay = parts.day;
        header.toggleAttribute("data-qol-today", parts.today);
      }
      const start = win.TodayPane?.start;
      const { month, year } = start
        ? model.monthParts(start.year, start.month, this.locale)
        : model.monthParts(now.getFullYear(), now.getMonth(), this.locale);
      const bold = win.document.createElementNS(XHTML, "b");
      bold.textContent = month;
      this.month.replaceChildren(bold, ` ${year}`);
      this.todayButton.hidden = win.TodayPane?.showsToday !== false;
    }

    showToday() {
      const { win } = this;
      const now = new Date();
      // Like the mini calendar's own today button; that only reaches the agenda when the
      // picked day changes, not after browsing to another month.
      win.document.getElementById("today-minimonth").value = now;
      if (!win.TodayPane.showsToday) {
        win.TodayPane.setDaywithjsDate(now);
      }
      this.schedule();
    }

    destroy() {
      for (const step of this.undo.reverse()) {
        try {
          step();
        } catch (e) {
          log("restore failed", e);
        }
      }
      this.undo = [];
    }
  }

  class TodayPaneManager {
    constructor(extension) {
      this.extension = extension;
      this.sheetURL = extension.rootURI.resolve(SHEET_PATH);
      this.listenerId = `${extension.id}-todaypane`;
      this.windows = new Map(); // main window → unload listener
      this.config = null;
      this.started = false;
      this.features = { todayPane: false };
      try {
        this.model = loadModel(extension);
        this.features.todayPane = true;
      } catch (e) {
        this.model = null;
        log("model not loaded", e);
      }
    }

    init(config) {
      this.config = config;
      if (!this.started) {
        this.started = true;
        ExtensionSupport.registerWindowListener(this.listenerId, {
          chromeURLs: [MESSENGER_URL],
          onLoadWindow: win => this.watch(win),
        });
      }
      return { ...this.features };
    }

    updateConfig(config) {
      this.config = config;
      this.features.todayPane = Boolean(this.model);
      for (const win of this.windows.keys()) {
        this.refresh(win);
      }
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

    // Thunderbird's own settings, also when the look is off. The pane state is read
    // from one main window and set in all of them.
    getCalendarSettings() {
      const win = [...this.windows.keys()][0];
      return {
        todayPaneShown: win ? isShownInMail(win) : false,
        weekNumbers: Services.prefs.getBoolPref(WEEK_NUMBER_PREF, true),
        agendaDays: Services.prefs.getIntPref(AGENDA_DAYS_PREF, AGENDA_DAYS.fallback),
      };
    }

    setCalendarSetting(name, value) {
      if (name === "todayPaneShown") {
        for (const win of this.windows.keys()) {
          try {
            showInMail(win, Boolean(value));
          } catch (e) {
            log("today pane not toggled", e);
          }
        }
      } else if (name === "weekNumbers") {
        Services.prefs.setBoolPref(WEEK_NUMBER_PREF, Boolean(value));
      } else if (name === "agendaDays") {
        const days = Math.round(Number(value));
        if (Number.isFinite(days)) {
          Services.prefs.setIntPref(AGENDA_DAYS_PREF, Math.min(AGENDA_DAYS.max, Math.max(AGENDA_DAYS.min, days)));
        }
      }
    }

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

    refresh(win) {
      if (this.config?.enabled && this.model) {
        this.attach(win);
        win.qolTodayPane?.applyHighlight();
      } else {
        this.detach(win);
      }
    }

    attach(win) {
      if (win.qolTodayPane) {
        return;
      }
      const missing = REQUIRED_IDS.filter(id => !win.document.getElementById(id));
      if (typeof win.TodayPane?.displayMiniSection !== "function") {
        missing.push("TodayPane");
      }
      if (missing.length) {
        this.features.todayPane = false;
        log(`main window lacks ${missing.join(", ")}`);
        return;
      }
      const controller = new PaneController(this, win);
      win.qolTodayPane = controller;
      try {
        controller.start();
      } catch (e) {
        this.features.todayPane = false;
        log("attach failed", e);
        this.detach(win);
      }
    }

    detach(win) {
      const controller = win.qolTodayPane;
      if (!controller) {
        return;
      }
      delete win.qolTodayPane;
      controller.destroy();
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
        this.manager = new TodayPaneManager(this.extension);
      }
      const manager = this.manager;
      return {
        qolTodayPane: {
          init: async config => manager.init(config),
          updateConfig: async config => manager.updateConfig(config),
          getFeatures: async () => ({ ...manager.features }),
          getCalendarSettings: async () => manager.getCalendarSettings(),
          setCalendarSetting: async (name, value) => manager.setCalendarSetting(name, value),
        },
      };
    }
  };
})();
