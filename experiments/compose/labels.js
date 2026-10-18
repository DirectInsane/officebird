// Classic script: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolComposeLabels = (() => {
  // [key, [de label, de tooltip], [en label, en tooltip]], also used for the "f-" twin.
  const BASIC = [
    ["font", ["Schriftart", "Schriftart ändern"], ["Font", "Change the font"]],
    ["size", ["Schriftgrad", "Schriftgrad ändern"], ["Font size", "Change the font size"]],
    ["size-up", ["Schrift vergrößern", "Schriftgrad vergrößern"], ["Increase font size", "Increase the font size"]],
    ["size-down", ["Schrift verkleinern", "Schriftgrad verkleinern"], ["Decrease font size", "Decrease the font size"]],
    ["bold", ["Fett", "Fett"], ["Bold", "Bold"]],
    ["italic", ["Kursiv", "Kursiv"], ["Italic", "Italic"]],
    ["underline", ["Unterstrichen", "Unterstrichen"], ["Underline", "Underline"]],
    ["strike", ["Durchgestrichen", "Durchgestrichen"], ["Strikethrough", "Strikethrough"]],
    ["highlight", ["Texthervorhebungsfarbe", "Texthervorhebungsfarbe"], ["Text highlight color", "Text highlight color"]],
    ["color", ["Schriftfarbe", "Schriftfarbe"], ["Font color", "Font color"]],
    ["clear", ["Formatierung löschen", "Gesamte Formatierung des Textes löschen"],
      ["Clear formatting", "Clear all formatting from the text"]],
  ];

  const de = {
    "tab.message": "Nachricht",
    "tab.format": "Text formatieren",
    "group.clipboard": "Zwischenablage",
    "group.basic": "Basistext",
    "group.include": "Einschließen",
    "group.check": "Prüfen",
    "group.font": "Schriftart",
    "group.paragraph": "Absatz",
    "group.styles": "Formatvorlagen",
    "group.styleset": "Formatvorlagensatz",

    "qa-send": "Senden",
    "qa-send.tip": "Nachricht senden",
    "qa-send-later": "Später senden",
    "qa-save": "Speichern",
    "qa-save.tip": "Nachricht speichern",
    "qa-attach": "Anhängen",
    "qa-attach.tip": "Datei anhängen",

    "paste": "Einfügen",
    "paste.tip": "Aus der Zwischenablage einfügen",
    "paste-text": "Als Text einfügen",
    "cut": "Ausschneiden",
    "cut.tip": "Auswahl ausschneiden",
    "copy": "Kopieren",
    "copy.tip": "Auswahl kopieren",
    "painter": "Format übertragen",
    "painter.tip": "Formatierung von einer Stelle auf eine andere übertragen",
    "painter-large": "Format übertragen",
    "painter-large.tip": "Formatierung von einer Stelle auf eine andere übertragen",

    "attach": "Anhängen",
    "attach.tip": "Datei anhängen",
    "insert": "Objekt einfügen",
    "insert.tip": "Link, Anker, Bild, horizontale Linie oder Tabelle einfügen",
    "contacts": "Kontakte",
    "contacts.tip": "Kontakte-Seitenleiste ein- oder ausblenden",
    "spelling": "Rechtschreibung",
    "spelling.tip": "Rechtschreibung prüfen",
    "security": "Sicherheit",
    "security.tip": "Verschlüsselung und Signatur",

    "f-subscript": "Tiefgestellt",
    "f-subscript.tip": "Text tiefstellen",
    "f-superscript": "Hochgestellt",
    "f-superscript.tip": "Text hochstellen",

    "bullets": "Aufzählung",
    "bullets.tip": "Aufzählungsliste",
    "numbers": "Nummerierung",
    "numbers.tip": "Nummerierte Liste",
    "outdent": "Einzug verkleinern",
    "outdent.tip": "Einzug verkleinern",
    "indent": "Einzug vergrößern",
    "indent.tip": "Einzug vergrößern",
    "align-left": "Linksbündig",
    "align-left.tip": "Text linksbündig ausrichten",
    "align-center": "Zentriert",
    "align-center.tip": "Text zentrieren",
    "align-right": "Rechtsbündig",
    "align-right.tip": "Text rechtsbündig ausrichten",
    "align-justify": "Blocksatz",
    "align-justify.tip": "Text im Blocksatz ausrichten",

    "styles": "Formatvorlagen",
    "styles.tip": "Formatvorlage auf den Absatz anwenden",
    "styleset": "Formatvorlagensatz",
    "styleset.tip": "Schrift und Abstände der Formatvorlagen ändern",

    "style.normal": "Standard",
    "style.heading1": "Überschrift 1",
    "style.heading2": "Überschrift 2",
    "style.heading3": "Überschrift 3",
    "style.quote": "Zitat",
    "style.code": "Code",
    "styleset.default": "Standard",
    "styleset.modern": "Modern",
    "styleset.classic": "Klassisch",
    "styleset.compact": "Kompakt",
    "styleset.setDefault": "Als Standard festlegen",
    "styleset.setDefault.tip": "Neue Mails, Antworten und Weiterleitungen beginnen mit diesem Formatvorlagensatz",

    "menu.recentFonts": "Zuletzt verwendet",
    "menu.allFonts": "Alle Schriftarten",
    "color.theme": "Designfarben",
    "color.standard": "Standardfarben",
    "color.none": "Keine Farbe",
    "color.custom": "Weitere Farben…",
    "hint.plainText": "Nicht verfügbar in Nur-Text-Nachrichten",
    "ribbon.quickAccess": "Schnellzugriff",
    "ribbon.collapse": "Menüband reduzieren",
    "ribbon.expand": "Menüband anheften",
    "ribbon.more": "Weitere Optionen",
  };

  const en = {
    "tab.message": "Message",
    "tab.format": "Format text",
    "group.clipboard": "Clipboard",
    "group.basic": "Basic text",
    "group.include": "Include",
    "group.check": "Check",
    "group.font": "Font",
    "group.paragraph": "Paragraph",
    "group.styles": "Styles",
    "group.styleset": "Style set",

    "qa-send": "Send",
    "qa-send.tip": "Send the message",
    "qa-send-later": "Send later",
    "qa-save": "Save",
    "qa-save.tip": "Save the message",
    "qa-attach": "Attach",
    "qa-attach.tip": "Attach a file",

    "paste": "Paste",
    "paste.tip": "Paste from the clipboard",
    "paste-text": "Paste as text",
    "cut": "Cut",
    "cut.tip": "Cut the selection",
    "copy": "Copy",
    "copy.tip": "Copy the selection",
    "painter": "Format painter",
    "painter.tip": "Copy formatting from one place and apply it to another",
    "painter-large": "Format painter",
    "painter-large.tip": "Copy formatting from one place and apply it to another",

    "attach": "Attach",
    "attach.tip": "Attach a file",
    "insert": "Insert",
    "insert.tip": "Insert a link, anchor, image, horizontal line or table",
    "contacts": "Contacts",
    "contacts.tip": "Show or hide the contacts sidebar",
    "spelling": "Spelling",
    "spelling.tip": "Check spelling",
    "security": "Security",
    "security.tip": "Encryption and signing",

    "f-subscript": "Subscript",
    "f-subscript.tip": "Lower the text below the line",
    "f-superscript": "Superscript",
    "f-superscript.tip": "Raise the text above the line",

    "bullets": "Bullets",
    "bullets.tip": "Bulleted list",
    "numbers": "Numbering",
    "numbers.tip": "Numbered list",
    "outdent": "Decrease indent",
    "outdent.tip": "Decrease the indent",
    "indent": "Increase indent",
    "indent.tip": "Increase the indent",
    "align-left": "Align left",
    "align-left.tip": "Align the text to the left",
    "align-center": "Center",
    "align-center.tip": "Center the text",
    "align-right": "Align right",
    "align-right.tip": "Align the text to the right",
    "align-justify": "Justify",
    "align-justify.tip": "Justify the text",

    "styles": "Styles",
    "styles.tip": "Apply a style to the paragraph",
    "styleset": "Style set",
    "styleset.tip": "Change the fonts and spacing of the styles",

    "style.normal": "Normal",
    "style.heading1": "Heading 1",
    "style.heading2": "Heading 2",
    "style.heading3": "Heading 3",
    "style.quote": "Quote",
    "style.code": "Code",
    "styleset.default": "Default",
    "styleset.modern": "Modern",
    "styleset.classic": "Classic",
    "styleset.compact": "Compact",
    "styleset.setDefault": "Set as default",
    "styleset.setDefault.tip": "New mails, replies and forwards start with this style set",

    "menu.recentFonts": "Recently used",
    "menu.allFonts": "All fonts",
    "color.theme": "Theme colors",
    "color.standard": "Standard colors",
    "color.none": "No color",
    "color.custom": "More colors…",
    "hint.plainText": "Not available in plain-text mail",
    "ribbon.quickAccess": "Quick access",
    "ribbon.collapse": "Collapse the ribbon",
    "ribbon.expand": "Pin the ribbon",
    "ribbon.more": "More options",
  };

  for (const [key, d, e] of BASIC) {
    for (const [target, pair] of [[de, d], [en, e]]) {
      target[key] = pair[0];
      target[key + ".tip"] = pair[1];
      target["f-" + key] = pair[0];
      target["f-" + key + ".tip"] = pair[1];
    }
  }

  const STRINGS = { de, en };

  function pickLanguage(locale) {
    return /^de(?:$|[-_])/i.test(String(locale || "")) ? "de" : "en";
  }

  function label(lang, key) {
    return (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
  }

  // macOS writes modifier symbols in this order, without "+".
  const MAC_MODIFIERS = [["Ctrl", "⌃"], ["Alt", "⌥"], ["Shift", "⇧"], ["Accel", "⌘"]];
  const MAC_KEYS = { Enter: "↩" };

  // "Accel+Shift+B" becomes "⇧⌘B" on macOS, "Ctrl+Shift+B" elsewhere.
  function shortcut(text, mac) {
    const parts = String(text).split("+");
    const key = parts.pop();
    if (mac) {
      const symbols = MAC_MODIFIERS.filter(([name]) => parts.includes(name)).map(([, symbol]) => symbol);
      return symbols.join("") + (MAC_KEYS[key] ?? key);
    }
    return [...parts.map(name => (name === "Accel" ? "Ctrl" : name)), key].join("+");
  }

  return { STRINGS, pickLanguage, label, shortcut };
})();
