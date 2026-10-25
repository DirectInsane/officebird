// Classic script, not a module: the experiment loads it into a sandbox after query.js,
// terms.js, panelmodel.js and labels.js.
// Builds the search field, the filter panel below it and the result chips below the list
// header. DOM only through createElement and textContent.
"use strict";

var qolSearchPanel = (() => {
  const HTML = "http://www.w3.org/1999/xhtml";
  const ICONS = "chrome://messenger/skin/icons/new/compact/";
  // Gecko drops chrome-only properties from moz-extension sheets like search.css.
  const CHROME_CSS = `
#qol-search img { -moz-context-properties: fill, stroke; fill: currentColor; stroke: currentColor; }
`;
  const CHIP_ROWS = [
    ["from", "from", "phName"],
    ["to", "to", "phName"],
    ["subject", "subject", "phWords"],
    ["body", "contains", "phWords"],
  ];
  // Rows key -> query fields, for the "or" marker of an OR the row cannot show.
  const ROW_FIELDS = {
    from: ["from"], to: ["to"], subject: ["subject"], body: ["body"], date: ["after", "before"],
    folder: ["in"], tags: ["tag"], flags: ["attachment", "unread", "flagged"],
  };
  const FLAGS = [
    ["attachment", "attachments"],
    ["unread", "unread"],
    ["flagged", "flagged"],
  ];
  const SUGGESTIONS = 8;

  function emptyRows() {
    return qolSearchPanelModel.rowsFromQuery({ and: [] });
  }

  function hasCriteria(rows) {
    return (
      ["from", "to", "subject", "body", "folder", "tags"].some((key) => rows[key].length) ||
      Boolean(rows.after || rows.before) ||
      FLAGS.some(([key]) => rows[key] !== "any")
    );
  }

  // A typed chip: "-word" excludes, quotes make a phrase.
  function chipFromText(text, orBefore) {
    let value = text.trim();
    let negated = false;
    if (value.length > 1 && value.startsWith("-")) {
      negated = true;
      value = value.slice(1);
    }
    let phrase = false;
    if (value.startsWith('"')) {
      phrase = true;
      value = value.replace(/^"|"$/g, "");
    }
    return value ? { value, negated, phrase, orBefore } : null;
  }

  // Inside an open quote a space belongs to the phrase.
  function inOpenQuote(text) {
    const value = text.replace(/^-/, "");
    return value.startsWith('"') && !/^"[^"]*"$/.test(value);
  }

  function install(
    win,
    { lang, sheetURL, defaultScope = () => "folder", tipShown = () => false, onSearch, onEnd, onScope, onTurnOnIndex, onDismissNotice }
  ) {
    // Lets the integration tests make a hook fail.
    if (win.__qolSearchFail) {
      throw new Error("search hook failure (test)");
    }
    const doc = win.document;
    const { MailServices } = win.ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const text = (key, vars) => qolSearchLabels.label(lang, key, vars);
    const sheetWindows = new Set();

    function el(ownerDoc, tag, attrs = {}, ...children) {
      const node = ownerDoc.createElementNS(HTML, tag);
      for (const [name, value] of Object.entries(attrs)) {
        if (name === "class") node.className = value;
        else node.setAttribute(name, value);
      }
      node.append(...children);
      return node;
    }
    const h = (tag, attrs, ...children) => el(doc, tag, attrs, ...children);

    function loadSheet(target) {
      if (!sheetURL || sheetWindows.has(target)) return;
      target.windowUtils.loadSheetUsingURIString(sheetURL, target.windowUtils.AUTHOR_SHEET);
      sheetWindows.add(target);
    }

    // Field

    const input = h("input", { class: "qol-search-input", type: "text", placeholder: text("placeholder"), "aria-label": text("placeholder") });
    const clearButton = h("button", { class: "qol-search-clear", type: "button", title: text("clearField") }, h("img", { src: ICONS + "close.svg", alt: "" }));
    const filterButton = h("button", { class: "qol-search-filter", type: "button", title: text("filters"), "aria-haspopup": "dialog" }, h("img", { src: ICONS + "filter.svg", alt: "" }));
    const root = h(
      "div",
      { id: "qol-search", class: "qol-search", role: "search" },
      h("style", {}, CHROME_CSS),
      h("img", { class: "qol-search-icon", src: ICONS + "search.svg", alt: "" }),
      input,
      clearButton,
      filterButton
    );

    function updateField() {
      clearButton.hidden = !input.value;
      let criteria = false;
      try {
        criteria = hasCriteria(qolSearchPanelModel.rowsFromQuery(qolSearchQuery.parse(input.value)));
      } catch (e) {
        win.console.warn("officebird search: query not read", e);
      }
      filterButton.classList.toggle("active", criteria);
    }

    function search(query) {
      if (query.trim()) onSearch(query.trim(), currentScope());
      else onEnd();
    }

    function clearField() {
      input.value = "";
      updateField();
      onEnd();
    }

    input.addEventListener("input", updateField);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        search(input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        clearField();
      }
    });
    clearButton.addEventListener("click", () => {
      clearField();
      input.focus();
    });
    filterButton.addEventListener("click", () => openPanel());

    // Panel

    let rows = emptyRows();
    // An untouched panel leaves the field's text as it is (it may say more than the rows).
    let edited = false;
    // The scope of the tab's shown results; without results the default scope, read anew
    // each time so a changed setting applies to the next search.
    let scope = null;
    const currentScope = () => scope ?? defaultScope();
    const chipInputs = [];
    const renders = [];

    function changed() {
      edited = true;
      renderPanel();
    }

    function folderInfos() {
      const infos = [];
      for (const folder of MailServices.accounts.allFolders) {
        if (folder.isServer) continue;
        infos.push({ uri: folder.URI, name: folder.localizedName, account: folder.server.prettyName });
      }
      return infos;
    }

    function folderError(chip) {
      return qolSearchTerms.matchFolders(folderInfos(), chip.value).length ? null : text("unknownFolder", { name: chip.value });
    }

    function chipElement(chip, onToggle, error) {
      const button = h("button", { class: "qol-chip", type: "button", title: error || text(chip.negated ? "chipInclude" : "chipExclude") });
      button.classList.toggle("excluded", chip.negated);
      button.classList.toggle("error", Boolean(error));
      if (chip.negated) button.append(h("span", { class: "qol-chip-minus", "aria-hidden": "true" }, "−"));
      button.append(chip.phrase ? `"${chip.value}"` : chip.value);
      button.addEventListener("click", onToggle);
      return button;
    }

    // A term-chip input for one rows key; `suggest` lists completions for the typed text.
    function chipInput(key, placeholderKey, { validate = null, suggest = null } = {}) {
      const list = h("span", { class: "qol-chip-list" });
      const entry = h("input", { type: "text", placeholder: text(placeholderKey) });
      const box = h("div", { class: "qol-chips" }, list, entry);
      const suggestions = h("div", { class: "qol-suggest", hidden: "hidden" });
      let pendingOr = false;

      function commit(value) {
        const typed = (value ?? entry.value).trim();
        entry.value = "";
        suggestions.hidden = true;
        if (typed === "OR" || typed === "ODER") {
          pendingOr = rows[key].length > 0;
          return;
        }
        const chip = chipFromText(typed, pendingOr && rows[key].length > 0);
        pendingOr = false;
        if (!chip) return;
        rows[key].push(chip);
        changed();
      }

      function render() {
        list.replaceChildren();
        rows[key].forEach((chip, index) => {
          if (index > 0) {
            const gap = h("span", { class: "qol-chip-gap", role: "button" }, chip.orBefore ? text("or") : "");
            gap.classList.toggle("or", chip.orBefore);
            gap.addEventListener("click", () => {
              chip.orBefore = !chip.orBefore;
              changed();
            });
            list.append(gap);
          }
          const error = validate ? validate(chip) : null;
          list.append(
            chipElement(chip, () => {
              chip.negated = !chip.negated;
              changed();
            }, error)
          );
        });
      }

      function showSuggestions() {
        if (!suggest) return;
        const typed = entry.value.trim().toLowerCase();
        const names = typed ? suggest(typed) : [];
        suggestions.replaceChildren(
          ...names.map((name) => {
            const button = h("button", { type: "button" }, name);
            // Keeps the focus (and the typed text) in the input.
            button.addEventListener("mousedown", (event) => event.preventDefault());
            button.addEventListener("click", () => {
              commit(name);
              entry.focus();
            });
            return button;
          })
        );
        suggestions.hidden = !names.length;
      }

      entry.addEventListener("input", showSuggestions);
      entry.addEventListener("keydown", (event) => {
        if (event.key === " " && entry.value.trim() && !inOpenQuote(entry.value)) {
          event.preventDefault();
          commit();
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (entry.value.trim()) commit();
          else runPanel();
        } else if (event.key === "Tab" && !event.shiftKey && entry.value.trim()) {
          event.preventDefault();
          commit();
        } else if (event.key === "Backspace" && !entry.value && rows[key].length) {
          event.preventDefault();
          rows[key].pop();
          changed();
        }
      });
      box.addEventListener("click", (event) => {
        if (event.target === box || event.target === list) entry.focus();
      });

      chipInputs.push({ entry, commit, reset: () => (pendingOr = false) });
      renders.push(render);
      return suggest ? h("div", { class: "qol-panel-field" }, box, suggestions) : box;
    }

    // Marks a row whose terms take part in an OR it cannot show: one across fields, or
    // one between tags, whose buttons have no "or" between them.
    function orMarker(key) {
      const marker = h("span", { class: "qol-row-or", hidden: "hidden" }, text("or"));
      renders.push(() => {
        const cross = ROW_FIELDS[key].some((field) => rows.crossOr.includes(field));
        marker.hidden = !(cross || (key === "tags" && rows.tags.some((chip) => chip.orBefore)));
      });
      return marker;
    }

    // The row's two grid cells, in a wrapper that does not take part in the layout.
    function rowElement(key, labelKey, control) {
      const label = h("span", { class: "qol-panel-label" }, text(labelKey), " ", orMarker(key));
      return h("div", { class: "qol-panel-row", "data-row": key }, label, control);
    }

    function dateInput(key) {
      const date = h("input", { type: "date", class: `qol-date-${key}` });
      date.addEventListener("change", () => {
        rows[key] = date.value ? { value: date.value, negated: false, phrase: false, orBefore: false } : null;
        changed();
      });
      renders.push(() => {
        const chip = rows[key];
        date.value = chip && !chip.error ? chip.value : "";
        date.classList.toggle("error", Boolean(chip?.error));
        if (chip?.error) date.title = text("badDate");
        else date.removeAttribute("title");
      });
      return date;
    }

    function tagsControl() {
      const box = h("div", { class: "qol-panel-line" });
      renders.push(() => {
        const tags = MailServices.tags.getAllTags();
        const known = (chip) => {
          const [key] = qolSearchTerms.matchTags(tags, chip.value);
          return tags.find((tag) => tag.key === key);
        };
        const buttons = tags.map((tag) => {
          const chip = rows.tags.find((c) => known(c) === tag);
          const button = h("button", { class: "qol-chip qol-tag", type: "button", "data-key": tag.key }, tag.tag);
          button.classList.toggle("off", !chip);
          button.classList.toggle("excluded", Boolean(chip?.negated));
          // Off, then must have, then must not have.
          button.addEventListener("click", () => {
            if (!chip) rows.tags.push({ value: tag.tag, negated: false, phrase: false, orBefore: false });
            else if (!chip.negated) chip.negated = true;
            else rows.tags.splice(rows.tags.indexOf(chip), 1);
            changed();
          });
          return button;
        });
        // Tags typed in the field that Thunderbird does not know.
        const unknown = rows.tags.filter((chip) => !known(chip)).map((chip) =>
          chipElement(chip, () => {
            rows.tags.splice(rows.tags.indexOf(chip), 1);
            changed();
          })
        );
        box.replaceChildren(...buttons, ...unknown);
      });
      return box;
    }

    function flagsControl() {
      const box = h("div", { class: "qol-panel-line" });
      for (const [key, labelKey] of FLAGS) {
        const mark = h("span", { class: "qol-flag-box", "aria-hidden": "true" });
        const button = h("button", { class: "qol-flag", type: "button", role: "checkbox", "data-flag": key }, mark, text(labelKey));
        button.addEventListener("click", () => {
          rows[key] = rows[key] === "any" ? "yes" : "any";
          changed();
        });
        renders.push(() => {
          button.dataset.state = rows[key];
          button.setAttribute("aria-checked", rows[key] === "yes" ? "true" : rows[key] === "no" ? "mixed" : "false");
          mark.textContent = rows[key] === "yes" ? "✓" : rows[key] === "no" ? "−" : "";
        });
        box.append(button);
      }
      return box;
    }

    function scopeControl() {
      const box = h("div", { class: "qol-panel-line", role: "radiogroup" });
      for (const [value, labelKey] of [["folder", "thisFolder"], ["all", "allMailboxes"]]) {
        const radio = h("input", { type: "radio", name: "qol-search-scope", value });
        radio.addEventListener("change", () => {
          if (radio.checked) scope = value;
        });
        renders.push(() => (radio.checked = currentScope() === value));
        box.append(h("label", {}, radio, " ", text(labelKey)));
      }
      return box;
    }

    const dates = h(
      "div",
      { class: "qol-panel-line" },
      h("label", {}, text("dateFrom"), " ", dateInput("after")),
      h("label", {}, text("dateBefore"), " ", dateInput("before"))
    );
    const tip = h("div", { class: "qol-panel-tip" }, text("tip"));
    renders.push(() => (tip.hidden = !(hasCriteria(rows) && tipShown())));
    const clearAll = h("button", { class: "qol-panel-clear", type: "button" }, text("clear"));
    const searchButton = h("button", { class: "qol-panel-search", type: "button" }, text("search"));
    const body = h(
      "div",
      { class: "qol-panel-body" },
      ...CHIP_ROWS.map(([key, labelKey, placeholderKey]) => rowElement(key, labelKey, chipInput(key, placeholderKey))),
      rowElement("date", "date", dates),
      rowElement(
        "folder",
        "folder",
        chipInput("folder", "phFolder", {
          validate: folderError,
          suggest: (typed) =>
            [...new Set(folderInfos().map((info) => info.name))]
              .filter((name) => name.toLowerCase().includes(typed))
              .slice(0, SUGGESTIONS),
        })
      ),
      rowElement("tags", "tags", tagsControl()),
      h("div", { class: "qol-panel-row", "data-row": "flags" }, h("span", { class: "qol-panel-label" }, orMarker("flags")), flagsControl()),
      h("span", { class: "qol-panel-label" }),
      scopeControl(),
      tip,
      h("div", { class: "qol-panel-buttons" }, clearAll, searchButton)
    );
    const panel = doc.createXULElement("panel");
    panel.id = "qol-search-panel";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", text("filters"));
    panel.append(body);

    function renderPanel() {
      for (const render of renders) render();
    }

    function openPanel() {
      rows = qolSearchPanelModel.rowsFromQuery(qolSearchQuery.parse(input.value));
      edited = false;
      for (const chipEntry of chipInputs) {
        chipEntry.entry.value = "";
        chipEntry.reset();
      }
      renderPanel();
      panel.addEventListener("popupshown", () => chipInputs[0].entry.focus(), { once: true });
      panel.openPopup(root, "after_start", 0, 2);
    }

    function runPanel() {
      // Text typed but not turned into a chip yet counts too.
      for (const chipEntry of chipInputs) {
        if (chipEntry.entry.value.trim()) chipEntry.commit();
      }
      const query = edited ? qolSearchQuery.print(qolSearchPanelModel.queryFromRows(rows), lang) : input.value.trim();
      panel.hidePopup();
      input.value = query;
      updateField();
      search(query);
    }

    clearAll.addEventListener("click", () => {
      rows = emptyRows();
      edited = false;
      renderPanel();
      clearField();
    });
    searchButton.addEventListener("click", runPanel);

    // Result chips, one row per mail tab

    // about:3pane window -> its row below the list header.
    const resultRows = new Map();

    function noticeElement(rowDoc, notice) {
      const node = el(rowDoc, "span", { class: "qol-notice", "data-kind": notice.kind }, text(notice.kind, notice));
      if (notice.kind === "glodaOff") {
        const turnOn = el(rowDoc, "button", { class: "qol-notice-action", type: "button" }, text("turnOn"));
        turnOn.addEventListener("click", () => onTurnOnIndex());
        node.append(turnOn);
      }
      const close = el(rowDoc, "button", { class: "qol-notice-close", type: "button", title: text("closeNotice"), "aria-label": text("closeNotice") }, "✕");
      close.addEventListener("click", () => onDismissNotice?.(notice.kind));
      node.append(close);
      return node;
    }

    // `groups` are the query's OR groups, each a list of { text, error } terms.
    function criteriaElement(rowDoc, groups) {
      const node = el(rowDoc, "span", { class: "qol-search-criteria" });
      for (const terms of groups) {
        terms.forEach((term, index) => {
          if (index > 0) node.append(el(rowDoc, "span", { class: "qol-search-or" }, text("or")));
          const chip = el(rowDoc, "span", { class: "qol-chip" }, term.text);
          if (term.error) {
            chip.classList.add("error");
            chip.title = term.error;
          }
          node.append(chip);
        });
      }
      return node;
    }

    // `pane` is the about:3pane window whose list shows the results. Without counts (a
    // search that could not run) the row shows only the criteria with errors.
    function setResults({ pane, folderLabel, folderCount = null, allCount = null, active, searching = false, notices = [], criteria = [], empty = false }) {
      const rowDoc = pane.document;
      const header = rowDoc.getElementById("threadPaneHeaderBar");
      if (!header) return;
      loadSheet(pane);
      let resultRow = resultRows.get(pane);
      if (!resultRow) {
        resultRow = el(rowDoc, "div", { id: "qol-search-results", role: "group", "aria-label": text("results") });
        resultRows.set(pane, resultRow);
      }
      if (resultRow.previousElementSibling !== header) header.after(resultRow);
      const chip = (value, label) => {
        const button = el(rowDoc, "button", { class: "qol-scope-chip", type: "button", "data-scope": value }, label);
        button.classList.toggle("active", value === active);
        button.setAttribute("aria-pressed", String(value === active));
        button.addEventListener("click", () => {
          if (value !== active) onScope(value);
        });
        return button;
      };
      const children = [];
      if (folderCount !== null) {
        children.push(chip("folder", `${folderLabel} · ${folderCount}`), chip("all", `${text("allMailboxes")} · ${allCount}`));
      }
      const spinner = el(rowDoc, "span", { class: "qol-searching" }, el(rowDoc, "span", { class: "qol-spinner" }), text("stillSearching"));
      spinner.hidden = !searching;
      children.push(spinner);
      const errors = criteria.map((terms) => terms.filter((term) => term.error)).filter((terms) => terms.length);
      if (errors.length && !empty) children.push(criteriaElement(rowDoc, errors));
      children.push(...notices.map((notice) => noticeElement(rowDoc, notice)));
      if (empty) {
        const box = el(rowDoc, "div", { class: "qol-search-empty" }, el(rowDoc, "span", { class: "qol-search-none" }, text("noResults")), criteriaElement(rowDoc, criteria));
        if (active === "folder") {
          const all = el(rowDoc, "button", { class: "qol-search-all", type: "button" }, text("searchAll"));
          all.addEventListener("click", () => onScope("all"));
          box.append(all);
        }
        children.push(box);
      }
      resultRow.replaceChildren(...children);
    }

    // Without `pane`, the rows of every tab.
    function clearResults(pane) {
      for (const [rowPane, resultRow] of resultRows) {
        if (pane && rowPane !== pane) continue;
        resultRow.remove();
        resultRows.delete(rowPane);
      }
    }

    // The scope the next search from the field uses; null for the default scope.
    function setScope(value) {
      scope = value;
    }

    function getQuery() {
      return input.value;
    }

    function setQuery(query) {
      input.value = query;
      updateField();
    }

    function focus() {
      input.focus();
      input.select();
    }

    function destroy() {
      try {
        panel.hidePopup();
      } catch (e) {}
      panel.remove();
      root.remove();
      clearResults();
      for (const target of sheetWindows) {
        try {
          target.windowUtils.removeSheetUsingURIString(sheetURL, target.windowUtils.AUTHOR_SHEET);
        } catch (e) {
          // The tab is gone.
        }
      }
      sheetWindows.clear();
    }

    // Nothing stays behind when the install fails half-way.
    try {
      (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);
      loadSheet(win);
      updateField();
    } catch (e) {
      destroy();
      throw e;
    }
    return { root, panel, setQuery, getQuery, setResults, clearResults, setScope, focus, destroy };
  }

  return { install };
})();
