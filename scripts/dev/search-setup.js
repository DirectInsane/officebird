// Creates the search test data (run via marionette.mjs): Local Folders/Search Test with
// Inbox and Archive (12 mails), and a second "none" account "Search Second" with an
// Inbox of 3 mails. Returns { folders } URIs; set QOL_RESEED to recreate the mails.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

let localServer = null;
try {
  localServer = MailServices.accounts.localFoldersServer;
} catch (e) {}
if (!localServer) {
  MailServices.accounts.createLocalMailAccount();
}
const root = MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

let secondServer = MailServices.accounts.findServer("searchsecond", "search.test", "none");
if (!secondServer) {
  secondServer = MailServices.accounts.createIncomingServer("searchsecond", "search.test", "none");
  secondServer.prettyName = "Search Second";
  const account = MailServices.accounts.createAccount();
  account.incomingServer = secondServer;
  MailServices.accounts.saveAccountInfo?.();
}
const secondRoot = secondServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

function subfolder(parent, name) {
  return parent.getChildNamed(name) ?? parent.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder(name);
}

let top = root.getChildNamed("Search Test");
const secondInbox = subfolder(secondRoot, "Inbox");
if (top && !globalThis.QOL_RESEED) {
  return { folders: [top.getChildNamed("Inbox"), top.getChildNamed("Archive"), secondInbox].map(f => f.URI) };
}
if (top) {
  top.deleteSelf(null);
  root.emptyTrash?.(null);
}
const old = [...secondInbox.messages];
if (old.length) {
  secondInbox.deleteMessages(old, null, true, false, null, false);
}
top = root.createLocalSubfolder("Search Test");
const inbox = subfolder(top, "Inbox");
const archive = subfolder(top, "Archive");
const folders = [inbox, archive, secondInbox];

function toBytes(text) {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

function base64(text) {
  return btoa(toBytes(text)).replace(/.{76}/g, "$&\r\n");
}

function quotedPrintable(text) {
  return toBytes(text).replace(/[=\x80-\xff]/g, c => "=" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

let n = 0;
// Returns the new header. `parts` builds a multipart/mixed mail instead of a single body.
function msg(folder, { from, subject, body = "", encoding = "8bit", type = "text/plain", parts = null }) {
  n++;
  const date = new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - n * 3600_000).toUTCString().replace("GMT", "+0000");
  const id = `search-${n}@example.org`;
  const head = [
    `From: ${from}`,
    `To: Tester <tester@example.org>`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${id}>`,
    `MIME-Version: 1.0`,
  ];
  let lines;
  if (parts) {
    const boundary = `----=_Part_${n}`;
    lines = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, ``];
    for (const part of parts) {
      lines.push(`--${boundary}`, ...part, ``);
    }
    lines.push(`--${boundary}--`, ``);
  } else {
    const encoded = encoding === "base64" ? base64(body) : encoding === "quoted-printable" ? quotedPrintable(body) : body;
    lines = [...head, `Content-Type: ${type}; charset=UTF-8`, `Content-Transfer-Encoding: ${encoding}`, ``, encoded, ``];
  }
  // addMessage takes a byte string.
  folder.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(toBytes(lines.join("\r\n")));
  return folder.msgDatabase.getMsgHdrForMessageID(id);
}

const ALICE = "Alice Example <alice@example.org>";
const BOB = "Bob Sample <bob@example.org>";
const all = [];
const add = (folder, spec) => {
  const hdr = msg(folder, spec);
  all.push(hdr);
  return hdr;
};

add(inbox, { from: ALICE, subject: "Beitragsanpassung ab Januar", body: "Hallo,\r\nder Krankenversicherungsbeitrag steigt ab Januar leicht an.\r\nViele Grüße\r\nAlice" });
add(inbox, { from: BOB, subject: "Rechnung Oktober", encoding: "base64", body: "Guten Tag,\r\nanbei die Rechnungsnummer 4711-0815 für den Krankenversicherungsbeitrag.\r\nBob" });
const unread = add(inbox, { from: "Carol Muster <carol@example.org>", subject: "Grüße aus dem Urlaub", encoding: "quoted-printable", body: "Liebe Grüße vom Strand, das Wetter ist schön = warm." });
add(inbox, { from: "Dave Beispiel <news@example.org>", subject: "Newsletter November", type: "text/html", encoding: "base64", body: "<html><body><h1>Newsletter</h1><p>Neuigkeiten aus dem Verein.</p></body></html>" });
add(inbox, {
  from: ALICE,
  subject: "Protokoll mit Anhang",
  parts: [
    [`Content-Type: text/plain; charset=UTF-8`, `Content-Transfer-Encoding: 7bit`, ``, `Das Protokoll liegt bei.`],
    [`Content-Type: text/plain; name="protokoll.txt"`, `Content-Disposition: attachment; filename="protokoll.txt"`, `Content-Transfer-Encoding: base64`, ``, base64("Punkt 1: Termine\r\nPunkt 2: Budget\r\n")],
  ],
});
const tagged = add(inbox, { from: BOB, subject: "Wichtig: Termin verschoben", body: "Der Termin am Freitag wird auf Montag verschoben." });
const flagged = add(inbox, { from: "Erin Probe <erin@example.org>", subject: "Bitte bis Freitag erledigen", body: "Kannst du die Unterlagen bis Freitag durchsehen?" });
add(inbox, { from: "Frank Test <frank@example.org>", subject: "Mittagessen", body: "Gehen wir heute zusammen essen?" });
add(inbox, { from: "Grace Muster <grace@example.org>", subject: "Bücherliste", body: "Hier die Liste der Bücher für den Lesekreis." });
add(archive, { from: ALICE, subject: "Alte Abrechnung", body: "Die Abrechnung vom letzten Jahr ist erledigt." });
add(archive, { from: BOB, subject: "Archivierte Notiz", body: "Notiz für das Archiv." });
add(archive, { from: "Heidi Beispiel <heidi@example.org>", subject: "Vereinsfeier", body: "Die Vereinsfeier findet im Dezember statt." });
add(secondInbox, { from: ALICE, subject: "Grüße vom zweiten Konto", body: "Diese Mail liegt im zweiten Konto." });
add(secondInbox, { from: "Ivan Probe <ivan@example.org>", subject: "Fotos", body: "Die Fotos vom Ausflug sind hochgeladen." });
add(secondInbox, { from: "Judy Test <judy@example.org>", subject: "Kurze Frage", body: "Hast du kurz Zeit für eine Frage?" });

for (const folder of folders) {
  folder.markMessagesRead(all.filter(hdr => hdr.folder.URI === folder.URI && hdr !== unread), true);
}
inbox.addKeywordsToMessages([tagged], "$label1");
inbox.markMessagesFlagged([flagged], true);
return { folders: folders.map(f => f.URI) };
