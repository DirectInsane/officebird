// Pure functions: imported by the background page and by Node tests.

const HEX = /^#[0-9a-f]{6}$/i;
// Card surfaces as a share of the text color, so they suit light, dark and
// custom themes alike. "theme" leaves the cards to Thunderbird or the theme.
const CARD_LOOKS = {
  outline: { fill: "transparent", line: "color-mix(in srgb, currentColor 20%, transparent)" },
  filled: { fill: "color-mix(in srgb, currentColor 7%, transparent)", line: "transparent" },
  both: { fill: "color-mix(in srgb, currentColor 5%, transparent)", line: "color-mix(in srgb, currentColor 13%, transparent)" },
};

function checkColor(value) {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new Error(`[qol] invalid color: ${value}`);
  }
  return value.toLowerCase();
}

function checkInt(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`[qol] invalid style value: ${value}`);
  }
  return value;
}

export function hexToRgba(hex, opacityPercent) {
  const value = checkColor(hex);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  const alpha = Math.min(100, Math.max(0, Number(opacityPercent) || 0)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function buildStylesheet(config) {
  const { bar, preview, iconsEnabled } = config;
  const rules = [];

  rules.push(`notification-message[value="remoteContent"] {
  --message-bar-background-color: ${hexToRgba(bar.background, bar.opacity)} !important;
  --message-bar-text-color: ${checkColor(bar.text)} !important;
}`);
  if (bar.compact) {
    rules.push(`notification-message[value="remoteContent"] {
  font-size: 0.85em !important;
  margin-block: 0 !important;
}`);
  }

  // Card delete button (cardmenu.js), drawn like the star and the message menu next to it.
  rules.push(`.qol-delete {
  appearance: none;
  inline-size: 16px;
  block-size: 16px;
  min-width: 0;
  min-height: 0;
  margin: 0 auto;
  padding: 0;
  border: 0;
  background: transparent var(--icon-trash-sm) center / 16px no-repeat;
  -moz-context-properties: fill, stroke;
  fill: currentColor;
  stroke: currentColor;
  cursor: pointer;
}
/* Thunderbird gives every card button 70 % opacity; ":root #threadTree" outranks it. */
:root #threadTree tr.card-layout .qol-delete {
  opacity: 0;
}
:root #threadTree tr.card-layout:is(:hover, .selected) .qol-delete {
  opacity: 0.55;
}
:root #threadTree tr.card-layout .qol-delete:hover {
  opacity: 1;
  color: var(--tree-row-delete-button-color);
}
[data-properties~="imapdeleted"] .qol-delete {
  display: none;
}`);

  if (iconsEnabled) {
    // Thunderbird's card is a two-column grid (read status | content); the avatar adds a third.
    rules.push(`.card-container:has(> .qol-avatar) {
  grid-template-columns: auto auto 1fr !important;
}
.qol-avatar {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-inline-start: 3px;
  margin-inline-end: 6px;
  margin-block-start: 6px;
  align-self: start;
  border-radius: 50%;
  object-fit: cover;
  position: relative;
  box-sizing: border-box;
}
img.qol-avatar {
  background-color: #fff;
  padding: 4px;
  object-fit: contain;
  box-shadow: 0 0 0 1px rgba(128, 128, 128, 0.3);
}
span.qol-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  font-weight: bold;
  line-height: 1;
}
.qol-avatar[data-unverified]::after {
  content: "!";
  position: absolute;
  inset-inline-end: -3px;
  bottom: -3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #d70022;
  color: #fff;
  font-size: 9px;
  line-height: 12px;
  text-align: center;
}`);
  }

  if (preview.enabled) {
    rules.push(`.thread-card-dynamic-row:has(> .qol-preview) {
  grid-template:
    "subject subject" max-content
    "qolpreview qolpreview" max-content
    "button info" minmax(auto, 1fr)
    / auto 1fr !important;
}
.cards-row-compact .thread-card-dynamic-row:has(> .qol-preview) {
  grid-template:
    "button subject info" max-content
    "qolpreview qolpreview qolpreview" max-content
    / auto 1fr auto !important;
}
.qol-preview {
  grid-area: qolpreview;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: ${Math.min(5, Math.max(1, Math.round(preview.lines)))};
  overflow: hidden;
  flex-shrink: 0;
  white-space: normal;
  font-size: 0.9em;
  font-weight: normal;
  font-style: normal;
  line-height: 1.35;
  color: color-mix(in srgb, currentColor ${checkInt(preview.tone ?? 45, 30, 80)}%, transparent);
}
.thread-card-dynamic-row > .qol-preview {
  margin-block-start: 2px;
}`);
  }

  if (iconsEnabled) {
    rules.push(`.table-layout .qol-avatar {
  display: inline-flex;
  width: 18px;
  height: 18px;
  margin: 0 6px 0 0;
  vertical-align: middle;
  font-size: 9px;
}
.table-layout .qol-avatar,
.table-layout .qol-avatar::after {
  text-indent: 0;
}
.table-layout img.qol-avatar {
  padding: 2px;
}
.table-layout .qol-avatar[data-unverified]::after {
  width: 9px;
  height: 9px;
  font-size: 7px;
  line-height: 9px;
}
/* Reading pane: the sender's avatar in the message header shows the same
   result as the message list. */
.recipient-avatar.qol-reader-avatar {
  position: relative;
  overflow: visible !important;
}
.recipient-avatar.qol-reader-avatar > img {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border-radius: 50%;
  background-color: #fff;
  padding: 15%;
  object-fit: contain;
  box-shadow: 0 0 0 1px rgba(128, 128, 128, 0.3);
}
.recipient-avatar.qol-reader-avatar > span {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  color: #fff;
  font-weight: bold;
}
.recipient-avatar.qol-reader-avatar[data-unverified]::after {
  content: "!";
  position: absolute;
  inset-inline-end: -2px;
  bottom: -2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #d70022;
  color: #fff;
  font-size: 10px;
  font-weight: bold;
  line-height: 14px;
  text-align: center;
}`);
  }

  if (preview.enabled) {
    const tableLines = Math.min(3, Math.max(1, Math.round(preview.tableLines ?? 1)));
    rules.push(`tr.qol-two-line > td {
  vertical-align: top !important;
  padding-block-start: 3px !important;
}
.subject-line > .qol-preview {
  display: -webkit-box;
  -webkit-line-clamp: ${tableLines};
  white-space: normal;
  margin-block-start: 1px;
  margin-inline-start: var(--qol-subject-indent, 19px);
}`);
  }

  const cardLook = config.style?.cardLook ?? "theme";
  if (cardLook !== "theme") {
    if (!Object.hasOwn(CARD_LOOKS, cardLook)) {
      throw new Error(`[qol] invalid card look: ${cardLook}`);
    }
    const { fill, line } = CARD_LOOKS[cardLook];
    // Selected, current and hovered cards keep the theme's state colors. Flat-row themes
    // (e.g. Clean Themes) blank the card variables and paint a separator on the cell.
    rules.push(`:root #threadTree[rows="thread-card"] {
  --qol-card-fill: ${fill};
  --qol-card-line: ${line};
}
:root #threadTree[rows="thread-card"] tr.card-layout:not([data-properties~="dummy"]) > td {
  background: none !important;
}
:root #threadTree[rows="thread-card"] tr.card-layout:not([data-properties~="dummy"], .selected, .current, :hover) > td > .card-container {
  background-color: var(--qol-card-fill) !important;
  border-color: var(--qol-card-line) !important;
}
:root #threadTree[rows="thread-card"] tr.card-layout:not([data-properties~="dummy"], .selected, .current, :hover)[data-properties~="unread"] > td > .card-container {
  border-inline-start-color: transparent !important;
}`);
  }

  if (config.style?.groupHeaders) {
    // The experiment sets --qol-group-header-height and converts the list's row positions to it.
    const dummy = `:root #threadTree tr.card-layout[data-properties~="dummy"]`;
    rules.push(`#threadTree tr.card-layout[data-properties~="dummy"] {
  height: var(--qol-group-header-height, 28px) !important;
}
${dummy} > td {
  padding: 0 !important;
  height: var(--qol-group-header-height, 28px);
}
${dummy} .card-container {
  display: flex !important;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: var(--qol-group-header-height, 28px);
  margin: 0 !important;
  padding: 0 6px !important;
  background: transparent !important;
  border: 0 !important;
  border-bottom: 1px solid color-mix(in srgb, currentColor 22%, transparent) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
/* Thunderbird's divider between collapsed headers; the bottom border above replaces it. */
${dummy} .card-container::after {
  display: none !important;
}
${dummy}.selected .card-container {
  background: color-mix(in srgb, currentColor 10%, transparent) !important;
}
${dummy} .card-container > .thread-card-column:first-child,
${dummy} .thread-card-row,
${dummy} .qol-avatar,
${dummy} .qol-preview,
${dummy} .qol-read-toggle {
  display: none !important;
}
${dummy} .thread-card-column {
  display: contents !important;
}
${dummy} .thread-card-dynamic-row {
  display: flex !important;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
${dummy} .thread-card-button {
  order: 0;
  padding: 0 !important;
  min-height: 0 !important;
}
${dummy} .thread-card-subject-container {
  order: 1;
}
${dummy} .card-container .subject {
  color: inherit !important;
  font-size: 1rem !important;
  font-weight: 600 !important;
}
${dummy} .sort-header-details {
  order: 2;
  font-size: 0.9em;
  color: color-mix(in srgb, currentColor 65%, transparent);
}`);
  }

  if (config.style?.outlook) {
    const px = (value, min, max) => `${checkInt(value, min, max)}px`;
    const pct = (value, min, max) => `${checkInt(value, min, max)}%`;
    const { barWidth, cardRadius, cardGap, readSender = 62, readSubject = 100 } = config.style;
    // The unread bar is a background strip from the card's outer edge so the card's corner
    // rounding clips it; a wider left border would meet the top/bottom borders at a diagonal.
    rules.push(`:root {
  --qol-unread: light-dark(#0b63ce, #4c9dff);
  --qol-bar-width: ${px(barWidth, 2, 6)};
  --qol-card-radius: ${px(cardRadius, 0, 12)};
  --qol-card-gap: ${px(cardGap, 0, 12)};
  --qol-read-sender: ${pct(readSender, 40, 100)};
  --qol-read-subject: ${pct(readSubject, 40, 100)};
}
tr.card-layout > td {
  padding-block: calc(var(--qol-card-gap) / 2) !important;
}
tr.card-layout .card-container {
  --qol-bar-color: transparent;
  --qol-bar-size: var(--qol-bar-width);
  border-radius: var(--qol-card-radius) !important;
  padding-inline-start: calc(var(--qol-bar-width) + 2px) !important;
  background-image: linear-gradient(to right, var(--qol-bar-color) var(--qol-bar-size), transparent var(--qol-bar-size)) !important;
  background-origin: border-box !important;
  background-repeat: no-repeat !important;
}
.card-layout[data-properties~="unread"] .card-container {
  --qol-bar-color: var(--qol-unread);
  border-inline-start-color: transparent !important;
}
.card-layout.selected[data-properties~="unread"] .card-container {
  --qol-bar-color: color-mix(in srgb, var(--qol-unread) 30%, white);
}
.card-layout:not([data-properties~="unread"]) .card-container:has(> .qol-read-toggle:hover) {
  --qol-bar-color: color-mix(in srgb, currentColor 50%, transparent);
  --qol-bar-size: calc(var(--qol-bar-width) + 1px);
  border-inline-start-color: transparent !important;
}
.card-layout[data-properties~="unread"] .card-container:has(> .qol-read-toggle:hover) {
  --qol-bar-color: color-mix(in srgb, var(--qol-unread) 75%, white);
  --qol-bar-size: calc(var(--qol-bar-width) + 1px);
}
/* Invisible click zone over the left edge: toggles read/unread. */
.qol-read-toggle {
  appearance: none !important;
  position: absolute !important;
  inset-block: 0;
  inset-inline-start: -1px;
  width: 12px;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  cursor: pointer;
  z-index: 2;
}
.card-layout[data-properties~="unread"] .card-container .subject,
.table-layout[data-properties~="unread"] .subjectcol-column .subject-line > span {
  color: var(--qol-unread) !important;
  font-weight: bold !important;
}
.card-layout[data-properties~="unread"] .card-container .sender {
  font-weight: bold !important;
}
/* Read mail fades back to a share of the normal text color. ":root #threadTree
   tr" outranks themes that grey out card subjects from #threadTree. */
:root #threadTree tr.card-layout[data-properties~="read"] .card-container .sender {
  color: color-mix(in srgb, currentColor var(--qol-read-sender), transparent) !important;
}
:root #threadTree tr.card-layout[data-properties~="read"] .card-container .subject {
  color: color-mix(in srgb, currentColor var(--qol-read-subject), transparent) !important;
}
/* Stepped sizes: sender, then subject, then the preview a step smaller. */
:root #threadTree tr.card-layout .card-container .sender {
  font-size: 1.06rem !important;
}
:root #threadTree tr.card-layout .card-container .subject {
  font-size: 1rem !important;
}
.card-layout .read-status {
  visibility: hidden;
}
tr[data-properties~="read"]:not(:hover) .tree-button-unread {
  visibility: hidden;
}`);
  }

  return rules.join("\n");
}
