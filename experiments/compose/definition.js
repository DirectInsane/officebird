// Classic script: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolRibbonDefinition = (() => {
  const ICON_BASE = "chrome://messenger/skin/icons/";
  const PICKERS = ["font", "size", "color", "highlight", "gallery", "styleSet"];
  const KINDS = ["button", "split", "toggle", ...PICKERS];
  const SIZES = ["large", "small"];
  const OPS = [
    "fontFamily", "fontSize", "color", "highlight",
    "bold", "italic", "underline", "strike", "subscript", "superscript",
    "clearFormatting", "bulletList", "numberList", "indent", "outdent",
    "align", "style", "styleSet",
  ];
  const ACTIONS = ["painter", "sizeUp", "sizeDown"];
  // Accel is Cmd on macOS and Ctrl elsewhere; Ctrl is Control on every platform.
  const MODIFIERS = ["Accel", "Ctrl", "Alt", "Shift"];

  const icon = name => ICON_BASE + name;

  // formatting: true disables the control in plain-text mail.
  function ctl(id, kind, size, rest) {
    return { id, kind, size, label: id, formatting: true, ...rest };
  }

  function fontControls(prefix) {
    const p = id => prefix + id;
    return {
      font: ctl(p("font"), "font", "small", {}),
      size: ctl(p("size"), "size", "small", {}),
      up: ctl(p("size-up"), "button", "small", { icon: icon("increase.svg"), action: "sizeUp" }),
      down: ctl(p("size-down"), "button", "small", { icon: icon("decrease.svg"), action: "sizeDown" }),
      bold: ctl(p("bold"), "toggle", "small", { icon: icon("bold.svg"), shortcut: "Accel+B", op: { op: "bold" } }),
      italic: ctl(p("italic"), "toggle", "small", { icon: icon("italics.svg"), shortcut: "Accel+I", op: { op: "italic" } }),
      underline: ctl(p("underline"), "toggle", "small", { icon: icon("underline.svg"), shortcut: "Accel+U", op: { op: "underline" } }),
      strike: ctl(p("strike"), "toggle", "small", { glyph: "S", op: { op: "strike" } }),
      highlight: ctl(p("highlight"), "highlight", "small", { icon: icon("highlights.svg") }),
      color: ctl(p("color"), "color", "small", { glyph: "A" }),
      clear: ctl(p("clear"), "button", "small", { icon: icon("remove-text-styling.svg"), op: { op: "clearFormatting" } }),
    };
  }

  const basic = fontControls("");
  const fmt = fontControls("f-");

  // `label` is a labels.js key, the tooltip key is "<id>.tip". `enabledBy` is the
  // command whose state a menu-only control mirrors, as Thunderbird's button does.
  const DEFINITION = {
    quickAccess: [
      ctl("qa-send", "split", "small", {
        icon: icon("send.svg"), shortcut: "Accel+Enter", command: "cmd_sendButton", formatting: false,
        menu: [{ id: "qa-send-later", label: "qa-send-later", command: "cmd_sendLater", icon: icon("new/compact/clock.svg") }],
      }),
      ctl("qa-save", "split", "small", {
        icon: icon("save.svg"), command: "cmd_saveDefault", popup: "button-save", formatting: false,
      }),
      ctl("qa-attach", "split", "small", {
        icon: icon("attach.svg"), command: "cmd_attachFile", popup: "button-attach", formatting: false,
      }),
    ],
    tabs: [
      {
        id: "message",
        label: "tab.message",
        groups: [
          {
            id: "clipboard",
            label: "group.clipboard",
            controls: [
              ctl("paste", "split", "large", {
                icon: icon("paste.svg"), command: "cmd_paste", formatting: false,
                menu: [{ id: "paste-text", label: "paste-text", command: "cmd_pasteNoFormatting" }],
              }),
              ctl("cut", "button", "small", { icon: icon("cut.svg"), command: "cmd_cut", formatting: false }),
              ctl("copy", "button", "small", { icon: icon("new/compact/copy.svg"), command: "cmd_copy", formatting: false }),
              ctl("painter", "toggle", "small", {
                icon: icon("new/compact/paint-brush.svg"), shortcut: "Ctrl+Shift+C", action: "painter",
              }),
            ],
          },
          {
            id: "basic",
            label: "group.basic",
            controls: [
              basic.font, basic.size, basic.up, basic.down,
              basic.bold, basic.italic, basic.underline, basic.strike,
              basic.highlight, basic.color, basic.clear,
            ],
          },
          {
            id: "include",
            label: "group.include",
            controls: [
              ctl("attach", "button", "large", {
                icon: icon("attach.svg"), command: "cmd_attachFile", formatting: false,
              }),
              // Thunderbird's Insert button observes cmd_renderedHTMLEnabler (off in plain-text mail).
              ctl("insert", "split", "large", {
                icon: icon("image.svg"), popup: "InsertPopupButton", enabledBy: "cmd_renderedHTMLEnabler", formatting: false,
              }),
              // The contacts sidebar has no command element, only the F9 <key>.
              ctl("contacts", "button", "large", {
                icon: icon("new/compact/address-book.svg"), key: "key_addressSidebar", shortcut: "F9", formatting: false,
              }),
            ],
          },
          {
            id: "check",
            label: "group.check",
            controls: [
              ctl("spelling", "split", "large", {
                icon: icon("spelling.svg"), command: "cmd_spelling", popup: "spellingButton", formatting: false,
              }),
              ctl("security", "button", "large", {
                icon: icon("new/compact/lock.svg"), popup: "encryptionToolbarMenu", formatting: false,
              }),
            ],
          },
        ],
      },
      {
        id: "format",
        label: "tab.format",
        groups: [
          {
            id: "clipboard",
            label: "group.clipboard",
            controls: [
              ctl("painter-large", "toggle", "large", {
                icon: icon("new/compact/paint-brush.svg"), shortcut: "Ctrl+Shift+C", action: "painter",
              }),
            ],
          },
          {
            id: "font",
            label: "group.font",
            controls: [
              fmt.font, fmt.size, fmt.up, fmt.down,
              fmt.bold, fmt.italic, fmt.underline, fmt.strike,
              ctl("f-subscript", "toggle", "small", { glyph: "x₂", op: { op: "subscript" } }),
              ctl("f-superscript", "toggle", "small", { glyph: "x²", op: { op: "superscript" } }),
              fmt.highlight, fmt.color, fmt.clear,
            ],
          },
          {
            id: "paragraph",
            label: "group.paragraph",
            controls: [
              ctl("bullets", "toggle", "small", { icon: icon("bullet-list.svg"), op: { op: "bulletList" } }),
              ctl("numbers", "toggle", "small", { icon: icon("number-list.svg"), op: { op: "numberList" } }),
              ctl("outdent", "button", "small", { icon: icon("outdent.svg"), op: { op: "outdent" } }),
              ctl("indent", "button", "small", { icon: icon("indent.svg"), op: { op: "indent" } }),
              ctl("align-left", "toggle", "small", { icon: icon("left-align.svg"), op: { op: "align", value: "left" } }),
              ctl("align-center", "toggle", "small", { icon: icon("center-align.svg"), op: { op: "align", value: "center" } }),
              ctl("align-right", "toggle", "small", { icon: icon("right-align.svg"), op: { op: "align", value: "right" } }),
              ctl("align-justify", "toggle", "small", { icon: icon("justify.svg"), op: { op: "align", value: "justify" } }),
            ],
          },
          {
            id: "styles",
            label: "group.styles",
            controls: [ctl("styles", "gallery", "large", {})],
          },
          {
            id: "styleset",
            label: "group.styleset",
            controls: [ctl("styleset", "styleSet", "large", { icon: icon("paragraph.svg") })],
          },
        ],
      },
    ],
  };

  // `labels` is qolComposeLabels; returns error messages, empty when valid.
  function validate(def, labels) {
    const errors = [];
    const langs = Object.keys(labels.STRINGS);
    const seen = new Set();

    function checkLabel(owner, key) {
      if (typeof key !== "string" || !key) {
        errors.push(`${owner}: no label key`);
        return;
      }
      for (const lang of langs) {
        if (!labels.STRINGS[lang][key]) {
          errors.push(`${owner}: label "${key}" missing in "${lang}"`);
        }
      }
    }

    function checkControl(c, where) {
      const owner = `control "${c.id}" (${where})`;
      if (!c.id || typeof c.id !== "string") {
        errors.push(`control without id (${where})`);
        return;
      }
      if (seen.has(c.id)) {
        errors.push(`duplicate id "${c.id}" (${where})`);
      }
      seen.add(c.id);
      if (!KINDS.includes(c.kind)) {
        errors.push(`${owner}: unknown kind "${c.kind}"`);
      }
      if (!SIZES.includes(c.size)) {
        errors.push(`${owner}: size must be large or small, not "${c.size}"`);
      }
      if (typeof c.formatting !== "boolean") {
        errors.push(`${owner}: formatting must be true or false`);
      }
      checkLabel(owner, c.label);
      if (!c.command && !c.op && !c.popup && !c.action && !c.key && !PICKERS.includes(c.kind)) {
        errors.push(`${owner}: needs a command, op, popup, action, key or picker kind`);
      }
      if (c.op && !OPS.includes(c.op.op)) {
        errors.push(`${owner}: unknown operation "${c.op.op}"`);
      }
      if (c.action && !ACTIONS.includes(c.action)) {
        errors.push(`${owner}: unknown action "${c.action}"`);
      }
      if (c.shortcut !== undefined) {
        const parts = String(c.shortcut).split("+");
        const key = parts.pop();
        if (!key || !parts.every(m => MODIFIERS.includes(m))) {
          errors.push(`${owner}: bad shortcut "${c.shortcut}"`);
        }
      }
      for (const m of c.menu || []) {
        if (!m.id || !m.command) {
          errors.push(`${owner}: menu item needs an id and a command`);
        }
        checkLabel(`${owner} menu "${m.id}"`, m.label);
      }
    }

    for (const c of def.quickAccess || []) {
      checkControl(c, "quick access");
    }
    for (const tab of def.tabs || []) {
      checkLabel(`tab "${tab.id}"`, tab.label);
      const groups = new Set();
      for (const g of tab.groups || []) {
        if (groups.has(g.id)) {
          errors.push(`duplicate group "${g.id}" in tab "${tab.id}"`);
        }
        groups.add(g.id);
        checkLabel(`group "${g.id}" (${tab.id})`, g.label);
        for (const c of g.controls || []) {
          checkControl(c, `${tab.id}/${g.id}`);
        }
      }
    }
    return errors;
  }

  return { DEFINITION, ICON_BASE, validate };
})();
