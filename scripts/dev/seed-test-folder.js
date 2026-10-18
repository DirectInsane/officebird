// Creates Local Folders/Officebird Test with sample messages (run via marionette.mjs).
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

const headers = Services.prefs.getCharPref("mailnews.customDBHeaders", "");
if (!headers.split(/\s+/).includes("authentication-results")) {
  Services.prefs.setCharPref("mailnews.customDBHeaders", (headers + " authentication-results").trim());
}

let localServer = null;
try {
  localServer = MailServices.accounts.localFoldersServer;
} catch (e) {}
if (!localServer) {
  MailServices.accounts.createLocalMailAccount();
}
const root = MailServices.accounts.localFoldersServer.rootFolder;
let folder = root.getChildNamed("Officebird Test");
if (folder) {
  if (!globalThis.QOL_RESEED) {
    return { existing: folder.URI, count: folder.getTotalMessages(false) };
  }
  folder.deleteSelf(null);
  root.emptyTrash?.(null);
}
folder = root.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder("Officebird Test");
const local = folder.QueryInterface(Ci.nsIMsgLocalMailFolder);

let n = 0;
function msg({ from, subject, auth = [], body, html = false }) {
  n++;
  const date = new Date(Date.UTC(2026, 9, 17, 12, 0, 0) - n * 3600_000).toUTCString().replace("GMT", "+0000");
  const lines = [
    ...auth.map(a => `Authentication-Results: ${a}`),
    `From: ${from}`,
    `To: tester@example.org`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <qol-${n}@test.invalid>`,
    `MIME-Version: 1.0`,
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`,
    ``,
    body,
    ``,
  ];
  // addMessage takes a byte string, so encode as UTF-8 first.
  local.addMessage(String.fromCharCode(...new TextEncoder().encode(lines.join("\r\n"))));
}

const LOREM = "Hallo zusammen, anbei die Zusammenfassung der letzten Woche. Wir haben die offenen Punkte besprochen und die nächsten Schritte festgelegt. Bitte gebt bis Freitag Rückmeldung, ob die Termine passen. Viele Grüße und ein schönes Wochenende!";

msg({ from: "GitHub <noreply@github.com>", subject: "[repo] New pull request opened", auth: ["mx.test.local; dkim=pass header.d=github.com; spf=pass; dmarc=pass header.from=github.com"], body: "A new pull request was opened by octocat. " + LOREM });
msg({ from: "Anna Smith <anna.smith@gmx.de>", subject: "Kaffee morgen?", auth: ["mx.test.local; dkim=pass header.d=gmx.de; dmarc=pass header.from=gmx.de"], body: "Hi! Hast du morgen Zeit für einen Kaffee? " + LOREM });
msg({ from: "PayPal <service@paypal.com>", subject: "Your account is limited", auth: [], body: "Please verify your account immediately by clicking the link below." });
msg({ from: "\"Doe, John\" <john@mail.example.co.uk>", subject: "Quarterly report", auth: ["mx.test.local 1; dkim=pass header.d=example.co.uk; dmarc=none"], body: "Please find the quarterly report attached. " + LOREM });
msg({ from: "Amazon <ship-confirm@amazon.de>", subject: "Two auth headers: top fail, bottom pass", auth: ["mx.test.local; dmarc=fail header.from=amazon.de", "mx.test.local; dmarc=pass header.from=amazon.de"], body: "Your order has shipped." });
msg({ from: "Newsletter <news@mozilla.org>", subject: "HTML with remote image", auth: ["mx.test.local; dkim=pass header.d=mozilla.org; dmarc=pass header.from=mozilla.org"], html: true, body: "<html><body><p>Remote image below:</p><img src=\"https://www.mozilla.org/media/img/favicons/mozilla/favicon-196x196.png\"></body></html>" });
msg({ from: "=?UTF-8?B?w5Zsc2Egw4RobQ==?= <oelsa@posteo.de>", subject: "Encoded sender name", auth: [], body: "Umlaut sender. " + LOREM });
msg({ from: "undisclosed-recipients:;", subject: "No sender address", auth: [], body: "Broken From header." });
for (let i = 0; i < 300; i++) {
  const domains = ["github.com", "mozilla.org", "wikipedia.org", "example.com", "gmail.com"];
  const d = domains[i % domains.length];
  msg({ from: `Sender ${i} <user${i}@${d}>`, subject: `Filler message ${i}`, auth: [`mx.test.local; dmarc=pass header.from=${d}`], body: `Filler body ${i}. ` + LOREM });
}
return { created: folder.URI, count: folder.getTotalMessages(false) };
