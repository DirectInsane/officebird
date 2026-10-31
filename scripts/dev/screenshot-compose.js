// Opens a compose window with a made-up reply for the screenshots (run via marionette.mjs
// after screenshot-setup.js). Returns once the ribbon is there.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const main = Services.wm.getMostRecentWindow("mail:3pane");
const wait = ms => new Promise(resolve => main.setTimeout(resolve, ms));
for (const old of Services.wm.getEnumerator("msgcompose")) {
  old.close();
}
const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
fields.to = "Mia Johnson <mia.johnson@example.org>";
fields.subject = "Re: Dinner on Friday?";
fields.body = "<p>Hi Mia,</p><p>Friday works great! How about <b>7 pm</b> at the Italian place on Market Street? I will book a table for four.</p><ul><li>Ben is in, too</li><li>Olivia will let us know tomorrow</li></ul><p>See you then,<br>Alex</p>";
params.composeFields = fields;
params.type = Ci.nsIMsgCompType.New;
params.format = Ci.nsIMsgCompFormat.HTML;
params.identity = MailServices.accounts.allIdentities.find(identity => identity.email === "alex@example.org");
MailServices.compose.OpenComposeWindowWithParams(null, params);
let win = null;
for (let i = 0; i < 100 && !(win?.composeEditorReady && win.qolCompose); i++) {
  await wait(100);
  win = [...Services.wm.getEnumerator("msgcompose")].findLast(w => !w.closed);
}
// As in screenshot-setup.js: the native window background is missing from screenshots.
win.windowUtils.loadSheetUsingURIString("data:text/css,:root { appearance: none !important; }", win.windowUtils.AUTHOR_SHEET);
win.moveTo(80, 60);
win.resizeTo(1100, 600);
win.focus();
await wait(1500);
return { ribbon: Boolean(win.document.getElementById("qol-ribbon")) };
