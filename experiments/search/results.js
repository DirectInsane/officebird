// Classic script, not a module: the experiment loads it into a sandbox.
// Shows computed search hits in a 3-pane tab's message list through Thunderbird's search
// view (the one of the search dialog) and brings back the folder view afterwards.
"use strict";

var qolSearchResults = (() => {
  // about3Pane window -> { wrapper, saved, hdrs, ids, token, pending, timer }
  const states = new WeakMap();
  // nsMsgViewIndex_None, a const of the 3-pane and so not a property of its window.
  const NO_INDEX = 0xffffffff;
  // Hits given to the view in one go; between two chunks the window gets to run.
  const FEED_CHUNK = 500;
  // A search term that matches the hits shown, and so turns the quick filter and the
  // mail views into filters of the hits instead of searches of their whole folders.
  const HIT_TERM_ID = "officebird#searchHit";
  let lastToken = 0;

  function idOf(hdr) {
    return hdr.folder.URI + "#" + hdr.messageKey;
  }

  // The hit term, registered once: Thunderbird keeps custom terms until it quits, so a
  // term registered by an earlier load of the add-on is taken over. It is available only
  // while one of our views starts its search, so the search and filter dialogs, which
  // list the custom terms available for their folders, never offer it.
  function hitTerm(win) {
    const { Ci } = win;
    const { MailServices } = win.ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const registered = MailServices.filters.getCustomTerm(HIT_TERM_ID);
    const term = registered ? (registered.wrappedJSObject ?? registered) : { id: HIT_TERM_ID, hits: new Map(), starting: 0 };
    const offline = [Ci.nsMsgSearchScope.offlineMail, Ci.nsMsgSearchScope.onlineManual, Ci.nsMsgSearchScope.localNews];
    Object.assign(term, {
      name: "Officebird search hit",
      needsBody: false,
      getEnabled: () => false,
      // Never sent to a server: hits of an IMAP folder are matched on its local copy.
      getAvailable: scope => term.starting > 0 && offline.includes(scope),
      getAvailableOperators(scope, length) {
        if (length) {
          length.value = 1;
        }
        return [Ci.nsMsgSearchOp.Is];
      },
      // Token -> ids of the hits shown under it.
      match(msgHdr, token) {
        return Boolean(term.hits.get(token)?.has(idOf(msgHdr)));
      },
    });
    term.starting ??= 0;
    if (!registered) {
      term.wrappedJSObject = term;
      MailServices.filters.addCustomTerm(term);
    }
    return term;
  }

  function hitSets(win) {
    return hitTerm(win).hits;
  }

  function activeState(win) {
    const state = states.get(win);
    if (state && win.gViewWrapper === state.wrapper && state.wrapper.isSearch) {
      return state;
    }
    // The 3-pane replaced or closed the view itself, for example when a folder was
    // selected or the folder shown before was deleted.
    if (state) {
      forget(win, state);
    }
    return null;
  }

  function forget(win, state) {
    states.delete(win);
    win.clearTimeout(state.timer);
    state.timer = null;
    state.pending = [];
    hitSets(win).delete(state.token);
  }

  function saveFolderView(win) {
    const { gFolder, gViewWrapper, gDBView, threadTree } = win;
    if (!gDBView) {
      return { folder: gFolder ?? null, selected: [], current: null, scrollTop: 0, sort: null, grouped: false };
    }
    const hdrAt = index =>
      index >= 0 && index < gDBView.rowCount && !gViewWrapper.isGroupedByHeaderAtIndex(index) ? gDBView.getMsgHdrAt(index) : null;
    return {
      folder: gFolder,
      selected: threadTree.selectedIndices.map(hdrAt).filter(Boolean),
      current: hdrAt(threadTree.currentIndex),
      scrollTop: threadTree.scrollTop,
      sort: [gViewWrapper.primarySortColumnId, gViewWrapper.primarySortOrder],
      grouped: gViewWrapper.showGroupedBySort,
    };
  }

  function restoreFolderView(win, saved) {
    const { gViewWrapper, gDBView, threadTree } = win;
    if (!gDBView || !saved.folder || win.gFolder?.URI !== saved.folder.URI) {
      return;
    }
    if (saved.grouped !== gViewWrapper.showGroupedBySort) {
      gViewWrapper.showGroupedBySort = saved.grouped;
    }
    if (saved.sort && (saved.sort[0] !== gViewWrapper.primarySortColumnId || saved.sort[1] !== gViewWrapper.primarySortOrder)) {
      gViewWrapper.sort(...saved.sort);
    }
    const indexOf = hdr => {
      // Expands a collapsed thread that holds the message.
      const index = win.gDBView.findIndexOfMsgHdr(hdr, true);
      return index === NO_INDEX ? -1 : index;
    };
    const indices = saved.selected.map(indexOf).filter(index => index >= 0);
    if (indices.length) {
      threadTree.setSelectedIndices(indices);
    }
    const current = saved.current ? indexOf(saved.current) : -1;
    if (current >= 0) {
      threadTree.currentIndex = current;
    }
    threadTree.scrollTop = saved.scrollTop;
  }

  function folderList(hdrs) {
    const folders = new Map();
    for (const hdr of hdrs) {
      folders.set(hdr.folder.URI, hdr.folder);
    }
    return [...folders.values()];
  }

  // Gives `hdrs` to the view and has the list draw them.
  function insert(win, state, dbView, hdrs) {
    const { threadTree, Ci } = win;
    const { wrapper } = state;
    // The search view has no unread-only mode of its own.
    const shown = wrapper.showUnreadOnly ? hdrs.filter(hdr => !hdr.isRead) : hdrs;
    const view = dbView.QueryInterface(Ci.nsIMsgSearchNotify);
    const before = dbView.rowCount;
    // Sorted or grouped, the hits land between the rows shown so far.
    const inPlace = wrapper.primarySortType !== Ci.nsMsgViewSortType.byNone || wrapper.showGroupedBySort;
    const selected = inPlace ? threadTree.selectedIndices.filter(i => !wrapper.isGroupedByHeaderAtIndex(i)).map(i => dbView.getMsgHdrAt(i)) : [];
    for (const hdr of shown) {
      view.onSearchHit(hdr, hdr.folder);
    }
    // The search view tells only a XUL tree about its hits, so the list draws no rows
    // for them by itself.
    const added = dbView.rowCount - before;
    if (!added) {
      return;
    }
    threadTree.rowCountChanged(before, added);
    if (inPlace) {
      threadTree.invalidate();
      const indices = selected.map(hdr => dbView.findIndexOfMsgHdr(hdr, false)).filter(index => index !== NO_INDEX);
      if (indices.length || selected.length) {
        threadTree.setSelectedIndices(indices, true);
      }
    }
  }

  // Feeds the waiting hits chunk by chunk; the list counts as loading until all are in.
  function pump(win, state) {
    state.timer = null;
    const dbView = state.wrapper.dbView;
    if (states.get(win) !== state || !dbView) {
      return;
    }
    insert(win, state, dbView, state.pending.splice(0, FEED_CHUNK));
    if (state.pending.length) {
      state.wrapper.searching = true;
      state.timer = win.setTimeout(() => pump(win, state), 0);
      return;
    }
    dbView.QueryInterface(win.Ci.nsIMsgSearchNotify).onSearchDone(win.Cr.NS_OK);
    // Like the end of a search session: the 3-pane restores selection and scroll.
    state.wrapper.searching = false;
  }

  function enqueue(win, state, hdrs) {
    state.pending = state.pending.concat(hdrs);
    if (!state.timer) {
      pump(win, state);
    }
  }

  // Called for every view the wrapper creates: when the hits change, and when Thunderbird
  // re-creates the view for a sort, grouping or filter change.
  function fill(win, state, dbView) {
    win.clearTimeout(state.timer);
    state.timer = null;
    state.pending = [];
    dbView.QueryInterface(win.Ci.nsIMsgSearchNotify).onNewSearch();
    enqueue(win, state, state.hdrs);
  }

  function sessionHitTerm(win, session, token) {
    const { Ci } = win;
    const term = session.createTerm();
    const value = term.value;
    value.attrib = Ci.nsMsgSearchAttrib.Custom;
    value.str = token;
    term.attrib = Ci.nsMsgSearchAttrib.Custom;
    term.customId = HIT_TERM_ID;
    term.op = Ci.nsMsgSearchOp.Is;
    term.value = value;
    term.booleanAnd = true;
    return term;
  }

  // The wrapper fills its views from the hits. With quick filter or mail view terms,
  // Thunderbird's own search runs over the hits' folders, and the hit term keeps it to
  // the hits.
  function connect(win, state) {
    const spec = state.wrapper.search;
    const { associateView, dissociateView, updateSession } = spec;
    spec.updateSession = function () {
      // The slot of a saved search's terms, which a search view leaves empty: its terms
      // come first and are checked for what a server can search.
      this._virtualFolderTerms = [sessionHitTerm(win, this.session, state.token)];
      try {
        updateSession.call(this);
      } finally {
        this._virtualFolderTerms = null;
      }
    };
    spec.associateView = function (dbView) {
      // Here the search session checks its terms and starts.
      const term = hitTerm(win);
      term.starting++;
      try {
        associateView.call(this, dbView);
      } finally {
        term.starting--;
      }
      if (!this.hasSearchTerms && states.get(win) === state) {
        fill(win, state, dbView);
      }
    };
    spec.dissociateView = function (dbView) {
      win.clearTimeout(state.timer);
      state.timer = null;
      state.pending = [];
      dissociateView.call(this, dbView);
    };
  }

  function setHits(win, state, hdrs) {
    state.hdrs = [...hdrs];
    const ids = new Set(state.hdrs.map(idOf));
    hitSets(win).set(state.token, ids);
  }

  // Shows the saved folder again in a list whose search view is closed.
  function showFolder(win, saved) {
    // A folder deleted (or moved away) while the results showed: the folder pane's choice.
    const { MailUtils } = win.ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
    const gone = Boolean(saved.folder) && !MailUtils.getExistingFolder(saved.folder.URI);
    // displayFolder does nothing for the folder selected in the folder pane, and only the
    // folder pane's select handler opens a view of it again.
    if (!saved.folder || gone || win.folderTree.selectedRow?.uri === saved.folder.URI) {
      win.folderPane._onSelect();
    } else {
      win.displayFolder(saved.folder);
    }
    if (!gone) {
      restoreFolderView(win, saved);
    }
  }

  // Switches the tab's message list to a search view that shows exactly `hdrs`, sorted
  // newest first when `newestFirst` is set or the list switches now, otherwise as the
  // user sorted it. When the switch fails, the folder comes back and the error is thrown on.
  function show(win, hdrs, { newestFirst = false } = {}) {
    let state = activeState(win);
    const saved = state ? state.saved : saveFolderView(win);
    const switching = !state;
    try {
      if (switching) {
        // Leaving the folder the way the folder pane does it (mark-read-on-leave and so on).
        win.gViewWrapper?.close();
        const wrapper = new win.DBViewWrapper(win.dbViewWrapperListener);
        win.gViewWrapper = wrapper;
        state = { wrapper, saved, hdrs: [], token: `${Date.now()}-${++lastToken}`, pending: [], timer: null };
        states.set(win, state);
        wrapper.openSearchView();
        connect(win, state);
      }
      setHits(win, state, hdrs);
      if (newestFirst || switching) {
        // Instead of the search view's own default, the order the hits arrive in. The
        // view created next takes the sort over and keeps it for the hits added later.
        state.wrapper._sort = [[win.Ci.nsMsgViewSortType.byDate, win.Ci.nsMsgViewSortOrder.descending]];
      }
      // Re-creates the view, which fills itself with the hits.
      state.wrapper.searchFolders = folderList(hdrs);
      win.threadPane?.restoreSortIndicator();
    } catch (e) {
      if (state) {
        forget(win, state);
      }
      try {
        win.gViewWrapper?.close();
      } catch (closeError) {
        win.console.warn("officebird search: broken search view not closed", closeError);
      }
      showFolder(win, saved);
      throw e;
    }
  }

  // Adds hits to the active search view.
  function add(win, hdrs) {
    const state = activeState(win);
    if (!state) {
      return;
    }
    setHits(win, state, [...state.hdrs, ...hdrs]);
    const { wrapper } = state;
    const folders = wrapper.searchFolders;
    const fresh = folderList(hdrs).filter(folder => !folders.some(f => f.URI === folder.URI));
    if (wrapper.search.hasSearchTerms) {
      // Re-creates the view: Thunderbird's search of the hits' folders runs again.
      wrapper.searchFolders = [...folders, ...fresh];
      return;
    }
    // The live list: the setter would re-create the view.
    folders.push(...fresh);
    if (wrapper.dbView) {
      enqueue(win, state, hdrs);
    }
  }

  // Closes the search view and shows the folder that was displayed before, as it was.
  function end(win) {
    const state = activeState(win);
    if (!state) {
      return;
    }
    forget(win, state);
    const { saved, wrapper } = state;
    // Clears gDBView, so the folder pane does not save the results' selection as the folder's.
    wrapper.close();
    showFolder(win, saved);
  }

  function isActive(win) {
    return Boolean(activeState(win));
  }

  return { show, add, end, isActive };
})();
