<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/banner-dark.svg">
    <img src="images/banner-light.svg" alt="Officebird: Outlook-style mail list and compose ribbon for Thunderbird" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/DirectInsane/officebird/actions/workflows/tests.yml"><img src="https://github.com/DirectInsane/officebird/actions/workflows/tests.yml/badge.svg" alt="Tests"></a>
  <img src="https://img.shields.io/badge/Thunderbird-153%2B-0a84ff?logo=thunderbird&logoColor=white" alt="Thunderbird 153+">
  <img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT license">
  <img src="https://img.shields.io/badge/languages-English%20%7C%20Deutsch-6e7781" alt="English and German">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#sender-verification">Sender verification</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#permissions">Permissions</a> ·
  <a href="#development">Development</a>
</p>

Officebird brings the parts of Outlook that people miss most to Thunderbird: a message list that shows who wrote and what it's about at a glance, and a formatting ribbon for writing mail. A calmer Today Pane keeps the coming days next to your inbox.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/mail-dark.png">
    <img src="screenshots/mail.png" alt="Officebird in Thunderbird: message cards with sender logos and initials, preview lines and Today, Yesterday and Last 7 Days groups, the reading pane, and the Today Pane with a mini calendar and the coming events" width="100%">
  </picture>
</p>

<p align="center"><sub>All screenshots show made-up data. They follow your light or dark mode.</sub></p>

## Features

### Message list

| | |
|---|---|
| **Sender logos** | Each card shows the logo of the sender's company, but only after your mail provider confirmed the sender is genuine. A forged mail, for example one pretending to come from PayPal, gets plain initials and a red **!** instead. Photos from your address book come first; official brand logos (BIMI) are optional. The reading pane shows the same next to the sender's name. |
| **Preview lines** | One to five lines of each mail's text below the subject, also for mails with large attachments. |
| **Unread at a glance** | A blue bar and blue subject mark unread mail; clicking the bar toggles read and unread. Read mail fades back as far as you like. |
| **Card look** | Your theme's cards, or outlined or filled ones. Hovering a card shows a delete button next to the star. |
| **Date groups** | "Today", "Yesterday" and older groups as slim headers, for one folder or all at once. They open expanded in every folder; a group you collapse stays collapsed. |
| **Table view** | Avatars and a preview line in the classic table, and a date column that shows the time for today, the weekday for this week and the date for older mail. |
| **Remote content notice** | Custom colors and a compact size for the "remote content blocked" bar. |
| **Search** | A query field with a filter panel replaces Thunderbird's search bar (it can be brought back in the settings). Type words or use keywords, in English or German: `from:`/`von:`, `to:`/`an:`, `subject:`/`betreff:`, `in:`, `after:`/`nach:`, `before:`/`vor:`, `tag:`/`schlagwort:`, `has:attachment`, `is:unread`, `is:flagged`; `OR` combines, a minus excludes. Results appear in the message list, for **This folder** or **All mailboxes**. |
| **Thunderbird switches** | Unified folders (Inbox, Drafts, Sent, Spam of all accounts) above the accounts, and whether mail is marked read when shown, right in the add-on's settings. |

### Today Pane

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/today-pane-dark.png">
  <img src="screenshots/today-pane.png" alt="Today Pane with a mini calendar, today in red and the coming events in a card with a day column" width="260" align="right">
</picture>

Thunderbird's calendar column next to the mail (View → Today Pane) gets a calmer look:

- a **mini calendar** with today highlighted in red, your accent color or a color of your own, and quiet week numbers,
- the **coming events** in a card, with the weekday and day in a column and each calendar's color as a bar,
- a **Today** button that jumps back after you looked at another day,
- weekday and month names in Thunderbird's language.

The settings also show or hide the pane, the week numbers and the number of days in the agenda.

<br clear="right">

### Compose window

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/compose-dark.png">
    <img src="screenshots/compose.png" alt="Compose window with the ribbon: Send, Save and Attach, clipboard and format painter, fonts and sizes, and the Include and Check groups" width="100%">
  </picture>
</p>

