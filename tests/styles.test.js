import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStylesheet, hexToRgba } from "../experiments/qol/styles.mjs";

const DEFAULT_CFG = { iconsEnabled: true, preview: { enabled: true, lines: 2 }, bar: { background: "#e8e8e8", text: "#333333", opacity: 60, compact: false } };

test("hexToRgba", () => {
  assert.equal(hexToRgba("#e8e8e8", 60), "rgba(232, 232, 232, 0.6)");
  assert.equal(hexToRgba("#000000", 0), "rgba(0, 0, 0, 0)");
});

test("bar variables and preview clamp are emitted", () => {
  const css = buildStylesheet({ ...DEFAULT_CFG, preview: { enabled: true, lines: 3 }, bar: { ...DEFAULT_CFG.bar, compact: true } });
  assert.match(css, /notification-message\[value="remoteContent"\]\s*\{[^}]*--message-bar-background-color:\s*rgba\(232, 232, 232, 0\.6\)/);
  assert.match(css, /--message-bar-text-color:\s*#333333/);
  assert.match(css, /\.qol-preview\s*\{[^}]*-webkit-line-clamp:\s*3/);
  assert.match(css, /\.qol-preview\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(css, /font-size:\s*0\.85em/);
});

test("avatar gets its own grid column in the card", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.card-container:has\(> \.qol-avatar\)\s*\{[^}]*grid-template-columns:\s*auto auto 1fr/);
});

test("image avatars get a light backdrop so dark favicons stay visible", () => {
  assert.match(buildStylesheet(DEFAULT_CFG), /img\.qol-avatar\s*\{[^}]*background-color:\s*#fff/);
});

test("unsafe colors throw", () => {
  assert.throws(() => buildStylesheet({ ...DEFAULT_CFG, bar: { ...DEFAULT_CFG.bar, background: "red;}" } }));
  assert.throws(() => buildStylesheet({ ...DEFAULT_CFG, bar: { ...DEFAULT_CFG.bar, text: "#fff" } }));
});

test("disabled features emit no rules", () => {
  assert.doesNotMatch(buildStylesheet({ ...DEFAULT_CFG, preview: { enabled: false, lines: 2 } }), /qol-preview/);
  assert.doesNotMatch(buildStylesheet({ ...DEFAULT_CFG, iconsEnabled: false }), /qol-avatar/);
  assert.doesNotMatch(buildStylesheet(DEFAULT_CFG), /0\.85em/);
});

test("Outlook layout: preview sits directly under the subject in its own grid row", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.thread-card-dynamic-row:has\(> \.qol-preview\)\s*\{[^}]*grid-template:\s*"subject subject" max-content\s*"qolpreview qolpreview" max-content\s*"button info"/);
  assert.match(css, /\.cards-row-compact \.thread-card-dynamic-row:has\(> \.qol-preview\)\s*\{[^}]*"button subject info" max-content\s*"qolpreview qolpreview qolpreview"/);
  assert.match(css, /\.qol-preview\s*\{[^}]*grid-area:\s*qolpreview/);
});

test("Outlook layout: preview is plain grey text, distinct from the bold subject", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.qol-preview\s*\{[^}]*font-weight:\s*normal/);
  assert.match(css, /\.qol-preview\s*\{[^}]*color:\s*color-mix\(in srgb, currentColor 45%, transparent\)/);
  assert.doesNotMatch(css, /\.qol-preview\s*\{[^}]*opacity/);
});

test("preview tone setting sets how much text color the preview keeps", () => {
  const css = buildStylesheet({ ...DEFAULT_CFG, preview: { enabled: true, lines: 2, tone: 52 } });
  assert.match(css, /\.qol-preview\s*\{[^}]*color:\s*color-mix\(in srgb, currentColor 52%, transparent\)/);
  assert.throws(() => buildStylesheet({ ...DEFAULT_CFG, preview: { enabled: true, lines: 2, tone: "5%;}" } }));
  assert.throws(() => buildStylesheet({ ...DEFAULT_CFG, preview: { enabled: true, lines: 2, tone: 95 } }));
});

test("Outlook layout: preview a step smaller than the subject, with a little air above", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.qol-preview\s*\{[^}]*font-size:\s*0\.9em/);
  assert.match(css, /\.thread-card-dynamic-row > \.qol-preview\s*\{[^}]*margin-block-start:\s*2px/);
});

test("Outlook layout: avatar sits top-left", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.qol-avatar\s*\{[^}]*align-self:\s*start/);
});

