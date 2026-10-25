// Classic script, not a module: the experiment loads it into a sandbox.
// Shows computed search hits in a 3-pane tab's message list through Thunderbird's search
// view (the one of the search dialog) and brings back the folder view afterwards.
"use strict";

var qolSearchResults = (() => {
  // about3Pane window -> { wrapper, saved }
  const states = new WeakMap();
  // nsMsgViewIndex_None, a const of the 3-pane and so not a property of its window.
  const NO_INDEX = 0xffffffff;

  function activeState(win) {
    const state = states.get(win);
    if (state && win.gViewWrapper === state.wrapper && state.wrapper.isSearch) {
      return state;
    }
    // The 3-pane replaced the view itself, for example when a folder was selected.
    states.delete(win);
    return null;
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

  function feed(win, hdrs) {
    const view = win.gDBView.QueryInterface(win.Ci.nsIMsgSearchNotify);
    for (const hdr of hdrs) {
      view.onSearchHit(hdr, hdr.folder);
    }
    view.onSearchDone(win.Cr.NS_OK);
  }

  // Switches the tab's message list to a search view that shows exactly `hdrs`.
  function show(win, hdrs) {
    let state = activeState(win);
    if (!state) {
      const saved = saveFolderView(win);
      // Leaving the folder the way the folder pane does it (mark-read-on-leave and so on).
      win.gViewWrapper?.close();
      const wrapper = new win.DBViewWrapper(win.dbViewWrapperListener);
      win.gViewWrapper = wrapper;
      wrapper.openSearchView();
      state = { wrapper, saved };
      states.set(win, state);
    }
    // Setting the folders re-creates the (empty) view.
    state.wrapper.searchFolders = folderList(hdrs);
    win.gDBView.QueryInterface(win.Ci.nsIMsgSearchNotify).onNewSearch();
    feed(win, hdrs);
  }

  // Adds hits to the active search view.
  function add(win, hdrs) {
    const state = activeState(win);
    if (!state) {
      return;
    }
    // The live list: the setter would re-create the view and drop the hits shown so far.
    const folders = state.wrapper.searchFolders;
    for (const folder of folderList(hdrs)) {
      if (!folders.some(f => f.URI === folder.URI)) {
        folders.push(folder);
      }
    }
    feed(win, hdrs);
  }

  // Closes the search view and shows the folder that was displayed before, as it was.
  function end(win) {
    const state = activeState(win);
    if (!state) {
      return;
    }
    states.delete(win);
    const { saved, wrapper } = state;
    // Clears gDBView, so the folder pane does not save the results' selection as the folder's.
    wrapper.close();
    if (!saved.folder || win.folderTree.selectedRow?.uri === saved.folder.URI) {
      win.folderPane._onSelect();
    } else {
      win.displayFolder(saved.folder);
    }
    restoreFolderView(win, saved);
  }

  function isActive(win) {
    return Boolean(activeState(win));
  }

  return { show, add, end, isActive };
})();