| | |
|---|---|
| **Ribbon** | Send, Save and Attach always in reach; fonts, sizes, colors, lists, alignment and paragraph styles in two tabs. Hovering an option previews it in your mail. The ribbon collapses to a single row. |
| **Style sets** | Four looks for your own text: Default, Modern, Classic and Compact. Quoted replies, forwards and signatures stay untouched. Pick one as the default for new mail. |
| **Format painter** | Copies formatting from one place to another: click to paint once, double-click to keep painting. Ctrl+Shift+C copies, and on macOS Ctrl+Shift+V pastes. |

Every feature, the ribbon included, can be switched off in the settings.

## Install

Requires Thunderbird 153 or later on Windows, macOS or Linux.

1. Download `officebird-<version>.xpi` from the [latest release](https://github.com/DirectInsane/officebird/releases/latest).
2. In Thunderbird open *Add-ons and Themes → ⚙ → Install Add-on From File…* and choose the file.

To build it yourself instead, run `scripts/build.sh`; the file lands in `dist/officebird.xpi`.

> [!NOTE]
> Thunderbird downloads new versions by itself. Officebird then shows a bar that a new version is ready; it is installed at the next restart, since Thunderbird keeps the add-on's privileged code loaded until then.

> [!TIP]
> The [Clean themes](https://github.com/bakatamas/thunderbird-clean-themes) by [bakatamas](https://github.com/bakatamas) go well with Officebird.

## Sender verification

To trust a sender, Officebird needs to know which server checks your incoming mail. In the settings (*Add-ons and Themes → Officebird → Preferences*), click **Detect from this account's mail** for each account; it finds the name in your recent mail, for Gmail that's `mx.google.com`. You can also enter it by hand. Until then, cards show initials.

> [!IMPORTANT]
> Leave an account empty if its server doesn't add an `Authentication-Results` header. Otherwise a sender could forge one.

## Privacy

| What | Who sees it |
|---|---|
| Sender logos | DuckDuckGo learns which domains mail you, not who you are. Each domain is looked up at most once a month, without cookies or referrer. |
| Brand logos (BIMI, off by default) | Your DNS-over-HTTPS resolver (Cloudflare or Quad9) sees the domain; the brand's logo server sees your IP address. |
| Update check | GitHub sees your IP address when Thunderbird looks for a new version, once a day. |
| Previews and verification | Nobody. Both come from mail already on your computer, and Officebird never runs anything contained in a mail. |

## Permissions

| Permission | Why |
|---|---|
| Read your email messages | Previews, and the `Authentication-Results` header for sender verification |
| Address books | Contact photos as avatars (read only) |
| Storage | Settings and cached logos |
| `icons.duckduckgo.com` | Sender logos |
| All websites (optional, asked when you turn on BIMI) | Brand logos from the sender's own server |

Officebird also uses two experiment APIs, because Thunderbird's regular add-on APIs can't change the message list or the compose window. Experiments run with full access to Thunderbird, which is why Thunderbird shows a warning on install. Officebird uses that access only for the message list, the reading pane and the compose window, and sends nothing beyond what's listed under [Privacy](#privacy). The code is in [`experiments/`](experiments/).

## Limitations

- Previews and verification work for mail stored on your computer: local folders, and IMAP folders kept for offline use (Thunderbird's default).
- Search finds whole words and word beginnings in the mail text through Thunderbird's full-text index. Other parts of words are found by reading the stored mails, which takes longer in large mailboxes. Mail kept only on the server is searched by the server, so those results depend on what the server supports.
- Plain-text mail has no formatting, so the ribbon's formatting tools have nothing to do there.
- Officebird hooks into Thunderbird's internal code. If a future version changes it, the affected feature turns itself off; *Status* in the settings shows which.

## Development

```bash
npm test                          # unit tests (Node 20+)
scripts/dev/start-thunderbird.sh  # separate Thunderbird on .dev-profile/, Marionette on port 2829
node scripts/dev/marionette.mjs --install "$PWD"                 # load the add-on temporarily
node scripts/dev/marionette.mjs scripts/dev/seed-test-folder.js  # sample mails in a test folder
scripts/dev/test-compose.sh       # compose ribbon integration tests in their own profile
scripts/dev/screenshots.sh        # the README screenshots, light and dark, with made-up data in their own profile
```

Copy `scripts/dev/user.js` to `.dev-profile/user.js` before the first start. The dev scripts currently expect macOS with Thunderbird in `/Applications`.

## License

[MIT](LICENSE) © DirectInsane