const TABLE_CFG = { ...DEFAULT_CFG, preview: { enabled: true, lines: 2, tableLines: 2 }, table: { dateStyle: "smart" } };

test("table view: preview is a grey second line inside the subject, clamped to tableLines", () => {
  const css = buildStylesheet(TABLE_CFG);
  assert.match(css, /\.subject-line > \.qol-preview\s*\{[^}]*-webkit-line-clamp:\s*2/);
  assert.match(css, /\.subject-line > \.qol-preview\s*\{[^}]*white-space:\s*normal/);
  assert.match(css, /tr\.qol-two-line > td\s*\{[^}]*vertical-align:\s*top/);
});

test("table view: small round avatar before the sender name", () => {
  const css = buildStylesheet(TABLE_CFG);
  assert.match(css, /\.table-layout \.qol-avatar\s*\{[^}]*width:\s*18px/);
  assert.match(css, /\.table-layout \.qol-avatar\s*\{[^}]*vertical-align:\s*middle/);
  // Table cells use text-indent; inherited, it pushes initials out of the circle.
  assert.match(css, /\.table-layout \.qol-avatar,\s*\.table-layout \.qol-avatar::after\s*\{[^}]*text-indent:\s*0/);
  assert.doesNotMatch(buildStylesheet({ ...TABLE_CFG, iconsEnabled: false }), /\.table-layout \.qol-avatar/);
});

test("table view: no table preview rules when previews are off", () => {
  assert.doesNotMatch(buildStylesheet({ ...TABLE_CFG, preview: { enabled: false, lines: 2, tableLines: 2 } }), /qol-two-line/);
});

const OUTLOOK_CFG = { ...TABLE_CFG, style: { outlook: true, barWidth: 4, cardRadius: 9, cardGap: 6, readSender: 62, readSubject: 100 } };

test("outlook style: slider values become CSS variables", () => {
  const css = buildStylesheet(OUTLOOK_CFG);
  assert.match(css, /--qol-bar-width:\s*4px/);
  assert.match(css, /--qol-card-radius:\s*9px/);
  assert.match(css, /--qol-card-gap:\s*6px/);
});

test("outlook style: the bar is a background strip from the outer edge, clipped by the card's corners", () => {
  const css = buildStylesheet(OUTLOOK_CFG);
  assert.match(css, /tr\.card-layout \.card-container\s*\{[^}]*border-radius:\s*var\(--qol-card-radius\)/);
  assert.match(css, /background-image:\s*linear-gradient\(to right, var\(--qol-bar-color\) var\(--qol-bar-size\), transparent var\(--qol-bar-size\)\)/);
  assert.match(css, /background-origin:\s*border-box/);
  assert.match(css, /\[data-properties~="unread"\] \.card-container\s*\{[^}]*--qol-bar-color:\s*var\(--qol-unread\)/);
  // Borders of different width meet at a diagonal (trapezoid at 0px corners): never widen the border.
  assert.doesNotMatch(css, /border-inline-start-width/);
});

test("outlook style: gap between cards", () => {
  assert.match(buildStylesheet(OUTLOOK_CFG), /tr\.card-layout > td\s*\{[^}]*padding-block:\s*calc\(var\(--qol-card-gap\) \/ 2\)/);
});

test("outlook style: invisible 12px toggle over the left edge", () => {
  const css = buildStylesheet(OUTLOOK_CFG);
  assert.match(css, /\.qol-read-toggle\s*\{[^}]*position:\s*absolute[^}]*width:\s*12px[^}]*background:\s*transparent/);
});

test("outlook style: hovering the edge shows a strip 1px wider than the bar (grey on read, brighter on unread)", () => {
  const css = buildStylesheet(OUTLOOK_CFG);
  const read = css.match(/:not\(\[data-properties~="unread"\]\) \.card-container:has\(> \.qol-read-toggle:hover\)\s*\{[^}]*\}/);
  assert.ok(read, "read hover rule");
  assert.match(read[0], /--qol-bar-size:\s*calc\(var\(--qol-bar-width\) \+ 1px\)/);
  assert.match(read[0], /--qol-bar-color:\s*color-mix/);
  const unread = css.match(/\[data-properties~="unread"\] \.card-container:has\(> \.qol-read-toggle:hover\)\s*\{[^}]*\}/);
  assert.ok(unread, "unread hover rule");
  assert.match(unread[0], /--qol-bar-size:\s*calc\(var\(--qol-bar-width\) \+ 1px\)/);
});

