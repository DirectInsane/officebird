// Classic script, loaded into the experiment's sandbox. It reports clicks and never runs a command.
"use strict";

var qolRibbonView = (() => {
  const ICONS = "chrome://messenger/skin/icons/";
  const ARROW_ICON = ICONS + "arrow-dropdown.svg";
  const COLLAPSE_ICON = ICONS + "collapse.svg";
  // Gecko drops chrome-only properties from ribbon.css (a moz-extension sheet), not from a style
  // element of the chrome document. On macOS the ribbon hides the toolbar that moves the window; the
  // drag region is drag minus no-drag areas, so only what must stay clickable is no-drag.
  const CHROME_CSS = `
#qol-ribbon img { -moz-context-properties: fill, fill-opacity; }
#qol-ribbon .qol-tabrow { -moz-window-dragging: drag; }
#qol-ribbon .qol-tabrow :is(button, input) { -moz-window-dragging: no-drag; }
#qol-ribbon .qol-panels { -moz-window-dragging: no-drag; }
html[data-qol-ribbon] #titlebar { -moz-window-dragging: drag; }
`;
  const SPLIT_KINDS = ["split", "color", "highlight", "size"];
  const PICKER_KINDS = ["font", "size", "color", "highlight", "gallery", "styleSet"];
  const LIST_KINDS = ["gallery", "styleSet"];
  // Outlook's limits for a typed size.
  const SIZE_MIN = 1;
  const SIZE_MAX = 1638;
  const PREVIEW_DELAY_MS = 250;
  // Kinds with a color bar → their key in state.lastColors.
  const SWATCHES = { color: "text", highlight: "highlight" };
  const GLYPH_CLASSES = { strike: "qol-glyph-strike", subscript: "qol-glyph-sub", superscript: "qol-glyph-sup" };
  // Outlook's two-row groups: these small controls start the second row.
  const ROW_STARTS = ["bold", "f-bold", "align-left"];
  const LABELED_GROUPS = ["clipboard"];
  const DOUBLE_CLICK_ACTIONS = ["painter"];

  // onAction's extra is { anchor } plus `arrow: true` (arrow of a split button without a menu),
  // `menuItem` (an entry of its `menu`) or `double: true` (after the double-click's two clicks).
  function create(win, { definition, labels, lang, mac = false, state = {}, formatting, fontNames, onAction, onPick, onHover, onStateChange, onSetDefault }) {
    const doc = win.document;
    // Thunderbird's globals (gFocusAreas, GetCurrentEditorElement) are hidden behind Xrays from this sandbox.
    const page = win.wrappedJSObject || win;
    const text = key => labels.label(lang, key);
    const controls = new Map();
    const tabs = new Map();
    let selected = definition.tabs[0].id;
    let collapsed = false;
    let open = false;
    let formattingOn = true;
    let popupWatch = null;
    let current = { ...state };

    function el(tag, attrs = {}, ...children) {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, value);
      }
      node.append(...children);
      return node;
    }

    function button(attrs, ...children) {
      // Roving focus: only the selected tab is in the Tab order; arrow keys reach the rest.
      return el("button", { type: "button", tabindex: "-1", ...attrs }, ...children);
    }

    function icon(src, cls = "qol-icon") {
      return el("img", { class: cls, src, alt: "", draggable: "false" });
    }

    // Building

    function buildControl(c, labeled) {
      const label = text(c.label);
      const tipKey = `${c.id}.tip`;
      const tipText = text(tipKey);
      const tip = (tipText === tipKey ? label : tipText) + (c.shortcut ? ` (${labels.shortcut(c.shortcut, mac)})` : "");
      const attrs = {
        class: `qol-btn qol-${c.size}`,
        "data-control-id": c.id,
        "data-kind": c.kind,
        "aria-label": label,
        title: tip,
      };
      const main = c.kind === "size"
        ? el("input", { ...attrs, type: "text", tabindex: "-1", inputmode: "decimal", autocomplete: "off", spellcheck: "false" })
        : button(attrs);
      if (c.kind === "toggle") {
        main.setAttribute("aria-pressed", "false");
      }

      let figure = null;
      let swatch = null;
      if (c.icon) {
        figure = icon(c.icon);
      } else if (c.glyph) {
        figure = el("span", { class: `qol-glyph ${GLYPH_CLASSES[c.op?.op] || ""}`.trim(), "aria-hidden": "true" }, c.glyph);
      } else if (c.kind === "gallery") {
        figure = el("span", { class: "qol-glyph qol-glyph-sample", "aria-hidden": "true" }, "AaBb");
      }
      if (SWATCHES[c.kind]) {
        swatch = el("span", { class: "qol-swatch", "aria-hidden": "true" });
        figure = el("span", { class: "qol-figure" }, ...(figure ? [figure] : []), swatch);
      }
      if (figure) {
        main.append(figure);
      }
      if (c.kind === "font") {
        main.append(el("span", { class: "qol-value" }), icon(ARROW_ICON, "qol-icon qol-drop"));
        main.setAttribute("aria-haspopup", "menu");
      }
      if (c.size === "large" || labeled) {
        main.append(el("span", { class: "qol-label" }, label));
      }
      if (LIST_KINDS.includes(c.kind)) {
        main.append(icon(ARROW_ICON, "qol-icon qol-drop"));
        main.setAttribute("aria-haspopup", "menu");
      }
      if (c.popup && !c.command) {
        main.setAttribute("aria-haspopup", "menu");
      }

      const entry = { def: c, label, tip, main, arrow: null, popup: null, swatch, enabled: true, arrowEnabled: true, value: "", editing: false };
      controls.set(c.id, entry);
      if (c.kind === "size") {
        listenToSizeField(entry);
      }
      if (!SPLIT_KINDS.includes(c.kind)) {
        return main;
      }
      const more = `${label}: ${text("ribbon.more")}`;
      entry.arrow = button(
        { class: `qol-arrow qol-${c.size}`, "data-arrow-for": c.id, "aria-label": more, "aria-haspopup": "menu", title: more },
        icon(ARROW_ICON),
      );
      const field = c.kind === "size" ? " qol-field" : "";
      return el("span", { class: `qol-split qol-${c.size}${field}` }, main, entry.arrow);
    }

    function buildGroup(g) {
      const labeled = LABELED_GROUPS.includes(g.id);
      const body = el("div", { class: "qol-group-body" });
      let stack = null;
      let row = null;
      for (const c of g.controls) {
        const node = buildControl(c, labeled);
        if (c.size === "large") {
          body.append(node);
          stack = row = null;
          continue;
        }
        if (!stack) {
          stack = el("div", { class: "qol-stack" });
          body.append(stack);
          row = null;
        }
        if (!row || labeled || ROW_STARTS.includes(c.id)) {
          row = el("div", { class: "qol-row" });
          stack.append(row);
        }
        row.append(node);
      }
      const name = text(g.label);
      return el(
        "div",
        { class: "qol-group", role: "group", "aria-label": name, "data-group": g.id },
        body,
        el("div", { class: "qol-group-label", "aria-hidden": "true" }, name),
      );
    }

    const root = el("div", { id: "qol-ribbon", class: "qol-ribbon" });
    root.append(el("style", {}, CHROME_CSS));
    const tabRow = el("div", { class: "qol-tabrow" });
    const quickAccess = el("div", { class: "qol-qa", role: "toolbar", "aria-label": text("ribbon.quickAccess") });
    for (const c of definition.quickAccess) {
      quickAccess.append(buildControl(c, true));
    }
    const tabList = el("div", { class: "qol-tablist", role: "tablist" });
    const collapseButton = button({ class: "qol-collapse" }, icon(COLLAPSE_ICON));
    const panels = el("div", { class: "qol-panels" });
    for (const t of definition.tabs) {
      const tab = button(
        { role: "tab", id: `qol-tab-${t.id}`, "data-tab": t.id, "aria-controls": `qol-panel-${t.id}` },
        text(t.label),
      );
      const panel = el("div", {
        class: "qol-panel",
        role: "tabpanel",
        id: `qol-panel-${t.id}`,
        "data-tab": t.id,
        "aria-labelledby": tab.id,
      });
      panel.append(...t.groups.map(buildGroup));
      tabList.append(tab);
      panels.append(panel);
      tabs.set(t.id, { tab, panel });
    }
    tabRow.append(quickAccess, tabList, el("div", { class: "qol-spacer" }), collapseButton);
    root.append(tabRow, panels);

    // State

    function selectTab(id) {
      if (!tabs.has(id)) {
        return;
      }
      selected = id;
      for (const [tabId, { tab, panel }] of tabs) {
        const on = tabId === id;
        tab.setAttribute("aria-selected", String(on));
        tab.setAttribute("tabindex", on ? "0" : "-1");
        panel.hidden = !on;
      }
    }

    function renderCollapsed() {
      root.toggleAttribute("data-collapsed", collapsed);
      root.toggleAttribute("data-open", open);
      const name = text(collapsed ? "ribbon.expand" : "ribbon.collapse");
      collapseButton.setAttribute("aria-label", name);
      collapseButton.setAttribute("title", name);
      collapseButton.setAttribute("aria-expanded", String(!collapsed));
    }

    function setCollapsed(value) {
      value = Boolean(value);
      if (value === collapsed) {
        return;
      }
      collapsed = value;
      closeOverlay();
      onStateChange?.({ collapsed });
    }

    function refresh(entry) {
      const blocked = entry.def.formatting && !formattingOn;
      const tip = blocked ? text("hint.plainText") : entry.tip;
      entry.main.disabled = blocked || !entry.enabled;
      if (entry.arrow) {
        entry.arrow.disabled = blocked || !entry.enabled || !entry.arrowEnabled;
      }
      entry.main.setAttribute("title", tip);
    }

    // Overlay: the collapsed ribbon shown over the mail

    function openOverlay() {
      if (collapsed && !open) {
        open = true;
        renderCollapsed();
      }
    }

    function unwatchPopup() {
      if (popupWatch) {
        popupWatch.popup.removeEventListener("popuphidden", popupWatch.listener);
        popupWatch = null;
      }
    }

    function closeOverlay({ refocus = true } = {}) {
      unwatchPopup();
      const hadFocus = open && panels.contains(doc.activeElement);
      open = false;
      renderCollapsed();
      // Keep keyboard focus out of the hidden panel.
      if (refocus && hadFocus && collapsed) {
        tabs.get(selected).tab.focus();
      }
    }

    function watchPopup(popup) {
      if (!open) {
        return;
      }
      unwatchPopup();
      const listener = event => {
        if (event.target === popup) {
          closeOverlay();
        }
      };
      popupWatch = { popup, listener };
      popup.addEventListener("popuphidden", listener);
    }

    function afterAction(popup = null) {
      if (!open) {
        return;
      }
      if (!popup) {
        closeOverlay();
        return;
      }
      watchPopup(popup);
      // A menu whose popupshowing was cancelled never opens, nor hides.
      win.setTimeout(() => {
        if (popupWatch?.popup === popup && popup.state === "closed") {
          closeOverlay();
        }
      }, 0);
    }

    function act(id, extra) {
      // Thunderbird opens its menus synchronously: the popup shown during
      // the action is the one it opened.
      let shown = null;
      const onShowing = event => {
        if (!shown && ["menupopup", "panel"].includes(event.target.localName)) {
          shown = event.target;
        }
      };
      doc.addEventListener("popupshowing", onShowing, true);
      try {
        onAction?.(id, extra);
      } catch (e) {
        win.console.error("[qolCompose] action failed", id, e);
      } finally {
        doc.removeEventListener("popupshowing", onShowing, true);
      }
      afterAction(shown);
    }

    function showMenu(entry) {
      if (!entry.popup) {
        const popup = doc.createXULElement("menupopup");
        popup.setAttribute("class", "qol-menu");
        for (const m of entry.def.menu) {
          const item = doc.createXULElement("menuitem");
          item.setAttribute("label", text(m.label));
          item.setAttribute("data-menu-item", m.id);
          if (m.icon) {
            item.setAttribute("class", "menuitem-iconic");
            item.setAttribute("image", m.icon);
          }
          popup.append(item);
        }
        popup.addEventListener("command", event => {
          const menuItem = event.target.getAttribute("data-menu-item");
          if (menuItem) {
            act(entry.def.id, { anchor: entry.arrow, menuItem });
          }
        });
        root.append(popup);
        entry.popup = popup;
      }
      entry.popup.openPopup(entry.arrow, "after_start");
      watchPopup(entry.popup);
    }

    // Pickers

    const entryOps = new WeakMap();
    let fontList = null;
    let colorInput = null;
    let colorFor = null;
    let hoverTimer = null;

    function lastColors() {
      return { ...formatting.DEFAULT_COLORS, ...current.lastColors };
    }

    function renderSwatches() {
      const colors = lastColors();
      for (const entry of controls.values()) {
        if (entry.swatch) {
          entry.swatch.style.backgroundColor = colors[SWATCHES[entry.def.kind]];
        }
      }
    }

    function changeState(partial) {
      current = { ...current, ...partial };
      renderSwatches();
      onStateChange?.(partial);
    }

    function remember(op) {
      if (op.op === "fontFamily") {
        const recentFonts = formatting.pushRecent(current.recentFonts, op.value);
        if (recentFonts.join("\n") !== (current.recentFonts || []).join("\n")) {
          changeState({ recentFonts });
        }
        return;
      }
      // "No color" keeps the last highlight color.
      const key = op.op === "color" ? "text" : op.op === "highlight" && op.value ? "highlight" : null;
      if (key && lastColors()[key] !== op.value) {
        changeState({ lastColors: { ...lastColors(), [key]: op.value } });
      }
    }

    function pick(id, op) {
      stopHoverTimer();
      let applied = false;
      try {
        applied = Boolean(onPick?.(id, op));
      } catch (e) {
        win.console.error("[qolCompose] pick failed", id, e);
      }
      if (applied) {
        remember(op);
      }
      afterAction();
      return applied;
    }

    function stopHoverTimer() {
      if (hoverTimer !== null) {
        win.clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }

    function reportHover(id, op) {
      try {
        onHover?.(id, op);
      } catch (e) {
        win.console.error("[qolCompose] hover failed", id, e);
      }
    }

    function hover(id, op) {
      stopHoverTimer();
      // A preview lasts only while its own entry is active.
      reportHover(id, null);
      if (op) {
        hoverTimer = win.setTimeout(() => {
          hoverTimer = null;
          reportHover(id, op);
        }, PREVIEW_DELAY_MS);
      }
    }

    function getFontNames() {
      fontList ??= Promise.resolve(fontNames ? fontNames() : []).catch(e => {
        win.console.error("[qolCompose] font list unavailable", e);
        return [];
      });
      return fontList;
    }

    function menuItem(label, op, attrs = {}) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", label);
      for (const [name, value] of Object.entries(attrs)) {
        item.setAttribute(name, value);
      }
      if (op) {
        entryOps.set(item, op);
      }
      return item;
    }

    // Disabled, so keyboard navigation skips it.
    function caption(key) {
      return menuItem(text(key), null, { class: "qol-caption", disabled: "true" });
    }

    // XUL menus walk into menugroups with the arrow keys.
    function swatchRows(rows, opName) {
      return rows.map(colors => {
        const row = doc.createXULElement("menugroup");
        row.setAttribute("class", "qol-swatches");
        for (const color of colors) {
          const item = menuItem(color, { op: opName, value: color }, { class: "qol-color", tooltiptext: color });
          item.style.backgroundColor = color;
          row.append(item);
        }
        return row;
      });
    }

    function fontItem(name, recent) {
      return menuItem(name, { op: "fontFamily", value: name }, recent ? { "data-recent": "true" } : {});
    }

    const FILL = {
      async font(popup) {
        if (!popup.hasChildNodes()) {
          const names = await getFontNames();
          popup.append(caption("menu.allFonts"), ...names.map(name => fontItem(name, false)));
        }
        for (const node of popup.querySelectorAll("[data-recent]")) {
          node.remove();
        }
        const recent = current.recentFonts || [];
        if (recent.length) {
          const separator = doc.createXULElement("menuseparator");
          separator.setAttribute("data-recent", "true");
          popup.prepend(
            menuItem(text("menu.recentFonts"), null, { class: "qol-caption", disabled: "true", "data-recent": "true" }),
            ...recent.map(name => fontItem(name, true)),
            separator,
          );
        }
      },
      size(popup) {
        if (!popup.hasChildNodes()) {
          popup.append(...formatting.SIZES.map(pt => menuItem(String(pt), { op: "fontSize", value: pt })));
        }
      },
      color(popup) {
        if (!popup.hasChildNodes()) {
          // TEXT_THEME has one column per hue; the menu shows one row per shade.
          const shades = formatting.TEXT_THEME[0].map((_, shade) => formatting.TEXT_THEME.map(column => column[shade]));
          popup.append(
            caption("color.theme"),
            ...swatchRows(shades, "color"),
            caption("color.standard"),
            ...swatchRows([formatting.TEXT_STANDARD], "color"),
            doc.createXULElement("menuseparator"),
            menuItem(text("color.custom"), null, { "data-action": "more-colors" }),
          );
        }
      },
      highlight(popup) {
        if (!popup.hasChildNodes()) {
          const colors = formatting.HIGHLIGHTS;
          const rows = [0, 5, 10].map(start => colors.slice(start, start + 5));
          popup.append(
            ...swatchRows(rows, "highlight"),
            doc.createXULElement("menuseparator"),
            menuItem(text("color.none"), { op: "highlight", value: null }, { "data-action": "no-color" }),
          );
        }
      },
      gallery(popup, entry) {
        if (!popup.hasChildNodes()) {
          for (const key of formatting.STYLE_KEYS) {
            const item = menuItem(text(`style.${key}`), { op: "style", value: key }, { class: "qol-style", "data-value": key });
            // Shown in its own look, without the block's spacing.
            item.style.cssText = formatting.STYLES[key].style;
            item.style.margin = "";
            popup.append(item);
          }
        }
        for (const item of popup.children) {
          item.toggleAttribute("data-current", item.getAttribute("data-value") === entry.value);
        }
      },
      styleSet(popup, entry) {
        if (!popup.hasChildNodes()) {
          popup.append(
            ...formatting.STYLE_SET_KEYS.map(key =>
              menuItem(text(`styleset.${key}`), { op: "styleSet", value: key }, { "data-value": key, type: "radio" })),
            doc.createXULElement("menuseparator"),
            menuItem(text("styleset.setDefault"), null, { "data-action": "set-default", tooltiptext: text("styleset.setDefault.tip") }),
          );
        }
        // Setting a radio item's checked attribute, even to "false", unchecks its
        // siblings, so the others lose the attribute instead.
        for (const item of popup.children) {
          if (item.getAttribute("data-value") !== entry.value) {
            item.removeAttribute("checked");
          }
        }
        popup.querySelector(`menuitem[data-value="${entry.value}"]`)?.setAttribute("checked", "true");
      },
    };

    function pickerPopup(entry) {
      if (entry.popup) {
        return entry.popup;
      }
      const id = entry.def.id;
      const popup = doc.createXULElement("menupopup");
      popup.setAttribute("class", `qol-picker qol-picker-${entry.def.kind}`);
      popup.setAttribute("data-picker-for", id);
      popup.addEventListener("command", event => {
        const item = event.target;
        if (item.getAttribute("data-action") === "more-colors") {
          moreColors(id);
        } else if (item.getAttribute("data-action") === "set-default") {
          onSetDefault?.(id);
        } else if (entryOps.has(item)) {
          pick(id, entryOps.get(item));
        }
      });
      popup.addEventListener("DOMMenuItemActive", event => hover(id, entryOps.get(event.target) ?? null));
      popup.addEventListener("DOMMenuItemInactive", () => hover(id, null));
      popup.addEventListener("popuphidden", event => {
        if (event.target === popup) {
          hover(id, null);
        }
      });
      // Keeps the focus and the selection in the editor, as on the ribbon's buttons.
      popup.addEventListener("mousedown", event => event.preventDefault());
      root.append(popup);
      entry.popup = popup;
      return popup;
    }

    async function openPicker(entry) {
      const popup = pickerPopup(entry);
      if (popup.state !== "closed") {
        return;
      }
      watchPopup(popup);
      try {
        await FILL[entry.def.kind](popup, entry);
      } catch (e) {
        win.console.error("[qolCompose] picker not filled", entry.def.id, e);
      }
      if (!root.isConnected) {
        return;
      }
      // Split controls and the size field line up with their whole box.
      const anchor = entry.arrow ? entry.main.parentNode : entry.main;
      popup.openPopup(anchor, "after_start");
    }

    function moreColors(id) {
      if (!colorInput) {
        colorInput = el("input", { type: "color", class: "qol-color-input", tabindex: "-1", "aria-hidden": "true" });
        colorInput.hidden = true;
        // "change" fires once the picker closes; "input" fires for every change on the way.
        colorInput.addEventListener("change", () => {
          if (colorFor) {
            pick(colorFor, { op: "color", value: colorInput.value });
          }
        });
        root.append(colorInput);
      }
      colorFor = id;
      colorInput.value = lastColors().text;
      try {
        // The user chose the menu entry; that gesture is spent closing the
        // menu, so it is passed on explicitly.
        doc.notifyUserGestureActivation();
        colorInput.showPicker();
      } catch (e) {
        win.console.error("[qolCompose] color picker failed", e);
      }
    }

    // The size field

    function sizeText(pt) {
      return String(pt);
    }

    function listenToSizeField(entry) {
      const field = entry.main;
      const revert = () => {
        entry.editing = false;
        field.value = entry.value;
      };
      const commit = () => {
        const typed = field.value.trim().replace(",", ".");
        const pt = Math.round(parseFloat(typed) * 2) / 2;
        if (!/^\d+(\.\d+)?$/.test(typed) || !(pt >= SIZE_MIN && pt <= SIZE_MAX)) {
          revert();
          field.select();
          return;
        }
        entry.editing = false;
        setValue(entry.def.id, sizeText(pt));
        pick(entry.def.id, { op: "fontSize", value: pt });
        focusEditor();
      };
      field.addEventListener("input", () => {
        entry.editing = true;
      });
      field.addEventListener("focus", () => field.select());
      field.addEventListener("blur", () => {
        if (entry.editing) {
          revert();
        }
      });
      field.addEventListener("keydown", event => {
        if (event.altKey || event.ctrlKey || event.metaKey) {
          return;
        }
        switch (event.key) {
          case "Enter":
            commit();
            break;
          case "Escape":
            revert();
            return; // the ribbon closes the overlay and returns to the editor
          case "ArrowLeft":
          case "ArrowRight": {
            // Inside the text the arrow keys move the caret; at its edge, through the ribbon.
            const edge = event.key === "ArrowLeft" ? 0 : field.value.length;
            if (field.selectionStart !== edge || field.selectionEnd !== edge) {
              event.stopPropagation();
            }
            return;
          }
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
      });
    }

    // value: a font name, a size, or a style / style set key (shown by name).
    function setValue(id, value) {
      const entry = controls.get(id);
      if (!entry) {
        return;
      }
      value = String(value ?? "");
      entry.value = value;
      let shown = value;
      if (entry.def.kind === "size") {
        // Typing wins until Enter or Esc; an unchanged value keeps the
        // field's selection.
        if (!entry.editing && entry.main.value !== value) {
          entry.main.value = value;
        }
      } else if (entry.def.kind === "gallery") {
        shown = value && text(`style.${value}`);
      } else if (entry.def.kind === "styleSet") {
        shown = value && text(`styleset.${value}`);
      } else {
        const field = entry.main.querySelector(".qol-value");
        if (!field) {
          return;
        }
        field.textContent = value;
      }
      entry.main.setAttribute("aria-label", shown ? `${entry.label}: ${shown}` : entry.label);
    }

    // Events

    function onMouseDown(event) {
      // Clicking the ribbon leaves the focus (and the selection) in the editor.
      if (event.button === 0 && event.target.closest("button")) {
        event.preventDefault();
      }
    }

    function onClick(event) {
      const target = event.target.closest("button");
      if (!target || !root.contains(target) || target.disabled) {
        return;
      }
      if (target.getAttribute("role") === "tab") {
        selectTab(target.dataset.tab);
        openOverlay();
      } else if (target === collapseButton) {
        setCollapsed(!collapsed);
      } else if (target.dataset.arrowFor) {
        const entry = controls.get(target.dataset.arrowFor);
        if (PICKER_KINDS.includes(entry.def.kind)) {
          openPicker(entry);
        } else if (entry.def.menu?.length) {
          showMenu(entry);
        } else {
          act(entry.def.id, { anchor: target, arrow: true });
        }
      } else if (target.dataset.controlId) {
        const entry = controls.get(target.dataset.controlId);
        const kind = entry.def.kind;
        if (SWATCHES[kind]) {
          pick(entry.def.id, { op: kind, value: lastColors()[SWATCHES[kind]] });
        } else if (PICKER_KINDS.includes(kind)) {
          openPicker(entry);
        } else {
          act(entry.def.id, { anchor: target });
        }
      }
    }

    function onDblClick(event) {
      const tab = event.target.closest('[role="tab"]');
      // The clicks before the double-click already selected the tab.
      if (tab && root.contains(tab)) {
        setCollapsed(!collapsed);
        return;
      }
      const target = event.target.closest("button[data-control-id]");
      const entry = target && root.contains(target) && !target.disabled ? controls.get(target.dataset.controlId) : null;
      if (entry && DOUBLE_CLICK_ACTIONS.includes(entry.def.action)) {
        act(entry.def.id, { anchor: target, double: true });
      }
    }

    function focusables(container) {
      return [...container.querySelectorAll("button, input")].filter(b => !b.disabled && b.checkVisibility());
    }

    function focusEditor() {
      try {
        page.GetCurrentEditorElement().focus();
      } catch (e) {
        win.console.error("[qolCompose] could not focus the editor", e);
      }
    }

    function onKeyDown(event) {
      const target = event.target;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || target.closest("menupopup")) {
        return;
      }
      const inTabRow = tabRow.contains(target);
      // Down from a tab enters that tab's panel.
      if (event.key === "ArrowDown" && target.getAttribute("role") === "tab") {
        selectTab(target.dataset.tab);
      }
      const panel = tabs.get(selected).panel;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          const list = focusables(inTabRow ? tabRow : panel);
          const index = list.indexOf(target);
          if (index < 0) {
            return;
          }
          const rtl = win.getComputedStyle(root).direction === "rtl";
          const step = (event.key === "ArrowRight") !== rtl ? 1 : -1;
          list[(index + step + list.length) % list.length].focus();
          break;
        }
        case "ArrowDown":
          if (!inTabRow) {
            return;
          }
          openOverlay();
          focusables(panel)[0]?.focus();
          break;
        case "ArrowUp":
          if (inTabRow) {
            return;
          }
          tabs.get(selected).tab.focus();
          break;
        case "Enter":
        case " ":
          if (target.localName !== "button") {
            return;
          }
          target.click();
          break;
        case "Escape":
          closeOverlay();
          focusEditor();
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    }

    function onWindowMouseDown(event) {
      const target = event.target;
      // Menus opened from the overlay close it themselves (afterAction).
      if (open && !root.contains(target) && !target.closest?.("menupopup, panel, tooltip")) {
        closeOverlay();
      }
    }

    function onFocusOut(event) {
      // Tab, Shift+Tab or F6 out of the ribbon: the open panel would cover
      // the field that gets the focus. Menus opened from it keep it open.
      const next = event.relatedTarget;
      if (open && !(next && (root.contains(next) || next.closest?.("menupopup, panel")))) {
        closeOverlay({ refocus: false });
      }
    }

    root.addEventListener("mousedown", onMouseDown);
    root.addEventListener("click", onClick);
    root.addEventListener("dblclick", onDblClick);
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("focusout", onFocusOut);
    win.addEventListener("mousedown", onWindowMouseDown, true);

    // F6: the ribbon is the first of Thunderbird's focus areas.
    const area = {
      root,
      focus: () => {
        tabs.get(selected).tab.focus();
        return true;
      },
    };
    if (Array.isArray(page.gFocusAreas)) {
      page.gFocusAreas.unshift(area);
    }

    collapsed = Boolean(state.collapsed);
    selectTab(selected);
    renderCollapsed();
    renderSwatches();

    return {
      root,
      get collapsed() {
        return collapsed;
      },
      selectTab,
      setCollapsed,
      control: id => controls.get(id)?.main ?? null,
      setEnabled(id, on) {
        const entry = controls.get(id);
        if (entry) {
          entry.enabled = Boolean(on);
          refresh(entry);
        }
      },
      setArrowEnabled(id, on) {
        const entry = controls.get(id);
        if (entry?.arrow) {
          entry.arrowEnabled = Boolean(on);
          refresh(entry);
        }
      },
      setPressed(id, on) {
        controls.get(id)?.main.setAttribute("aria-pressed", String(Boolean(on)));
      },
      setValue,
      valueOf: id => controls.get(id)?.value ?? "",
      setFormattingEnabled(on) {
        formattingOn = Boolean(on);
        for (const entry of controls.values()) {
          refresh(entry);
        }
      },
      pick,
      /** @returns {Promise<string[]>} */
      fontNames: getFontNames,
      updateState(state) {
        current = { ...current, ...state };
        renderSwatches();
      },
      destroy() {
        stopHoverTimer();
        colorFor = null;
        closeOverlay();
        for (const entry of controls.values()) {
          entry.popup?.hidePopup();
        }
        win.removeEventListener("mousedown", onWindowMouseDown, true);
        const areas = page.gFocusAreas;
        const index = Array.isArray(areas) ? areas.findIndex(a => a.root === root) : -1;
        if (index >= 0) {
          areas.splice(index, 1);
        }
        root.remove();
      },
    };
  }

  return { create };
})();
