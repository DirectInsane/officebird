// Classic script, loaded into the experiment's sandbox.
"use strict";

var qolComposeCommands = (() => {
  // Thunderbird disables these once the ribbon gets the keyboard focus, so the ribbon
  // runs them, and shows their state, for the element it took the focus from.
  const FOCUSED_COMMANDS = new Set(["cmd_cut", "cmd_copy", "cmd_paste", "cmd_pasteNoFormatting", "cmd_renderedHTMLEnabler"]);

  // Thunderbird's markup ships disabled="" and goSetCommandEnabled writes "true"; both mean disabled.
  function isDisabled(node) {
    return node.hasAttribute("disabled") && node.getAttribute("disabled") !== "false";
  }

  function allControls(definition) {
    return [...definition.quickAccess, ...definition.tabs.flatMap(t => t.groups.flatMap(g => g.controls))];
  }

  function create(win, { view, definition, engine = null, formatting = null }) {
    const doc = win.document;
    // Thunderbird's globals (goDoCommand) are hidden behind Xrays from this sandbox.
    const page = win.wrappedJSObject || win;
    const controls = new Map(allControls(definition).map(c => [c.id, c]));
    const popups = new Map();
    const moved = [];
    const watched = new Map();

    const popupHome = doc.getElementById("mainPopupSet") || view.root;

    function findPopup(id) {
      const node = doc.getElementById(id);
      if (!node) {
        return null;
      }
      return node.localName === "menupopup" ? node : node.querySelector(":scope > menupopup");
    }

    // Thunderbird's menus live in its compose toolbar, display: none while the ribbon is
    // attached, and a popup there has no frame and does not open; destroy() puts them back.
    function movePopups() {
      for (const c of controls.values()) {
        const popup = c.popup && findPopup(c.popup);
        if (!popup) {
          continue;
        }
        if (popup.parentNode !== popupHome) {
          moved.push({ popup, parent: popup.parentNode, next: popup.nextSibling });
          popupHome.append(popup);
        }
        popups.set(c.id, popup);
      }
    }

    function openPopup(c, anchor) {
      const popup = popups.get(c.id);
      if (popup) {
        popup.openPopup(anchor || view.control(c.id), "after_start");
      }
    }

    function ribbonHasFocus() {
      const active = doc.activeElement;
      return Boolean(active && view.root.contains(active));
    }

    // The field the ribbon took the focus from; null means the mail, whose editor is in a
    // frame of its own and is never a focus event's relatedTarget.
    let returnTo = null;

    function editorElement() {
      try {
        return page.GetCurrentEditorElement();
      } catch (e) {
        return null;
      }
    }

    function focusTarget() {
      return returnTo?.isConnected ? returnTo : editorElement();
    }

    function returnFocus() {
      if (!ribbonHasFocus()) {
        return;
      }
      try {
        focusTarget().focus();
      } catch (e) {
        win.console.error("[qolCompose] could not return the focus", e);
      }
    }

    function stateCommand(c) {
      return c.command || c.enabledBy || null;
    }

    function followsFocus(c) {
      return FOCUSED_COMMANDS.has(stateCommand(c));
    }

    // null when no controller handles the command.
    function enabledFor(element, command) {
      try {
        const editor = editorElement();
        const own = element && element === editor ? element.contentWindow.controllers : element?.controllers;
        const controller = own?.getControllerForCommand(command) ?? win.controllers.getControllerForCommand(command);
        return controller ? Boolean(controller.isCommandEnabled(command)) : null;
      } catch (e) {
        return false;
      }
    }

    function commandEnabled(c) {
      const name = stateCommand(c);
      if (!name) {
        return true;
      }
      if (followsFocus(c) && ribbonHasFocus()) {
        const enabled = enabledFor(focusTarget(), name);
        // Unhandled (the Insert enabler in plain-text mail): keep Thunderbird's state.
        if (enabled !== null) {
          return enabled;
        }
      }
      const command = doc.getElementById(name);
      return Boolean(command) && !isDisabled(command);
    }

    function sync(c) {
      if (c.command) {
        view.setEnabled(c.id, commandEnabled(c));
        if (c.popup) {
          view.setArrowEnabled(c.id, popups.has(c.id));
        }
      } else if (c.popup) {
        view.setEnabled(c.id, popups.has(c.id) && commandEnabled(c));
      } else if (c.key) {
        const key = doc.getElementById(c.key);
        view.setEnabled(c.id, Boolean(key) && !isDisabled(key));
      }
    }

    let observer = null;

    function syncFocused() {
      for (const c of controls.values()) {
        if (followsFocus(c)) {
          sync(c);
        }
      }
    }

    // Registered capturing, so the focus is back before the entry's own command handler runs.
    function onPopupCommand() {
      returnFocus();
    }

    // From the mail (another document) or a window coming to the front there is no
    // relatedTarget: keep returnTo.
    function onFocusIn(event) {
      const from = event.relatedTarget;
      if (from && !view.root.contains(from)) {
        returnTo = from;
      }
      syncFocused();
    }

    function onFocusOut(event) {
      if (event.relatedTarget && view.root.contains(event.relatedTarget)) {
        return;
      }
      // A window sent to the back keeps returnTo for when it comes back.
      if (doc.hasFocus()) {
        returnTo = null;
      }
      // After Thunderbird has updated its commands for the new focus.
      win.setTimeout(syncFocused, 0);
    }

    function watch() {
      observer = new win.MutationObserver(records => {
        const ids = new Set(records.flatMap(r => watched.get(r.target) || []));
        for (const id of ids) {
          sync(controls.get(id));
        }
      });
      view.root.addEventListener("focusin", onFocusIn);
      view.root.addEventListener("focusout", onFocusOut);
      for (const c of controls.values()) {
        if (followsFocus(c)) {
          popups.get(c.id)?.addEventListener("command", onPopupCommand, true);
        }
        const name = stateCommand(c) || c.key;
        const command = name && doc.getElementById(name);
        if (command) {
          if (!watched.has(command)) {
            watched.set(command, []);
            observer.observe(command, { attributes: true, attributeFilter: ["disabled"] });
          }
          watched.get(command).push(c.id);
        }
        sync(c);
      }
    }

    function doCommand(command) {
      if (FOCUSED_COMMANDS.has(command)) {
        returnFocus();
      }
      // Looked up per call: Thunderbird (and the tests' spy) may replace it.
      page.goDoCommand(command);
    }

    // `extra` is the view's onAction detail: { anchor, arrow, menuItem, double }.
    function run(id, extra = {}) {
      const c = controls.get(id);
      if (!c) {
        return;
      }
      if (extra.menuItem) {
        const item = c.menu?.find(m => m.id === extra.menuItem);
        if (item?.command) {
          doCommand(item.command);
        }
      } else if (extra.arrow) {
        openPopup(c, extra.anchor);
      } else if (c.command) {
        doCommand(c.command);
      } else if (c.popup) {
        openPopup(c, extra.anchor);
      } else if (c.key) {
        // A Thunderbird <key> runs its command handler (oncommand).
        doc.getElementById(c.key)?.doCommand();
      } else if (c.op) {
        engine?.apply(c.op);
      } else if (c.action === "sizeUp" || c.action === "sizeDown") {
        stepSize(c.action === "sizeUp" ? formatting?.nextSize : formatting?.previousSize);
      } else if (c.action === "painter") {
        painter(extra.double);
      }
      // The pickers are the view's and call pick.
    }

    // A double-click arrives after its two clicks started and stopped the painter.
    function painter(double) {
      const paint = engine?.paint;
      if (!paint) {
        return;
      }
      if (double) {
        paint.start(true);
      } else if (paint.active) {
        paint.stop();
      } else {
        paint.start(false);
      }
    }

    // Applies the previewed entry for real (one undo step); true when the engine applied it.
    function pick(id, op) {
      return controls.has(id) && engine ? engine.commitPreview(op) : false;
    }

    function stepSize(step) {
      const pt = engine && step ? engine.formatAt().sizePt : NaN;
      if (Number.isFinite(pt)) {
        engine.apply({ op: "fontSize", value: step(pt) });
      }
    }

    // Each menu is put back on its own, so one that fails keeps none of the others away.
    function destroy() {
      view.root.removeEventListener("focusin", onFocusIn);
      view.root.removeEventListener("focusout", onFocusOut);
      for (const popup of popups.values()) {
        popup.removeEventListener("command", onPopupCommand, true);
      }
      returnTo = null;
      observer?.disconnect();
      watched.clear();
      for (const { popup, parent, next } of moved.reverse()) {
        try {
          if (popup.state !== "closed") {
            popup.hidePopup();
          }
        } catch (e) {
          win.console.error("[qolCompose] could not close a menu", e);
        }
        try {
          parent.insertBefore(popup, next?.parentNode === parent ? next : null);
        } catch (e) {
          win.console.error("[qolCompose] could not put a menu back", e);
        }
      }
      moved.length = 0;
      popups.clear();
    }

    // On failure the caller gets nothing to destroy, so put the menus back here.
    try {
      movePopups();
      watch();
    } catch (e) {
      destroy();
      throw e;
    }

    return { run, pick, destroy };
  }

  return { create };
})();
