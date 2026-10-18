/* A classic script, not a module: the experiment loads it into a sandbox. */
"use strict";

var qolComposeEngine = (() => {
  const ALIGN_COMMANDS = { left: "justifyLeft", center: "justifyCenter", right: "justifyRight", justify: "justifyFull" };
  const INLINE_OPS = new Set([
    "fontFamily", "fontSize", "color", "highlight",
    "bold", "italic", "underline", "strike", "subscript", "superscript", "clearFormatting",
  ]);
  const KEPT_DECLARATIONS = ["text-align", "margin-left"];
  // Clear formatting strips these only from inline formatting elements, never from
  // images, tables, links or signatures.
  const FORMAT_ATTRIBUTES = ["style", "color", "face", "size"];
  const FORMAT_ELEMENTS = new Set(["span", "font", "mark", "b", "i", "u", "s", "strike", "sub", "sup", "em", "strong"]);
  // A reply's quote (blockquote type=cite) is not a Style.
  const STYLED_BLOCKS = "h1, h2, h3, h4, h5, h6, pre, blockquote:not([type=cite])";
  // A set's font goes on wrapper <div>s around the mail's own text, not on the body:
  // Gmail drops the body's style, and the quoted conversation must not inherit it.
  const SET_FONT = [["font-family", "fontFamily"], ["font-size", "fontSize"], ["color", "color"]];
  const setFont = set => SET_FONT.filter(([, field]) => set[field]);
  const SET_BLOCKS = {
    p: ["margin", "paragraphMargin"],
    h1: ["color", "headingColor"],
    h2: ["color", "headingColor"],
    h3: ["color", "headingColor"],
  };
  const SET_SPARED = 'blockquote[type="cite"], .moz-forward-container, .moz-signature';
  const SET_WRAPPER = "qol-own-text";
  const isSetWrapper = node => node.localName === "div" && node.classList.contains(SET_WRAPPER);
  const SET_BOUNDARY = `${SET_SPARED}, .moz-cite-prefix`;
  const NOT_TEXT = "meta, style, link, script, title";
  // execCommand("fontSize") takes only 1-7: its <font size="7"> elements are
  // rewritten to a pt size in the same transaction.
  const MARKER_SIZE = "7";
  const WORD_CHAR = /[\p{L}\p{N}\p{M}_'’-]/u;
  const SHOW_TEXT = 4;
  const SHOW_ELEMENT = 1;
  // The compose window's sheets don't reach the mail's document, so the brush cursor
  // (hotspot 2 14: the tip) comes in a sheet loaded into it, never part of the mail.
  const PAINTER_ATTR = "data-qol-painter";
  const PAINTER_SHEET = "data:text/css," + encodeURIComponent(
    ':root, :root * { cursor: url("chrome://messenger/skin/icons/new/compact/paint-brush.svg") 2 14, text !important; }',
  );
  const SELECTING_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

  /** formatting: qolFormatting; onPaintChange: the painter started, stopped or painted. */
  function create(win, { formatting, onPreviewEnd = null, onPaintChange = null }) {
    // Thunderbird's globals (GetCurrentEditor, gMsgCompose) are hidden behind Xrays.
    const page = win.wrappedJSObject || win;
    // The sandbox has no console of its own.
    const log = (...args) => win.console.warn("[qolCompose]", ...args);
    let depth = 0;
    let destroyed = false;
    let shown = null;
    let undone = null;
    let painting = null;
    let paintSticky = false;
    let captured = null;

    function editor() {
      return page.GetCurrentEditor();
    }

    function isHTML() {
      return Boolean(page.gMsgCompose?.composeHTML);
    }

    // Transactions

    /**
     * If fn throws, the outermost transaction undoes it all (an open batch can't be undone).
     * TB 153's nsIEditor has no transactionManager: the modification count tells whether anything happened.
     */
    function transaction(fn) {
      const ed = editor();
      const before = ed.getModificationCount();
      depth++;
      ed.beginTransaction();
      try {
        fn(ed);
      } catch (e) {
        ed.endTransaction();
        depth--;
        if (depth === 0 && ed.getModificationCount() !== before) {
          ed.undo(1);
          // undo(1) lowers the count by one only.
          ed.incrementModificationCount(before - ed.getModificationCount());
          // Gecko keeps the failed step as a redo entry; never replay it.
          rememberUndone(ed, ed.document);
        }
        throw e;
      }
      ed.endTransaction();
      depth--;
    }

    // Selection helpers

    function selectionOf(doc) {
      return doc.defaultView.getSelection();
    }

    function charBeside(doc, direction) {
      const selection = selectionOf(doc);
      const { focusNode, focusOffset } = selection;
      try {
        selection.modify("extend", direction < 0 ? "backward" : "forward", "character");
        const text = selection.rangeCount ? selection.getRangeAt(0).toString() : "";
        return text.length === 1 ? text : "";
      } finally {
        selection.collapse(focusNode, focusOffset);
      }
    }

    function expandToWord(doc) {
      if (!WORD_CHAR.test(charBeside(doc, 1))) {
        return null;
      }
      const selection = selectionOf(doc);
      const { focusNode, focusOffset } = selection;
      let into = 0;
      // At the start of a word, moving back would reach the previous word.
      if (WORD_CHAR.test(charBeside(doc, -1))) {
        selection.modify("move", "backward", "word");
        const start = selection.getRangeAt(0).cloneRange();
        start.setEnd(focusNode, focusOffset);
        into = start.toString().length;
      }
      selection.modify("extend", "forward", "word");
      // Some platforms select the space after the word too.
      const range = selection.getRangeAt(0);
      let { endContainer, endOffset } = range;
      while (endContainer.nodeType === 3 && endOffset > 0 && /\s/.test(endContainer.data[endOffset - 1])) {
        endOffset--;
      }
      if (endOffset !== range.endOffset) {
        selection.extend(endContainer, endOffset);
      }
      return into;
    }

    function restoreCaret(doc, into) {
      const selection = selectionOf(doc);
      selection.collapseToStart();
      for (let i = 0; i < into; i++) {
        selection.modify("move", "forward", "character");
      }
    }

    function blockOf(doc, node) {
      let el = node.nodeType === 1 ? node : node.parentElement;
      const view = doc.defaultView;
      while (el && el !== doc.body && view.getComputedStyle(el).display.startsWith("inline")) {
        el = el.parentElement;
      }
      return el || doc.body;
    }

    function selectedNodes(doc) {
      const selection = selectionOf(doc);
      const nodes = [];
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        nodes.push(range.startContainer);
        const root = range.commonAncestorContainer;
        const walker = doc.createTreeWalker(root, SHOW_TEXT);
        for (let t = root.nodeType === 3 ? root : walker.nextNode(); t; t = walker.nextNode()) {
          if (range.intersectsNode(t)) {
            nodes.push(t);
          }
        }
      }
      return nodes;
    }

    function selectedBlocks(doc, tag) {
      const blocks = new Set();
      for (const node of selectedNodes(doc)) {
        const el = (node.nodeType === 1 ? node : node.parentElement)?.closest(tag);
        if (el && doc.body.contains(el) && el !== doc.body) {
          blocks.add(el);
        }
      }
      return [...blocks];
    }

    function elementsInside(doc) {
      const selection = selectionOf(doc);
      const found = [];
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        let root = range.commonAncestorContainer;
        if (root.nodeType !== 1) {
          root = root.parentElement;
        }
        const walker = doc.createTreeWalker(root, SHOW_ELEMENT);
        for (let el = walker.nextNode(); el; el = walker.nextNode()) {
          if (selection.containsNode(el, false)) {
            found.push(el);
          }
        }
      }
      return found;
    }

    // Primitives

    function exec(doc, command, value = null, css = false) {
      doc.execCommand("styleWithCSS", false, css);
      if (!doc.execCommand(command, false, value)) {
        throw new Error(`execCommand ${command} refused`);
      }
    }

    function toggle(doc, command, value, run) {
      if (typeof value === "boolean" && doc.queryCommandState(command) === value) {
        return;
      }
      run();
    }

    function fontSize(ed, doc, pt, collapsed) {
      const style = `font-size: ${pt}pt`;
      if (collapsed) {
        // Sets the typing style for the next typed text.
        ed.setInlineProperty("font", "style", style);
        return;
      }
      const selector = `font[size="${MARKER_SIZE}"]`;
      const before = new Set(doc.body.querySelectorAll(selector));
      exec(doc, "fontSize", MARKER_SIZE);
      for (const el of doc.body.querySelectorAll(selector)) {
        if (!before.has(el)) {
          ed.removeAttribute(el, "size");
          ed.setAttribute(el, "style", style);
        }
      }
    }

    /** Kept declarations the Styles set themselves (a heading's margin sets margin-left), not the user's. */
    function styleDeclarations(doc) {
      const probe = doc.createElement("span");
      const found = new Set();
      for (const setKey of formatting.STYLE_SET_KEYS) {
        for (const styleKey of formatting.STYLE_KEYS) {
          probe.setAttribute("style", formatting.blockStyle(styleKey, setKey));
          for (const name of KEPT_DECLARATIONS) {
            found.add(`${name}: ${probe.style.getPropertyValue(name)}`);
          }
        }
      }
      return found;
    }

    function setBlockStyle(ed, block, styleKey, keep) {
      const parts = [formatting.blockStyle(styleKey, mailSet(block.ownerDocument))].filter(Boolean);
      if (keep) {
        const fromStyles = styleDeclarations(block.ownerDocument);
        for (const name of KEPT_DECLARATIONS) {
          const declaration = `${name}: ${block.style.getPropertyValue(name)}`;
          if (block.style.getPropertyValue(name) && !fromStyles.has(declaration)) {
            parts.push(declaration);
          }
        }
      }
      const style = parts.join("; ");
      if (style) {
        if (block.getAttribute("style") !== style) {
          ed.setAttribute(block, "style", style);
        }
      } else if (block.hasAttribute("style")) {
        ed.removeAttribute(block, "style");
      }
    }

    function applyStyle(ed, doc, styleKey) {
      const tag = formatting.STYLES[styleKey].block;
      exec(doc, "formatBlock", tag);
      for (const block of selectedBlocks(doc, tag)) {
        setBlockStyle(ed, block, styleKey, true);
      }
    }

    function isInline(doc, node) {
      return node.nodeType !== 1 || doc.defaultView.getComputedStyle(node).display.startsWith("inline");
    }

    /** formatBlock leaves a quote holding blocks as it is, so that one is outdented. */
    function unstyleBlock(ed, doc, block, keep) {
      const range = doc.createRange();
      range.selectNodeContents(block);
      const selection = selectionOf(doc);
      selection.removeAllRanges();
      selection.addRange(range);
      const holdsBlocks = [...block.childNodes].some(child => !isInline(doc, child));
      if (block.localName === "blockquote" && holdsBlocks) {
        exec(doc, "outdent");
      } else {
        exec(doc, "formatBlock", "p");
      }
      for (const p of selectedBlocks(doc, "p")) {
        setBlockStyle(ed, p, "normal", keep);
      }
    }

    function unstyleSelected(ed, doc, keep) {
      const styled = selectedBlocks(doc, STYLED_BLOCKS);
      if (!styled.length) {
        return;
      }
      const selection = selectionOf(doc);
      const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
      for (const block of styled) {
        if (block.isConnected) {
          unstyleBlock(ed, doc, block, keep);
        }
      }
      // The text nodes moved intact, so the old offsets still hold.
      if (anchorNode?.isConnected && focusNode?.isConnected) {
        selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
      }
    }

    // Style sets

    /**
     * { name, value, start, end } per declaration, start..end spanning "name: value";
     * a ";" inside quotes or parentheses doesn't split.
     */
    function declarations(text) {
      const found = [];
      let quote = null;
      let depth = 0;
      let from = 0;
      for (let i = 0; i <= text.length; i++) {
        if (i < text.length) {
          const c = text[i];
          if (quote) {
            if (c === "\\") {
              i++;
            } else if (c === quote) {
              quote = null;
            }
            continue;
          }
          if (c === '"' || c === "'") {
            quote = c;
          } else if (c === "(") {
            depth++;
          } else if (c === ")") {
            depth = Math.max(0, depth - 1);
          }
          if (c !== ";" || depth > 0) {
            continue;
          }
        }
        const segment = text.slice(from, i);
        const colon = segment.indexOf(":");
        if (colon > 0) {
          found.push({
            name: segment.slice(0, colon).trim().toLowerCase(),
            value: segment.slice(colon + 1).trim(),
            start: from + segment.search(/\S/),
            end: from + segment.trimEnd().length,
          });
        }
        from = i + 1;
      }
      return found;
    }

    function removeDeclarations(text, list, first, last) {
      if (first > 0) {
        return text.slice(0, list[first - 1].end) + text.slice(list[last].end);
      }
      const next = list[last + 1];
      return text.slice(0, list[first].start) + (next ? text.slice(next.start) : "");
    }

    function appendDeclarations(text, added) {
      const list = declarations(text);
      if (!list.length) {
        return added;
      }
      const end = list[list.length - 1].end;
      return `${text.slice(0, end)}; ${added}${text.slice(end)}`;
    }

    function prependDeclaration(text, added) {
      const list = declarations(text);
      if (!list.length) {
        return added;
      }
      const start = list[0].start;
      return `${text.slice(0, start)}${added}; ${text.slice(start)}`;
    }

    /** Compares the values as the browser serializes them: #0b63ce equals rgb(11, 99, 206). */
    function sameValue(doc, name, a, b) {
      const probe = doc.createElement("span");
      const normal = value => {
        probe.removeAttribute("style");
        probe.style.setProperty(name, value);
        return probe.style.getPropertyValue(name);
      };
      const first = normal(a);
      return first !== "" && first === normal(b);
    }

    function setWrappers(doc) {
      return [...doc.body.children].filter(isSetWrapper);
    }

    function wrapperSet(doc, wrapper) {
      const list = declarations(wrapper.getAttribute("style") ?? "");
      return formatting.STYLE_SET_KEYS.find(key => {
        const set = formatting.STYLE_SETS[key];
        const fields = setFont(set);
        return fields.length && fields.length === list.length && fields.every(([name, field], i) =>
          list[i].name === name && sameValue(doc, name, list[i].value, set[field]));
      }) ?? null;
    }

    /** The legacy format: a set's font as the body's last declarations. */
    function bodySet(doc) {
      const list = declarations(doc.body?.getAttribute("style") ?? "");
      for (const key of formatting.STYLE_SET_KEYS) {
        const fields = setFont(formatting.STYLE_SETS[key]);
        const first = list.length - fields.length;
        if (fields.length && first >= 0 && fields.every(([name, field], i) =>
          list[first + i].name === name && sameValue(doc, name, list[first + i].value, formatting.STYLE_SETS[key][field]))) {
          return { key, list, first };
        }
      }
      return { key: "default", list, first: -1 };
    }

    /** Read from the mail, never cached, so undo, redo and a cancelled preview can't leave it stale. */
    function mailSet(doc) {
      if (!doc.body) {
        return "default";
      }
      const wrapper = setWrappers(doc)[0];
      return wrapper ? wrapperSet(doc, wrapper) ?? "default" : bodySet(doc).key;
    }

    function ownRuns(doc) {
      const runs = [];
      let run = [];
      const isText = node => node.nodeType === 1 || (node.nodeType === 3 && node.data.trim() !== "");
      const flush = () => {
        while (run.length && !isText(run[0])) {
          run.shift();
        }
        while (run.length && !isText(run.at(-1))) {
          run.pop();
        }
        if (run.length) {
          runs.push(run);
        }
        run = [];
      };
      for (const node of [...doc.body.childNodes]) {
        if (node.nodeType === 1 && (node.matches(NOT_TEXT) || node.matches(SET_BOUNDARY) || node.querySelector(SET_BOUNDARY) || isSetWrapper(node))) {
          flush();
        } else {
          run.push(node);
        }
      }
      flush();
      return runs;
    }

    function indexIn(node) {
      return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
    }

    function wrap(ed, doc, run, style) {
      const wrapper = doc.createElement("div");
      wrapper.className = SET_WRAPPER;
      wrapper.setAttribute("style", style);
      // The editor drops an empty element it inserts, so the wrapper goes in holding a
      // placeholder. Every step is an editor transaction so redo replays it; nodes go in
      // before the placeholder because redo loses a node inserted at the end.
      const placeholder = doc.createElement("br");
      wrapper.append(placeholder);
      ed.insertNode(wrapper, doc.body, indexIn(run[0]));
      for (const node of run) {
        ed.deleteNode(node);
        ed.insertNode(node, wrapper, indexIn(placeholder));
      }
      ed.deleteNode(placeholder);
    }

    function unwrap(ed, doc, wrapper) {
      // The editor removes a block it empties and pads an empty body with a
      // <br>: a placeholder (first, see wrap) keeps the wrapper until it goes.
      const placeholder = doc.createElement("br");
      ed.insertNode(placeholder, wrapper, 0);
      for (const node of [...wrapper.childNodes]) {
        if (node !== placeholder) {
          ed.deleteNode(node);
          ed.insertNode(node, doc.body, indexIn(wrapper));
        }
      }
      ed.deleteNode(wrapper);
    }

    /** Survives wrapping: a point between nodes is kept as the node after it. */
    function savePoint(node, offset) {
      return node?.nodeType === 1 ? { parent: node, child: node.childNodes[offset] ?? null } : { node, offset };
    }

    function restorePoint(point) {
      if (!("parent" in point)) {
        return point.node?.isConnected ? [point.node, point.offset] : null;
      }
      if (point.child?.isConnected) {
        return [point.child.parentNode, indexIn(point.child)];
      }
      return !point.child && point.parent.isConnected ? [point.parent, point.parent.childNodes.length] : null;
    }

    function writeStyle(ed, el, style) {
      if ((el.getAttribute("style") ?? "") === style) {
        return;
      }
      if (style.trim()) {
        ed.setAttribute(el, "style", style);
      } else {
        ed.removeAttribute(el, "style");
      }
    }

    // margin-left is the indent, not spacing.
    const SPACING_SIDES = ["margin-top", "margin-right", "margin-bottom"];

    /**
     * After Indent or Outdent Gecko serializes the margin as separate sides:
     * removes the three spacing sides when they all match the set's.
     */
    function withoutSpacing(doc, style, spacing) {
      const probe = doc.createElement("span");
      const set = doc.createElement("span");
      probe.setAttribute("style", style);
      set.style.setProperty("margin", spacing);
      const value = (el, side) => el.style.getPropertyValue(side);
      if (!SPACING_SIDES.every(side => value(probe, side) !== "" && value(probe, side) === value(set, side))) {
        return style;
      }
      for (const side of SPACING_SIDES) {
        probe.style.removeProperty(side);
      }
      return probe.getAttribute("style") ?? "";
    }

    /**
     * Removes the old set's declaration (sets write theirs first) and prepends the new
     * one, so the block's own declarations, such as an indent's margin-left, still win.
     */
    function setBlockSet(ed, doc, block, fromKey, toKey) {
      const [name, field] = SET_BLOCKS[block.localName];
      let style = block.getAttribute("style") ?? "";
      const old = formatting.STYLE_SETS[fromKey][field];
      if (old) {
        const list = declarations(style);
        const index = list.findIndex(d => d.name === name && sameValue(doc, name, d.value, old));
        if (index >= 0) {
          style = removeDeclarations(style, list, index, index);
        } else if (name === "margin") {
          style = withoutSpacing(doc, style, old);
        }
      }
      const value = formatting.STYLE_SETS[toKey][field];
      if (value) {
        style = prependDeclaration(style, `${name}: ${value}`);
      }
      writeStyle(ed, block, style);
    }

    function applySet(ed, doc, key) {
      if (!formatting.STYLE_SET_KEYS.includes(key)) {
        throw new Error(`unknown style set ${key}`);
      }
      const set = formatting.STYLE_SETS[key];
      const body = doc.body;
      const current = mailSet(doc);
      const selection = selectionOf(doc);
      const anchor = savePoint(selection.anchorNode, selection.anchorOffset);
      const focus = savePoint(selection.focusNode, selection.focusOffset);
      const old = bodySet(doc);
      if (old.key !== "default") {
        writeStyle(ed, body, removeDeclarations(body.getAttribute("style") ?? "", old.list, old.first, old.list.length - 1));
      }
      // Own text written outside the wrappers since (e.g. between quotes) gets its own.
      const font = setFont(set).map(([name, field]) => `${name}: ${set[field]}`).join("; ");
      for (const wrapper of setWrappers(doc)) {
        if (font) {
          writeStyle(ed, wrapper, font);
        } else {
          unwrap(ed, doc, wrapper);
        }
      }
      if (font) {
        for (const run of ownRuns(doc)) {
          wrap(ed, doc, run, font);
        }
      }
      for (const block of body.querySelectorAll(Object.keys(SET_BLOCKS).join(", "))) {
        if (!block.closest(SET_SPARED)) {
          setBlockSet(ed, doc, block, current, key);
        }
      }
      const [anchorNode, anchorOffset] = restorePoint(anchor) ?? [];
      const [focusNode, focusOffset] = restorePoint(focus) ?? [];
      if (anchorNode && focusNode) {
        selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
      }
    }

    function clearFormatting(ed, doc) {
      exec(doc, "removeFormat");
      for (const el of elementsInside(doc)) {
        if (!FORMAT_ELEMENTS.has(el.localName)) {
          continue;
        }
        for (const name of FORMAT_ATTRIBUTES) {
          if (el.hasAttribute(name)) {
            ed.removeAttribute(el, name);
          }
        }
      }
      // Only the styled blocks themselves change: formatBlock over the
      // selection would also unquote a reply and wrap list items in <p>.
      for (const block of selectedBlocks(doc, "p")) {
        setBlockStyle(ed, block, "normal", false);
      }
      unstyleSelected(ed, doc, false);
    }

    // Operations

    function run(ed, doc, { op, value }, collapsed) {
      switch (op) {
        case "bold":
        case "italic":
        case "underline":
        case "subscript":
        case "superscript":
          // The operation names are execCommand's.
          toggle(doc, op, value, () => exec(doc, op));
          return;
        case "strike":
          // <s> rather than execCommand's <strike> (obsolete in HTML).
          toggle(doc, "strikethrough", value, () => {
            doc.execCommand("styleWithCSS", false, false);
            if (doc.queryCommandState("strikethrough")) {
              ed.removeInlineProperty("s", "");
              ed.removeInlineProperty("strike", "");
            } else {
              ed.setInlineProperty("s", "", "");
            }
          });
          return;
        case "fontFamily":
          if (typeof value !== "string" || !value.trim()) {
            throw new Error("fontFamily needs a name");
          }
          exec(doc, "fontName", value, true);
          return;
        case "fontSize":
          if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`invalid font size ${value}`);
          }
          fontSize(ed, doc, value, collapsed);
          return;
        case "color":
          if (typeof value !== "string" || !value) {
            throw new Error("color needs a value");
          }
          exec(doc, "foreColor", value, true);
          return;
        case "highlight":
          exec(doc, "hiliteColor", value || "transparent", true);
          return;
        case "clearFormatting":
          clearFormatting(ed, doc);
          return;
        case "bulletList":
          exec(doc, "insertUnorderedList");
          return;
        case "numberList":
          exec(doc, "insertOrderedList");
          return;
        case "indent":
        case "outdent":
          exec(doc, op, null, true);
          return;
        case "align":
          if (!ALIGN_COMMANDS[value]) {
            throw new Error(`unknown alignment ${value}`);
          }
          exec(doc, ALIGN_COMMANDS[value], null, true);
          return;
        case "style":
          if (!formatting.STYLE_KEYS.includes(value)) {
            throw new Error(`unknown style ${value}`);
          }
          applyStyle(ed, doc, value);
          return;
        case "styleSet":
          applySet(ed, doc, value);
          return;
        default:
          throw new Error(`unknown operation ${op}`);
      }
    }

    /** { op, value? } as one undo step; false (mail unchanged) on failure or in plain-text mail. */
    function apply(operation) {
      cancelPreview();
      if (destroyed || !isHTML() || !operation) {
        return false;
      }
      let doc = null;
      let into = null;
      let cssBefore = false;
      try {
        const ed = editor();
        doc = ed.document;
        cssBefore = ed.isCSSEnabled;
        const selection = selectionOf(doc);
        if (!selection.rangeCount && operation.op !== "styleSet") {
          return false;
        }
        if (selection.isCollapsed && INLINE_OPS.has(operation.op)) {
          into = expandToWord(doc);
        }
        const collapsed = selection.isCollapsed;
        transaction(() => run(ed, doc, operation, collapsed));
        return true;
      } catch (e) {
        log(`operation ${operation.op} failed`, e);
        return false;
      } finally {
        restoreAfter(doc, cssBefore, into);
      }
    }

    function restoreAfter(doc, cssBefore, into) {
      if (!doc) {
        return;
      }
      // Thunderbird's own commands (Ctrl+B) expect its CSS setting.
      try {
        doc.execCommand("styleWithCSS", false, cssBefore);
      } catch (e) {
        // The editor is gone.
      }
      if (into !== null) {
        try {
          restoreCaret(doc, into);
        } catch (e) {
          // The selection is gone.
        }
      }
    }

    /** No undo step, and the mail does not count as changed (closing it asks nothing). */
    function applyOpeningSet(key) {
      if (destroyed || !isHTML() || !formatting.STYLE_SET_KEYS.includes(key)) {
        return false;
      }
      const ed = editor();
      const count = ed.getModificationCount();
      const bodyModified = page.gMsgCompose?.bodyModified;
      const contentChanged = page.gContentChanged;
      // As Thunderbird does when it switches the signature of a new mail.
      ed.enableUndo(false);
      try {
        ed.beginTransaction();
        try {
          applySet(ed, ed.document, key);
        } finally {
          ed.endTransaction();
        }
        return true;
      } catch (e) {
        log("style set for a new mail failed", e);
        return false;
      } finally {
        ed.enableUndo(true);
        ed.incrementModificationCount(count - ed.getModificationCount());
        if (page.gMsgCompose) {
          page.gMsgCompose.bodyModified = bodyModified;
        }
        page.gContentChanged = contentChanged;
      }
    }

    function applyStyleSet(key) {
      return apply({ op: "styleSet", value: key });
    }

    // Format painter

    function styleOfBlock(block) {
      return block.matches(STYLED_BLOCKS) ? formatting.styleForBlock(block.tagName) : "normal";
    }

    function paintOperations(format) {
      return formatting.formatToOperations(format).filter(({ op, value }) =>
        !(op === "fontSize" && Number.isNaN(value)) && !((op === "color" || op === "fontFamily") && !value));
    }

    function paintStyle(ed, doc, styleKey) {
      if (!formatting.STYLE_KEYS.includes(styleKey)) {
        throw new Error(`unknown style ${styleKey}`);
      }
      if (selectedNodes(doc).every(node => styleOfBlock(blockOf(doc, node)) === styleKey)) {
        return;
      }
      if (styleKey === "normal") {
        unstyleSelected(ed, doc, true);
      } else {
        applyStyle(ed, doc, styleKey);
      }
    }

    /** A qolFormatting Format as one undo step; false (mail unchanged) on failure or in plain-text mail. */
    function applyFormat(format) {
      cancelPreview();
      // Inside an open transaction, a failure could not be undone.
      if (destroyed || !isHTML() || !format || depth > 0) {
        return false;
      }
      let doc = null;
      let into = null;
      let cssBefore = false;
      try {
        const ed = editor();
        doc = ed.document;
        cssBefore = ed.isCSSEnabled;
        const selection = selectionOf(doc);
        if (!selection.rangeCount) {
          return false;
        }
        const operations = paintOperations(format);
        if (selection.isCollapsed) {
          into = expandToWord(doc);
        }
        const collapsed = selection.isCollapsed;
        transaction(() => {
          for (const operation of operations) {
            if (operation.op === "style") {
              paintStyle(ed, doc, operation.value);
            } else {
              run(ed, doc, operation, collapsed);
            }
          }
        });
        return true;
      } catch (e) {
        log("applying a format failed", e);
        return false;
      } finally {
        restoreAfter(doc, cssBefore, into);
      }
    }

    function captureAt() {
      const doc = editor().document;
      return { ...formatAt(), style: styleOfBlock(blockOf(doc, focusElement(doc))) };
    }

    function paintChanged() {
      try {
        onPaintChange?.();
      } catch (e) {
        log("painter handler failed", e);
      }
    }

    /** sticky: paints every selection until Esc or stop(), not only the next one. */
    function startPaint(sticky) {
      cancelPreview();
      if (destroyed || !isHTML()) {
        return false;
      }
      try {
        const doc = editor().document;
        captured = captureAt();
        paintSticky = Boolean(sticky);
        if (!painting) {
          painting = { doc, extending: false };
          for (const type of ["mouseup", "keydown", "keyup"]) {
            doc.addEventListener(type, onPaintEvent, true);
          }
          win.document.documentElement.setAttribute(PAINTER_ATTR, "true");
          try {
            const utils = doc.defaultView.windowUtils;
            utils.loadSheetUsingURIString(PAINTER_SHEET, utils.AUTHOR_SHEET);
          } catch (e) {
            log("no brush cursor", e);
          }
        }
      } catch (e) {
        log("format painter failed", e);
        stopPaint();
        return false;
      }
      paintChanged();
      return true;
    }

    function stopPaint() {
      if (!painting) {
        return;
      }
      const { doc } = painting;
      painting = null;
      paintSticky = false;
      for (const type of ["mouseup", "keydown", "keyup"]) {
        doc.removeEventListener(type, onPaintEvent, true);
      }
      win.document.documentElement.removeAttribute(PAINTER_ATTR);
      try {
        const utils = doc.defaultView?.windowUtils;
        utils?.removeSheetUsingURIString(PAINTER_SHEET, utils.AUTHOR_SHEET);
      } catch (e) {
        // Never loaded, or the mail's window is gone.
      }
      paintChanged();
    }

    function paintSelection() {
      const selection = selectionOf(painting.doc);
      if (!selection.rangeCount || selection.isCollapsed) {
        return;
      }
      applyFormat(captured);
      if (paintSticky) {
        paintChanged();
      } else {
        stopPaint();
      }
    }

    /**
     * A selection is finished on mouse release, or on Shift release after extending it
     * from the keyboard (painting at each arrow key would paint the first character).
     */
    function onPaintEvent(event) {
      if (!painting) {
        return;
      }
      if (event.type === "mouseup") {
        // This capturing listener runs before Gecko handles the release, which may
        // collapse the selection: paint after it, if the painter is still the same one.
        if (event.button === 0) {
          const current = painting;
          win.setTimeout(() => {
            if (painting === current) {
              paintSelection();
            }
          }, 0);
        }
      } else if (event.type === "keydown") {
        if (event.shiftKey && SELECTING_KEYS.has(event.key)) {
          painting.extending = true;
        }
      } else if (painting.extending && (event.key === "Shift" || !event.shiftKey)) {
        painting.extending = false;
        paintSelection();
      }
    }

    /**
     * Ctrl+Shift+C/V, Control on macOS too: Cmd+Shift+V is Thunderbird's Paste Without
     * Formatting. Where Control is the accel key (Windows, Linux), Ctrl+Shift+V stays Thunderbird's.
     */
    function onKeyDown(event) {
      if (event.key === "Escape") {
        stopPaint();
        return;
      }
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || destroyed || !isHTML()) {
        return;
      }
      const letter = event.key.toLowerCase();
      if (letter !== "c" && letter !== "v") {
        return;
      }
      let doc = null;
      try {
        doc = editor()?.document;
      } catch (e) {
        // No editor yet.
      }
      const target = event.target;
      if (!doc || (target !== doc && target.ownerDocument !== doc)) {
        return;
      }
      if (letter === "c") {
        event.preventDefault();
        try {
          captured = captureAt();
        } catch (e) {
          log("capturing the format failed", e);
        }
        paintChanged();
      } else if (captured && !event.getModifierState("Accel")) {
        event.preventDefault();
        applyFormat(captured);
        paintChanged();
      }
    }
    win.addEventListener("keydown", onKeyDown, true);

    // Live preview

    function saveSelection(doc) {
      const { anchorNode, anchorOffset, focusNode, focusOffset } = selectionOf(doc);
      return { anchorNode, anchorOffset, focusNode, focusOffset };
    }

    function restoreSelection(doc, saved) {
      if (saved.anchorNode?.isConnected && saved.focusNode?.isConnected) {
        selectionOf(doc).setBaseAndExtent(saved.anchorNode, saved.anchorOffset, saved.focusNode, saved.focusOffset);
      }
    }

    function onPreviewEvent(event) {
      // Only the window's blur counts, not an element's.
      if (event.type !== "blur" || event.target === win) {
        cancelPreview();
      }
    }

    function listenToPreview(p, on) {
      const method = on ? "addEventListener" : "removeEventListener";
      // Capture: before the editor handles the key or the edit.
      for (const type of ["keydown", "beforeinput", "input"]) {
        p.doc[method](type, onPreviewEvent, true);
      }
      win[method]("blur", onPreviewEvent);
      // Send, save and autosave: before Thunderbird reads the mail.
      win[method]("compose-prepare-message-start", onPreviewEvent);
    }

    /**
     * Gecko keeps a cancelled preview (or failed transaction) as a redo entry, and nsIEditor
     * can only drop all history: count the user's undo steps above it and block a redo that
     * would replay it, until an edit clears redo.
     */
    function onUndoneEvent(event) {
      if (!undone) {
        return;
      }
      if (event.type === "beforeinput") {
        if (event.inputType === "historyRedo" && undone.above === 0) {
          event.preventDefault();
        }
      } else if (event.inputType === "historyUndo") {
        undone.above++;
      } else if (event.inputType === "historyRedo") {
        undone.above--;
      } else if (!undone.ed.canRedo) {
        // An edit cleared redo (an input that changed nothing keeps it).
        forgetUndone();
      }
    }

    function forgetUndone() {
      if (undone) {
        undone.doc.removeEventListener("beforeinput", onUndoneEvent, true);
        undone.doc.removeEventListener("input", onUndoneEvent, true);
        undone = null;
      }
    }

    function rememberUndone(ed, doc) {
      forgetUndone();
      undone = { ed, doc, above: 0 };
      doc.addEventListener("beforeinput", onUndoneEvent, true);
      doc.addEventListener("input", onUndoneEvent, true);
    }

    /**
     * Refused where it couldn't be taken back without a trace: while the user can redo (the
     * preview's transaction would drop it), and for an inline operation at a cursor outside
     * a word (only the typing style changes, which no undo restores).
     */
    function preview(operation) {
      cancelPreview();
      if (destroyed || !isHTML() || !operation) {
        return false;
      }
      try {
        const ed = editor();
        const doc = ed.document;
        const selection = selectionOf(doc);
        // A redo stack holding only an earlier preview is fine.
        const onlyPreviewToRedo = undone?.doc === doc && undone.above === 0;
        if (!selection.rangeCount || (ed.canRedo && !onlyPreviewToRedo)) {
          return false;
        }
        if (selection.isCollapsed && INLINE_OPS.has(operation.op) && !WORD_CHAR.test(charBeside(doc, 1))) {
          return false;
        }
        const saved = saveSelection(doc);
        const count = ed.getModificationCount();
        if (!apply(operation)) {
          return false;
        }
        if (ed.getModificationCount() === count) {
          // No transaction: nothing to take back, redo stack untouched.
          return false;
        }
        // The preview's transaction replaced the old redo entry.
        forgetUndone();
        // A preview doesn't mark the mail changed (autosave, save prompt).
        ed.incrementModificationCount(count - ed.getModificationCount());
        shown = { ed, doc, count, selection: saved };
        listenToPreview(shown, true);
        return true;
      } catch (e) {
        log("preview failed", e);
        return false;
      }
    }

    function cancelPreview() {
      if (!shown) {
        return;
      }
      const p = shown;
      shown = null;
      listenToPreview(p, false);
      try {
        // Only while the preview is still the last transaction.
        if (p.ed.document === p.doc && p.ed.canUndo && p.ed.getModificationCount() === p.count) {
          p.ed.undo(1);
          // undo(1) lowers the count by one only.
          p.ed.incrementModificationCount(p.count - p.ed.getModificationCount());
          restoreSelection(p.doc, p.selection);
          rememberUndone(p.ed, p.doc);
        } else {
          log("preview not taken back: the mail changed meanwhile");
        }
      } catch (e) {
        log("cancelling the preview failed", e);
      }
      try {
        onPreviewEnd?.();
      } catch (e) {
        log("preview end handler failed", e);
      }
    }

    function commitPreview(operation) {
      cancelPreview();
      return apply(operation);
    }

    function focusElement(doc) {
      const selection = selectionOf(doc);
      let node = selection.focusNode || doc.body;
      if (node.nodeType === 1 && node.childNodes[selection.focusOffset]?.nodeType === 1) {
        node = node.childNodes[selection.focusOffset];
      }
      return (node.nodeType === 1 ? node : node.parentElement) || doc.body;
    }

    function formatAt() {
      const doc = editor().document;
      const view = doc.defaultView;
      const el = focusElement(doc);
      const block = blockOf(doc, el);
      const cs = view.getComputedStyle(el);
      // Decorations, highlight and vertical alignment are not inherited:
      // collect them from the inline ancestors up to the block.
      const decorations = new Set();
      let backgroundColor = "transparent";
      let verticalAlign = "baseline";
      for (let e = el; e; e = e === block ? null : e.parentElement) {
        const s = view.getComputedStyle(e);
        for (const line of s.textDecorationLine.split(/\s+/)) {
          decorations.add(line);
        }
        if (e !== block && backgroundColor === "transparent" && formatting.hexFromRgb(s.backgroundColor)) {
          backgroundColor = s.backgroundColor;
        }
        if (verticalAlign === "baseline" && (s.verticalAlign === "sub" || s.verticalAlign === "super")) {
          verticalAlign = s.verticalAlign;
        }
      }
      return formatting.captureFormat({
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        color: cs.color,
        backgroundColor,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        textDecorationLine: [...decorations].filter(d => d !== "none").join(" ") || "none",
        verticalAlign,
      }, block.tagName);
    }

    function destroy() {
      stopPaint();
      cancelPreview();
      forgetUndone();
      win.removeEventListener("keydown", onKeyDown, true);
      captured = null;
      destroyed = true;
    }

    return {
      apply,
      preview,
      cancelPreview,
      commitPreview,
      get previewActive() {
        return shown !== null;
      },
      formatAt,
      isHTML,
      transaction,
      applyFormat,
      applyStyleSet,
      applyOpeningSet,
      get activeSet() {
        try {
          const doc = editor()?.document;
          return doc ? mailSet(doc) : "default";
        } catch (e) {
          return "default";
        }
      },
      paint: {
        start: startPaint,
        stop: stopPaint,
        get active() {
          return painting !== null;
        },
        get sticky() {
          return painting !== null && paintSticky;
        },
        get captured() {
          return captured;
        },
      },
      destroy,
    };
  }

  return { create };
})();