test("outlook style: values are validated before reaching CSS", () => {
  assert.throws(() => buildStylesheet({ ...OUTLOOK_CFG, style: { outlook: true, barWidth: "3px;}", cardRadius: 7, cardGap: 4 } }));
});

test("outlook style: unread subject blue and bold", () => {
  const css = buildStylesheet(OUTLOOK_CFG);
  assert.match(css, /\[data-properties~="unread"\][^{]*\.subject[^{]*\{[^}]*color:\s*var\(--qol-unread\)/);
});

test("outlook style: read sender and subject keep the configured share of the text color", () => {
  const css = buildStylesheet({ ...OUTLOOK_CFG, style: { ...OUTLOOK_CFG.style, readSender: 62, readSubject: 88 } });
  assert.match(css, /--qol-read-sender:\s*62%/);
  assert.match(css, /--qol-read-subject:\s*88%/);
  assert.match(css, /\[data-properties~="read"\] \.card-container \.sender\s*\{[^}]*color:\s*color-mix\(in srgb, currentColor var\(--qol-read-sender\), transparent\) !important/);
  assert.match(css, /\[data-properties~="read"\] \.card-container \.subject\s*\{[^}]*color:\s*color-mix\(in srgb, currentColor var\(--qol-read-subject\), transparent\) !important/);
});

test("outlook style: read colors outrank themes that style #threadTree card subjects", () => {
  // e.g. Clean Themes: #threadTree[rows="thread-card"] .card-layout:not([data-properties~="unread"]) .card-container .subject
  const css = buildStylesheet(OUTLOOK_CFG);
  assert.match(css, /:root #threadTree tr\.card-layout\[data-properties~="read"\] \.card-container \.subject\s*\{/);
});

test("outlook style: read tones are validated", () => {
  assert.throws(() => buildStylesheet({ ...OUTLOOK_CFG, style: { ...OUTLOOK_CFG.style, readSender: 20 } }));
  assert.throws(() => buildStylesheet({ ...OUTLOOK_CFG, style: { ...OUTLOOK_CFG.style, readSubject: "1;}" } }));
});

test("outlook style: stepped sizes, sender over subject over preview", () => {
  const css = buildStylesheet(OUTLOOK_CFG);
  assert.match(css, /\.card-container \.sender\s*\{[^}]*font-size:\s*1\.06rem !important/);
  assert.match(css, /\.card-container \.subject\s*\{[^}]*font-size:\s*1rem !important/);
});

test("outlook style: no read dot; table dot only on hover", () => {
  const css = buildStylesheet(OUTLOOK_CFG);
  assert.match(css, /\.card-layout \.read-status\s*\{[^}]*visibility:\s*hidden/);
  assert.match(css, /tr\[data-properties~="read"\]:not\(:hover\) \.tree-button-unread\s*\{[^}]*visibility:\s*hidden/);
});

test("outlook style off: none of it", () => {
  const css = buildStylesheet({ ...OUTLOOK_CFG, style: { outlook: false } });
  assert.doesNotMatch(css, /--qol-unread|read-status|tree-button-unread/);
});

const GROUP_CFG = { ...OUTLOOK_CFG, style: { ...OUTLOOK_CFG.style, groupHeaders: true } };

test("compact group headers: header rows in cards view are one slim line", () => {
  const css = buildStylesheet(GROUP_CFG);
  assert.match(css, /#threadTree tr\.card-layout\[data-properties~="dummy"\]\s*\{[^}]*height:\s*var\(--qol-group-header-height, 28px\) !important/);
  assert.match(css, /\[data-properties~="dummy"\] \.thread-card-row,[^{]*\.qol-avatar,[^{]*\.qol-preview,[^{]*\.qol-read-toggle\s*\{[^}]*display:\s*none/);
  assert.match(css, /\[data-properties~="dummy"\] \.card-container\s*\{[^}]*background:\s*transparent !important[^}]*border-bottom:/);
  // Thunderbird's divider between collapsed headers would cross the slim header's text.
  assert.match(css, /\[data-properties~="dummy"\] \.card-container::after\s*\{[^}]*display:\s*none/);
});

test("compact group headers: also without the Outlook style", () => {
  const css = buildStylesheet({ ...TABLE_CFG, style: { outlook: false, groupHeaders: true } });
  assert.match(css, /data-properties~="dummy"/);
});

test("compact group headers off: Thunderbird's own header rows", () => {
  const css = buildStylesheet({ ...OUTLOOK_CFG, style: { ...OUTLOOK_CFG.style, groupHeaders: false } });
  assert.doesNotMatch(css, /dummy|qol-group-header-height/);
});

const look = cardLook => buildStylesheet({ ...TABLE_CFG, style: { outlook: false, cardLook } });

test("card look theme: the theme decides, no card rules", () => {
  assert.doesNotMatch(look("theme"), /--qol-card-fill|--qol-card-line/);
});

test("card look: fills and outlines follow the text color, so they suit any theme", () => {
  assert.match(look("filled"), /--qol-card-fill:\s*color-mix\(in srgb, currentColor \d+%, transparent\)/);
  assert.match(look("filled"), /--qol-card-line:\s*transparent/);
  assert.match(look("outline"), /--qol-card-fill:\s*transparent/);
  assert.match(look("outline"), /--qol-card-line:\s*color-mix\(in srgb, currentColor \d+%, transparent\)/);
  assert.doesNotMatch(look("both"), /--qol-card-(fill|line):\s*transparent/);
});

test("card look: resting cards only, so selection and hover keep the theme's colors", () => {
  const css = look("filled");
  assert.match(css, /tr\.card-layout:not\(\[data-properties~="dummy"\], \.selected, \.current, :hover\) > td > \.card-container\s*\{[^}]*background-color:\s*var\(--qol-card-fill\) !important[^}]*border-color:\s*var\(--qol-card-line\) !important/);
});

test("card look: themes' row separator lines go away between cards", () => {
  assert.match(look("outline"), /:root #threadTree\[rows="thread-card"\] tr\.card-layout:not\(\[data-properties~="dummy"\]\) > td\s*\{[^}]*background:\s*none !important/);
});

test("unknown card look throws", () => {
  assert.throws(() => look("neon;}"));
});

test("card look: unread cards keep a clear left edge for the blue bar", () => {
  assert.match(look("outline"), /\.current, :hover\)\[data-properties~="unread"\] > td > \.card-container\s*\{[^}]*border-inline-start-color:\s*transparent !important/);
});

test("card avatars keep 3px extra distance from the read/unread bar", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.qol-avatar\s*\{[^}]*margin-inline-start:\s*3px/);
  // Table view resets it with its own margin.
  assert.match(css, /\.table-layout \.qol-avatar\s*\{[^}]*margin:\s*0 6px 0 0/);
});

test("reading pane: sender logo gets the same light backdrop as in the list", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.recipient-avatar\.qol-reader-avatar > img\s*\{[^}]*background-color:\s*#fff[^}]*object-fit:\s*contain/);
});

test("reading pane: initials use the list's color and an unverified sender gets the red !", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.recipient-avatar\.qol-reader-avatar > span\s*\{[^}]*color:\s*#fff/);
  assert.match(css, /\.recipient-avatar\.qol-reader-avatar\[data-unverified\]::after\s*\{[^}]*content:\s*"!"/);
});

test("reading pane: no reader avatar rules without icons", () => {
  assert.doesNotMatch(buildStylesheet({ ...DEFAULT_CFG, iconsEnabled: false }), /qol-reader-avatar/);
});

test("the card delete button shows on hover and stays hidden for mail marked deleted", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  assert.match(css, /\.qol-delete\s*\{[^}]*background:[^;]*var\(--icon-trash-sm\)/);
  assert.match(css, /:root #threadTree tr\.card-layout \.qol-delete\s*\{\s*opacity:\s*0;/);
  assert.match(css, /:root #threadTree tr\.card-layout:is\(:hover, \.selected\) \.qol-delete\s*\{[^}]*opacity/);
  assert.match(css, /\[data-properties~="imapdeleted"\] \.qol-delete\s*\{[^}]*display:\s*none/);
});

test("search results: the card folder label is small text in a share of the text color", () => {
  const css = buildStylesheet(DEFAULT_CFG);
  const rule = css.match(/\.qol-folder-label\s*\{[^}]*\}/)?.[0];
  assert.ok(rule, "no .qol-folder-label rule");
  assert.match(rule, /font-size:\s*0\.\d+em/);
  assert.match(rule, /color:\s*var\(--qol-[a-z-]+\)/);
  assert.doesNotMatch(rule, /#[0-9a-f]{3,6}\b/i);
  assert.match(css, /--qol-folder-label-color:\s*color-mix\(in srgb, currentColor \d+%, transparent\)/);
});
