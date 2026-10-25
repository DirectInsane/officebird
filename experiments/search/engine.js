// Classic script, not a module: the experiment loads it into a sandbox after query.js,
// sets.js and terms.js, the tests the same way.
// Runs a parsed query in Thunderbird: header leaves through nsIMsgSearchSession, body
// leaves through Gloda and then a search-session body scan, combined with qolSearchSets.
"use strict";

var qolSearchEngine = (() => {
  const GLODA_PREF = "mailnews.database.global.indexer.enabled";
  const PROGRESS_INTERVAL = 250;
  const UNIVERSE_CHUNK = 2000;
  // A server search or Gloda query that never reports back must not hold up the rest.
  const ONLINE_TIMEOUT = 60000;
  const GLODA_TIMEOUT = 30000;

  function idOf(hdr) {
    return hdr.folder.URI + "#" + hdr.messageKey;
  }

  function folderOfId(id) {
    return id.slice(0, id.lastIndexOf("#"));
  }

  function restrict(ids, uris) {
    return new Set([...ids].filter((id) => uris.has(folderOfId(id))));
  }

  function folderKind(folder, Ci) {
    const flags = folder.flags;
    const F = Ci.nsMsgFolderFlags;
    if (flags & F.Virtual) return "virtual";
    const type = folder.server.type;
    if (type === "nntp") return "news";
    if (type === "rss") return "feed";
    if (flags & F.Trash) return "trash";
    if (flags & F.Junk) return "junk";
    if (flags & F.Inbox) return "inbox";
    return "mail";
  }

  // FolderInfo for terms.js, plus the nsIMsgFolder for every URI.
  function allFolders(MailServices, Ci) {
    const infos = [];
    const byUri = new Map();
    for (const folder of MailServices.accounts.allFolders) {
      if (folder.isServer) continue;
      const parent = folder.parent;
      infos.push({
        uri: folder.URI,
        parent: parent && !parent.isServer ? parent.URI : null,
        kind: folderKind(folder, Ci),
        name: folder.localizedName,
        account: folder.server.prettyName,
      });
      byUri.set(folder.URI, folder);
    }
    return { infos, byUri };
  }

  // "YYYY-MM-DD" -> PRTime, `shift` days later. Thunderbird compares calendar days in
  // local time (IsBefore: earlier days, IsAfter: later days), so any time of the day will
  // do; noon stays on the day across daylight-saving shifts.
  function datePRTime(text, shift = 0) {
    const [y, m, d] = text.split("-").map(Number);
    return new Date(y, m - 1, d + shift, 12).getTime() * 1000;
  }

  // Full-text query words: the index splits text at everything but letters and digits,
  // and those other characters are query operators to SQLite's MATCH.
  function glodaWords(words) {
    return words
      .flatMap((word) => word.replace(/\*$/, "").split(/[^\p{L}\p{N}]+/u))
      .filter(Boolean)
      .map((word) => word.toLowerCase() + "*");
  }

  // Tag name (or key) -> tag keys; names compare case-insensitively.
  function tagKeys(MailServices, name) {
    const wanted = String(name).toLowerCase();
    const tags = MailServices.tags.getAllTags();
    const byName = tags.filter((tag) => tag.tag.toLowerCase() === wanted);
    const matches = byName.length ? byName : tags.filter((tag) => tag.key.toLowerCase() === wanted);
    return matches.map((tag) => tag.key);
  }

  function run(win, query, opts, onProgress) {
    // The sandbox has no chrome globals of its own; the 3-pane window lends them.
    const { ChromeUtils, Components, Ci, Cc, Services } = win;
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const msgWindow = win.msgWindow ?? win.top?.msgWindow ?? null;
    const terms = qolSearchTerms;
    const sets = qolSearchSets;

    let cancelled = false;
    const sessions = new Set();
    const waits = new Set();
    let progressTimer = null;
    let lastProgress = 0;

    const leafSets = new Map();
    const pending = new Set();
    const hdrs = new Map();
    const notices = [];
    const universe = new Set();
    let allScope = new Set();
    let folderScope = new Set();
    let searching = true;

    function hdr(id) {
      if (hdrs.has(id)) return hdrs.get(id);
      try {
        const folder = MailUtils.getExistingFolder(folderOfId(id));
        return folder?.msgDatabase.getMsgHdrForKey(Number(id.slice(id.lastIndexOf("#") + 1))) ?? null;
      } catch (e) {
        return null;
      }
    }

    function addHit(key, msgHdr) {
      const id = idOf(msgHdr);
      leafSets.get(key).add(id);
      hdrs.set(id, msgHdr);
    }

    // A negated leaf counts as matching everything until its set is complete, so a
    // result only ever grows while the search runs.
    function combined() {
      const shown = new Map(leafSets);
      const view = {
        or: query.or.map((conjunction) =>
          conjunction.map((leaf) => {
            const key = sets.leafKey(leaf);
            if (!leaf.negated || !pending.has(key)) return leaf;
            shown.set(sets.leafKey({ field: "pending", value: key }), universe);
            return { ...leaf, field: "pending", value: key };
          })
        ),
      };
      return sets.evaluate(view, shown, universe);
    }

    function report() {
      if (cancelled) return;
      clearTimeout(progressTimer);
      progressTimer = null;
      lastProgress = Date.now();
      const ids = combined();
      onProgress({
        folderIds: restrict(ids, folderScope),
        allIds: restrict(ids, allScope),
        searching,
        notices: notices.map((notice) => ({ ...notice })),
        hdr,
      });
    }

    // During the body scan: at most one report per PROGRESS_INTERVAL.
    function reportSoon() {
      if (cancelled || progressTimer) return;
      const wait = Math.max(0, lastProgress + PROGRESS_INTERVAL - Date.now());
      progressTimer = setTimeout(report, wait);
    }

    // Resolves when the wait finishes or the run is cancelled.
    function cancellable(start) {
      return new Promise((resolve) => {
        const finish = (value) => {
          waits.delete(finish);
          resolve(value);
        };
        waits.add(finish);
        start(finish);
      });
    }

    function sessionTermFor(session, leaf) {
      const term = terms.sessionTerm(leaf);
      if (!term) return [];
      const attrib = Ci.nsMsgSearchAttrib[term.attrib];
      const op = Ci.nsMsgSearchOp[term.op];
      let values;
      // after: includes the given day, IsAfter starts the day after.
      if (term.attrib === "Date") values = [{ date: datePRTime(term.value, term.op === "IsAfter" ? -1 : 0) }];
      else if (term.attrib === "MsgStatus") values = [{ status: Ci.nsMsgMessageFlags[term.value] }];
      else if (term.attrib === "Keywords") values = tagKeys(MailServices, term.value).map((key) => ({ str: key }));
      else values = [{ str: term.value }];
      return values.map((fields) => {
        const searchTerm = session.createTerm();
        const value = searchTerm.value;
        value.attrib = attrib;
        Object.assign(value, fields);
        searchTerm.attrib = attrib;
        searchTerm.op = op;
        searchTerm.value = value;
        // Several tag keys of the same name: any of them.
        searchTerm.booleanAnd = false;
        return searchTerm;
      });
    }

    // One session per folder: a session stops at the first scope that fails to
    // initialise (Search() throws, no OnSearchDone), so one broken folder would end the
    // search of all others. Returns false when the folder could not be searched.
    function runSession(leaf, folder, scope, onHit) {
      let session;
      try {
        session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(Ci.nsIMsgSearchSession);
        const searchTerms = sessionTermFor(session, leaf);
        if (!searchTerms.length) return Promise.resolve(true);
        session.addScopeTerm(scope, folder);
        for (const searchTerm of searchTerms) session.appendTerm(searchTerm);
      } catch (e) {
        win.console.warn("officebird search: cannot search folder", folder.URI, e);
        return Promise.resolve(false);
      }
      return cancellable((finish) => {
        let timer = null;
        const end = (ok) => {
          clearTimeout(timer);
          sessions.delete(session);
          finish(ok);
        };
        session.registerListener({
          onNewSearch() {},
          onSearchHit(msgHdr) {
            if (!cancelled) onHit(msgHdr);
          },
          onSearchDone(status) {
            end(Components.isSuccessCode(status));
          },
        });
        sessions.add(session);
        if (scope === Ci.nsMsgSearchScope.onlineMail) {
          timer = setTimeout(() => {
            try {
              session.interruptSearch();
            } catch (e) {}
            end(false);
          }, ONLINE_TIMEOUT);
        }
        try {
          session.search(msgWindow);
        } catch (e) {
          win.console.warn("officebird search: cannot search folder", folder.URI, e);
          end(false);
        }
      });
    }

    async function headerLeaf(leaf, folders) {
      const key = sets.leafKey(leaf);
      for (const folder of folders) {
        const searched = await runSession(leaf, folder, Ci.nsMsgSearchScope.offlineMail, (msgHdr) => addHit(key, msgHdr));
        if (cancelled) return;
        if (!searched) win.console.warn("officebird search: folder left out of the search", folder.URI);
      }
    }

    function loadGloda() {
      return {
        ...ChromeUtils.importESModule("resource:///modules/gloda/GlodaPublic.sys.mjs"),
        ...ChromeUtils.importESModule("resource:///modules/gloda/GlodaConstants.sys.mjs"),
        ...ChromeUtils.importESModule("resource:///modules/gloda/GlodaIndexer.sys.mjs"),
        ...ChromeUtils.importESModule("resource:///modules/gloda/IndexMsg.sys.mjs"),
      };
    }

    // Share of the scope's indexable mail in folders Gloda has finished.
    function indexedPercent(gloda, folders) {
      let total = 0;
      let clean = 0;
      for (const folder of folders) {
        if (!gloda.GlodaMsgIndexer.shouldIndexFolder(folder)) continue;
        const count = folder.getTotalMessages(false);
        total += count;
        const glodaFolder = gloda.Gloda.getFolderForFolder(folder);
        if (glodaFolder && glodaFolder.dirtyStatus === glodaFolder.kFolderClean) clean += count;
      }
      return total ? Math.floor((clean * 100) / total) : 100;
    }

    // Gloda's hits for a body leaf; any failure leaves the leaf to the scan.
    function glodaLeaf(gloda, leaf, scopeUris) {
      const key = sets.leafKey(leaf);
      const words = glodaWords(terms.glodaTerms(leaf));
      if (!words.length) return Promise.resolve();
      return cancellable((finish) => {
        const timer = setTimeout(finish, GLODA_TIMEOUT);
        const end = () => {
          clearTimeout(timer);
          finish();
        };
        try {
          const glodaQuery = gloda.Gloda.newQuery(gloda.GlodaConstants.NOUN_MESSAGE);
          glodaQuery.fulltextMatches(words.join(" "));
          glodaQuery.getCollection(
            {
              onItemsAdded() {},
              onItemsModified() {},
              onItemsRemoved() {},
              onQueryCompleted(collection) {
                try {
                  if (!cancelled) {
                    for (const item of collection.items) {
                      const msgHdr = item.folderMessage;
                      if (msgHdr && scopeUris.has(msgHdr.folder.URI)) addHit(key, msgHdr);
                    }
                  }
                } catch (e) {
                  win.console.warn("officebird search: full-text results not read", e);
                }
                end();
              },
            },
            null
          );
        } catch (e) {
          win.console.warn("officebird search: full-text query failed", e);
          end();
        }
      });
    }

    // IMAP folders without an offline copy are searched on the server; when that fails
    // they are searched locally and counted for the "offline" notice.
    async function scanLeaf(leaf, folders) {
      const key = sets.leafKey(leaf);
      const onHit = (msgHdr) => {
        addHit(key, msgHdr);
        reportSoon();
      };
      const online = folders.filter((folder) => folder.server.type === "imap" && !(folder.flags & Ci.nsMsgFolderFlags.Offline));
      const local = folders.filter((folder) => !online.includes(folder));
      const failed = [];
      for (const folder of local) {
        await runSession(leaf, folder, Ci.nsMsgSearchScope.offlineMail, onHit);
        if (cancelled) return failed;
      }
      for (const folder of online) {
        const reached = !Services.io.offline && (await runSession(leaf, folder, Ci.nsMsgSearchScope.onlineMail, onHit));
        if (cancelled) return failed;
        if (!reached) {
          failed.push(folder.URI);
          await runSession(leaf, folder, Ci.nsMsgSearchScope.offlineMail, onHit);
          if (cancelled) return failed;
        }
      }
      return failed;
    }

    async function enumerateUniverse(folders) {
      let count = 0;
      for (const folder of folders) {
        let db;
        try {
          db = folder.msgDatabase;
        } catch (e) {
          continue;
        }
        for (const msgHdr of db.enumerateMessages()) {
          universe.add(idOf(msgHdr));
          if (++count % UNIVERSE_CHUNK === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (cancelled) return;
          }
        }
      }
    }

    // Each leaf once, keyed like qolSearchSets; "in:" and invalid dates take no part.
    function distinctLeaves(field) {
      const leaves = new Map();
      for (const conjunction of query.or) {
        for (const leaf of conjunction) {
          if (leaf.error || leaf.field === "in" || (field === "body") !== (leaf.field === "body")) continue;
          const key = sets.leafKey(leaf);
          if (!leaves.has(key)) leaves.set(key, leaf);
        }
      }
      return [...leaves.values()];
    }

    async function main() {
      const { infos, byUri } = allFolders(MailServices, Ci);
      const chosen = [];
      const excluded = [];
      for (const leaf of query.or.flat().filter((leaf) => leaf.field === "in" && !leaf.error)) {
        const uris = terms.matchFolders(infos, leaf.value);
        if (!uris.length) {
          searching = false;
          notices.push({ kind: "unknownFolder", name: leaf.value });
          report();
          return;
        }
        (leaf.negated ? excluded : chosen).push(...uris);
      }

      const current = opts.current?.URI ?? "";
      allScope = new Set(terms.scopeFolders(infos, { scope: "all", current, chosen, excluded }));
      folderScope = new Set(terms.scopeFolders(infos, { scope: "folder", current, chosen, excluded }));
      // A unified folder or saved search stands for the folders it searches.
      if (!chosen.length && opts.current && opts.current.flags & Ci.nsMsgFolderFlags.Virtual) {
        const { VirtualFolderHelper } = ChromeUtils.importESModule("resource:///modules/VirtualFolderWrapper.sys.mjs");
        folderScope = new Set(
          VirtualFolderHelper.wrapVirtualFolder(opts.current).searchFolders.flatMap((folder) =>
            terms.scopeFolders(infos, { scope: "folder", current: folder.URI, chosen, excluded })
          )
        );
      }
      // Both scopes in one pass: the default scope's folders first, each folder once.
      const [first, second] = opts.scopeDefault === "all" ? [allScope, folderScope] : [folderScope, allScope];
      const scopeUris = new Set([...first, ...second]);
      const folders = [...scopeUris]
        .map((uri) => byUri.get(uri))
        .filter((folder) => folder && !(folder.flags & Ci.nsMsgFolderFlags.Virtual));

      const headerLeaves = distinctLeaves("header");
      const bodyLeaves = distinctLeaves("body");
      for (const leaf of [...headerLeaves, ...bodyLeaves]) {
        leafSets.set(sets.leafKey(leaf), new Set());
        pending.add(sets.leafKey(leaf));
      }

      const combinable = (leaf) => !leaf.error && leaf.field !== "in";
      const needsUniverse = query.or.some(
        (conjunction) => conjunction.some((leaf) => combinable(leaf) && leaf.negated) || !conjunction.some(combinable)
      );
      if (needsUniverse) await enumerateUniverse(folders);
      if (cancelled) return;

      // The last leaf's report is the final one below.
      let remaining = headerLeaves.length + bodyLeaves.length;
      const leafDone = (leaf) => {
        pending.delete(sets.leafKey(leaf));
        if (--remaining > 0) report();
      };

      for (const leaf of headerLeaves) {
        await headerLeaf(leaf, folders);
        if (cancelled) return;
        leafDone(leaf);
      }

      if (bodyLeaves.length) {
        let gloda = null;
        if (Services.prefs.getBoolPref(GLODA_PREF, false)) {
          try {
            gloda = loadGloda();
          } catch (e) {
            win.console.error("officebird search: full-text index not available", e);
          }
        } else {
          notices.push({ kind: "glodaOff" });
        }
        if (gloda?.GlodaIndexer.indexing) {
          notices.push({ kind: "glodaIndexing", percent: indexedPercent(gloda, folders) });
        }
        if (gloda) {
          for (const leaf of bodyLeaves) {
            await glodaLeaf(gloda, leaf, scopeUris);
            if (cancelled) return;
            report();
          }
        }
        const unreachable = new Set();
        for (const leaf of bodyLeaves) {
          for (const uri of await scanLeaf(leaf, folders)) unreachable.add(uri);
          if (cancelled) return;
          if (unreachable.size) {
            const offline = notices.find((notice) => notice.kind === "offline");
            if (offline) offline.count = unreachable.size;
            else notices.push({ kind: "offline", count: unreachable.size });
          }
          leafDone(leaf);
        }
      }

      searching = false;
      report();
    }

    const done = main().finally(() => {
      clearTimeout(progressTimer);
      progressTimer = null;
    });

    function cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(progressTimer);
      progressTimer = null;
      for (const session of sessions) {
        try {
          session.interruptSearch();
        } catch (e) {}
      }
      sessions.clear();
      for (const finish of [...waits]) finish(false);
    }

    return { cancel, done };
  }

  return { run };
})();
