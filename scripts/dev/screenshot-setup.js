// Fills the screenshot profile with made-up demo data (run via marionette.mjs): an account
// "Demo" with an inbox of mails from today back to last week, grouped by date, two
// calendars with events around today, and the Today Pane shown. Dates follow the clock.
// Every mail carries a passed check from the demo provider, which the account trusts:
// senders of real organisations get their icon, the made-up ones keep their initials.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
const { CalEvent } = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");

const EMAIL = "alex@example.org";
const AUTHSERV = "mx.demo.example";
const win = Services.wm.getMostRecentWindow("mail:3pane");
const wait = ms => new Promise(resolve => win.setTimeout(resolve, ms));
win.moveTo(0, 0);
win.resizeTo(1440, 900);
// Marionette screenshots leave macOS's native window background out (white in dark mode);
// the window's own background color stands in for it.
const SCREENSHOT_CSS = "data:text/css,:root { appearance: none !important; }";
win.windowUtils.loadSheetUsingURIString(SCREENSHOT_CSS, win.windowUtils.AUTHOR_SHEET);

let account = MailServices.accounts.accounts.find(a => a.defaultIdentity?.email === EMAIL);
if (!account) {
  try {
    MailServices.accounts.localFoldersServer;
  } catch (e) {
    MailServices.accounts.createLocalMailAccount();
  }
  const server = MailServices.accounts.createIncomingServer("alex", "demo.example", "none");
  server.prettyName = "Demo";
  const identity = MailServices.accounts.createIdentity();
  identity.email = EMAIL;
  identity.fullName = "Alex Taylor";
  identity.composeHtml = true;
  account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  account.addIdentity(identity);
  MailServices.accounts.saveAccountInfo?.();
}
const root = account.incomingServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
const inbox = root.getChildNamed("Inbox") ?? root.createLocalSubfolder("Inbox");
inbox.setFlag(Ci.nsMsgFolderFlags.Inbox);

