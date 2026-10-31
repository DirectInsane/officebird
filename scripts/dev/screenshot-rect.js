// Returns "x y width height" of an element of the main window in screenshot pixels, for
// cropping (run via marionette.mjs after a line that sets globalThis.QOL_SELECTOR).
const win = Services.wm.getMostRecentWindow("mail:3pane");
const box = win.document.querySelector(globalThis.QOL_SELECTOR).getBoundingClientRect();
return [box.x, box.y, box.width, box.height].map(v => Math.round(v * win.devicePixelRatio)).join(" ");