function toBytes(text) {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

// Today's mails between midnight and now, older ones at fixed hours on earlier days.
function when(daysAgo, hour, minute) {
  const date = new Date();
  if (daysAgo === 0) {
    const midnight = new Date(date).setHours(0, 0, 0, 0);
    const share = (hour * 60 + minute) / (24 * 60);
    return new Date(midnight + (date - midnight) * share);
  }
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date;
}

let n = 0;
function mail({ from, subject, body, date, read = true, flagged = false, attachment = null }) {
  n++;
  const id = `demo-${n}@demo.example`;
  const domain = /@([^>]+)>/.exec(from)[1];
  const head = [
    `Authentication-Results: ${AUTHSERV}; dkim=pass header.d=${domain}; spf=pass; dmarc=pass header.from=${domain}`,
    `From: ${from}`,
    `To: Alex Taylor <${EMAIL}>`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}>`,
    `MIME-Version: 1.0`,
  ];
  let lines;
  if (attachment) {
    const boundary = `----=_Demo_${n}`;
    lines = [
      ...head,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      body,
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf; name="${attachment}"`,
      `Content-Disposition: attachment; filename="${attachment}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      btoa("%PDF-1.4 demo"),
      `--${boundary}--`,
      ``,
    ];
  } else {
    lines = [...head, `Content-Type: text/plain; charset=UTF-8`, ``, body, ``];
  }
  inbox.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(toBytes(lines.join("\r\n")));
  const hdr = inbox.msgDatabase.getMsgHdrForMessageID(id);
  inbox.markMessagesRead([hdr], read);
  if (flagged) {
    inbox.markMessagesFlagged([hdr], true);
  }
}

if (!inbox.getTotalMessages(false)) {
  const sign = name => `\r\n\r\nBest,\r\n${name}`;
  mail({ from: "Mia Johnson <mia.johnson@example.org>", subject: "Dinner on Friday?", date: when(0, 21, 48), read: false, flagged: true,
    body: "Hi! Are you free for dinner on Friday? I found a lovely little Italian place on Market Street and would love to try it with you." + sign("Mia") });
  mail({ from: "Studio North <hello@studionorth.example>", subject: "New icons for the app", date: when(0, 21, 12), read: false, attachment: "icons.pdf",
    body: "Here are the new icons for the app. We kept them simple and friendly, with rounded corners and two weights. Let us know what you think!" + sign("The Studio North team") });
  mail({ from: "Ben Carter <ben.carter@example.org>", subject: "Photos from the trip", date: when(0, 20, 25),
    body: "The photos from our trip are online now. The sunset at the lake turned out even better than I hoped." + sign("Ben") });
  mail({ from: "GitHub <noreply@github.com>", subject: "Your weekly digest", date: when(0, 19, 0),
    body: "Here is what happened in the repositories you watch this week: 4 pull requests merged, 2 new releases and 7 open discussions." });
  mail({ from: "Olivia Brown <olivia.brown@example.org>", subject: "Book club: next meeting", date: when(0, 17, 0),
    body: "The next book club meets on the 16th. We are reading a short novel this time, so there is plenty of time to finish it." + sign("Olivia") });
  mail({ from: "Thunderbird <news@thunderbird.net>", subject: "What's new in Thunderbird", date: when(0, 13, 20), read: false,
    body: "A short look at the latest release: a faster message list, calmer notifications and a few small settings that make a big difference." });
  mail({ from: "Lucas Meyer <lucas.meyer@example.org>", subject: "Re: Garden project", date: when(0, 7, 0), read: false,
    body: "Sounds great. I can bring the tools on Saturday morning, and my neighbour offered a few plants for the corner bed." + sign("Lucas") });
  mail({ from: "Wikimedia <newsletter@wikimedia.org>", subject: "This month on Wikipedia", date: when(1, 21, 0),
    body: "The most read articles of the month, new featured pictures, and how volunteers improved more than 40,000 articles." });
  mail({ from: "City Library <info@citylibrary.example>", subject: "Your books are ready", date: when(1, 9, 30),
    body: "The books you reserved are ready for pickup at the front desk. We will keep them for you until next Saturday." });
  mail({ from: "SkyWay Air <booking@skyway.example>", subject: "Your flight to Berlin", date: when(2, 19, 0), flagged: true, attachment: "boarding-pass.pdf",
    body: "Your booking is confirmed: Thursday, 07:10, seat 14A. Online check-in opens 24 hours before departure." });
  mail({ from: "Emma Davis <emma.davis@example.org>", subject: "Quick question about the offer", date: when(1, 11, 0), flagged: true,
    body: "Could you send me the updated offer by Wednesday? Then I can go through it with the team before our call." + sign("Emma") });
  mail({ from: "Green Market <hello@greenmarket.example>", subject: "Fresh this week: apples and pumpkins", date: when(3, 21, 40),
    body: "Autumn is here: fresh apples, pumpkins and warm bread at the market this weekend. See you there!" });
  mail({ from: "Noah Wilson <noah.wilson@example.org>", subject: "Running on Sunday", date: when(3, 10, 0),
    body: "Same time as last week? Meet at the park entrance at eight, and we can do the longer loop if the weather holds." + sign("Noah") });
  mail({ from: "Summit Outdoor <orders@summitoutdoor.example>", subject: "Your order is on its way", date: when(4, 20, 40),
    body: "Good news: your new hiking boots left our warehouse today and should arrive within two days." });
  mail({ from: "Sophia Martin <sophia.martin@example.org>", subject: "Slides for Tuesday", date: when(4, 7, 20),
    body: "I added the numbers from last month to the slides. Could you take a quick look before Tuesday?" + sign("Sophia") });
  mail({ from: "Daniel Kim <daniel.kim@example.org>", subject: "Welcome to the team!", date: when(12, 9, 15),
    body: "Welcome aboard! Here is a short overview of the first week and the people you will meet." + sign("Daniel") });
}

// Grouped by date, newest first, before the folder is shown.
const F = Ci.nsMsgViewFlagsType;
const info = inbox.msgDatabase.dBFolderInfo;
info.viewFlags = F.kThreadedDisplay | F.kGroupBySort | F.kExpandAll;
info.sortType = Ci.nsMsgViewSortType.byDate;
info.sortOrder = Ci.nsMsgViewSortOrder.descending;

const calendars = { Personal: "#30b158", Work: "#f0a020" };
for (const old of cal.manager.getCalendars()) {
  if (!Object.hasOwn(calendars, old.name)) {
    old.setProperty("disabled", true);
  }
}
for (const [name, color] of Object.entries(calendars)) {
  if (cal.manager.getCalendars().some(c => c.name === name)) {
    continue;
  }
  const calendar = cal.manager.createCalendar("storage", Services.io.newURI("moz-storage-calendar://"));
  calendar.name = name;
  calendar.setProperty("color", color);
  cal.manager.registerCalendar(calendar);
  const day = (offset, hour, minute) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    date.setHours(hour, minute, 0, 0);
    return cal.dtz.jsDateToDateTime(date, cal.dtz.defaultTimezone);
  };
  const events = {
    Personal: [["🎃 Halloween party", 0, 21, 30], ["Brunch with Ben", 1, 10, 30], ["🧘 Yoga", 3, 7, 0], ["🎾 Tennis", 5, 18, 0], ["📚 Book club", 9, 19, 30]],
    Work: [["Design review", 0, 14, 0], ["👥 Team meeting", 2, 9, 30], ["Call with Studio North", 4, 15, 0], ["👥 Team meeting", 9, 9, 30]],
  }[name];
  for (const [title, offset, hour, minute] of events) {
    const event = new CalEvent();
    event.title = title;
    event.startDate = day(offset, hour, minute);
    const end = event.startDate.clone();
    end.hour += 1;
    event.endDate = end;
    await calendar.addItem(event);
  }
}

const panel = win.document.getElementById("today-pane-panel");
if (!win.TodayPane.isVisible) {
  panel.setVisible(true, true, true);
  win.TodayPane.updateDisplay();
}
win.TodayPane.setDay(cal.dtz.now());

// Trust the demo provider for the demo account, as the options page would store it.
const host = WebExtensionPolicy.getByID("officebird@directinsane.github.io").mozExtensionHostname;
const options = win.gTabmail.openTab("contentTab", { url: `moz-extension://${host}/options/options.html#icons` });
let field = null;
for (let i = 0; i < 100 && !field; i++) {
  await wait(100);
  field = options.browser.contentDocument?.querySelector(`.account[data-server-key="${account.incomingServer.key}"] input`);
}
field.value = AUTHSERV;
field.dispatchEvent(new options.browser.contentWindow.Event("input", { bubbles: true }));
await wait(1500);
win.gTabmail.closeTab(options);

const about3Pane = win.gTabmail.currentAbout3Pane;
about3Pane.displayFolder(inbox.URI);
await wait(1500);
// A read mail in the reading pane, so nothing changes from unread to read.
const shown = [...inbox.messages].find(hdr => hdr.subject === "Photos from the trip");
about3Pane.threadTree.selectedIndex = about3Pane.gDBView.findIndexOfMsgHdr(shown, true);
// Icons arrive from the network.
await wait(5000);
return { account: account.key, mails: inbox.getTotalMessages(false), calendars: cal.manager.getCalendars().map(c => c.name) };
