// Runs inside a reader tab. Stops the hover popup on citations and replaces the jump to
// the reference list with a card describing the cited paper.
(() => {
  const reader = window._reader;
  const host = window.__citecardHost;
  if (!reader || !host || window.__citecard) {
    return;
  }
  // The plugin hooks into internals of Zotero's reader. If a Zotero update has changed
  // them, leave this tab to Zotero's own behavior instead of risking breaking the reader.
  const readerPrototype = Object.getPrototypeOf(reader);
  const VIEW_METHODS = ['_getSelectableOverlay', 'pointerEventToPosition', 'getClientRect', 'navigate'];
  if (typeof readerPrototype._updateState !== 'function' || !Array.isArray(reader._views)) {
    host.log('this Zotero version\'s reader is not supported; citation cards are off');
    return;
  }

  const POPUP_KEYS = ['primaryViewOverlayPopup', 'secondaryViewOverlayPopup'];
  // Errors go to Zotero's debug output, which users can submit with bug reports
  const report = error => host.log('reader error: ' + error + (error?.stack ? '\n' + error.stack : ''));

  const style = document.createElement('style');
  style.textContent = `
    .citecard {
      position: fixed;
      z-index: 1000;
      box-sizing: border-box;
      overflow-y: auto;
      padding: 14px 16px 12px;
      border-radius: 8px;
      background: #fff;
      color: #202124;
      box-shadow: 0 1px 3px rgba(60, 64, 67, 0.3), 0 4px 8px 3px rgba(60, 64, 67, 0.15);
      font: 13px/1.46 Arial, sans-serif;
      text-align: left;
    }
    .citecard-nav {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      height: 24px;
      margin: -8px -8px 2px 0;
      color: #70757a;
      font-size: 12px;
      line-height: 24px;
    }
    .citecard-counter {
      padding: 0 4px;
      font-variant-numeric: tabular-nums;
    }
    .citecard-number {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 24px;
      padding: 0 4px;
      border: 0;
      border-radius: 12px;
      background: none;
      color: inherit;
      font: inherit;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
    }
    .citecard-number.current {
      color: #1a0dab;
      font-weight: bold;
    }
    .citecard-marker {
      color: #70757a;
      margin-right: 6px;
    }
    .citecard-arrow {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      color: inherit;
      cursor: pointer;
    }
    .citecard-arrow svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }
    .citecard-arrow:hover, .citecard-number:hover {
      background: rgba(60, 64, 67, 0.08);
    }
    .citecard-message {
      margin-top: 6px;
      color: #b3261e;
    }
    .citecard-note {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #e8eaed;
      color: #70757a;
      font-size: 12px;
    }
    .citecard-title {
      color: #1a0dab;
      font-size: 17px;
      line-height: 20px;
      cursor: pointer;
    }
    .citecard-title:hover, .citecard-link:hover {
      text-decoration: underline;
    }
    .citecard-meta {
      margin-top: 2px;
      color: #006621;
    }
    .citecard-abstract {
      margin-top: 4px;
      word-wrap: break-word;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 4;
      overflow: hidden;
    }
    .citecard-abstract.expanded {
      display: block;
      -webkit-line-clamp: none;
      overflow: visible;
    }
    .citecard-more {
      display: block;
      margin-top: 2px;
    }
    .citecard-reference {
      color: #4d5156;
      word-wrap: break-word;
    }
    .citecard-reference.loading {
      color: #9aa0a6;
    }
    .citecard-links {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
      margin-top: 6px;
    }
    .citecard-link {
      padding: 0;
      border: 0;
      background: none;
      color: #1a0dab;
      font: inherit;
      cursor: pointer;
    }
    @media (prefers-color-scheme: dark) {
      .citecard {
        background: #303134;
        color: #bdc1c6;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6), 0 4px 8px 3px rgba(0, 0, 0, 0.3);
      }
      .citecard-nav {
        color: #9aa0a6;
      }
      .citecard-arrow:hover, .citecard-number:hover {
        background: rgba(232, 234, 237, 0.08);
      }
      .citecard-number.current {
        color: #8ab4f8;
      }
      .citecard-marker {
        color: #9aa0a6;
      }
      .citecard-message {
        color: #f28b82;
      }
      .citecard-note {
        border-top-color: #3c4043;
        color: #9aa0a6;
      }
      .citecard-title, .citecard-link {
        color: #8ab4f8;
      }
      .citecard-meta {
        color: #81c995;
      }
      .citecard-reference {
        color: #bdc1c6;
      }
      .citecard-reference.loading {
        color: #80868b;
      }
    }
  `;
  document.head.append(style);

  const CHEVRON_LEFT = '<svg viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
  const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24"><path d="M8.59 16.59 10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>';

  let card = null;
  let pendingClick = null;
  const attachedViews = new Map();
  const papers = new WeakMap();

  // The paper's reference list, as Zotero found it, described once per view
  function describePaper(view) {
    let paper = papers.get(view);
    if (!paper) {
      // Zotero's citations only; the plugin's own are already resolved
      let overlays = Object.values(view._processedPageOverlays || {}).flat().filter(overlay => !overlay.cited);
      let references = overlays.flatMap(overlay => overlay.references || []);
      if (!references.length) {
        return null;
      }
      paper = CiteCardCitations.describePaper(references.map(reference => reference.text),
        new Set(references.filter(reference => reference.index).map(reference => reference.text)).size);
      papers.set(view, paper);
    }
    return paper;
  }

  // The page text on each side of a citation, for reading author-year citations
  function textAround(view, overlay) {
    let chars = view._pdfPages?.[overlay.position.pageIndex]?.chars;
    let first = overlay.word?.[0];
    let start = chars && first ? chars.findIndex(char => char.c === first.c && char.rect?.[0] === first.rect[0] && char.rect?.[1] === first.rect[1]) : -1;
    if (start < 0) {
      return { left: '', right: '' };
    }
    let join = list => list.map(char => char.c + (char.spaceAfter ? ' ' : '')).join('');
    let context = CiteCardCitations.CONTEXT;
    return {
      left: join(chars.slice(Math.max(0, start - context), start)),
      right: join(chars.slice(start, start + overlay.word.length + context))
    };
  }

  // Links in PDFs made with hyperref, common in author-year papers such as ICLR's, point to
  // the cited entry; Zotero often can't read those papers' reference lists itself. A link is
  // a citation when the entry it points to fits its text. Results are kept per link.
  const linkEntries = new Map();
  const linkKey = overlay => JSON.stringify([overlay.position, overlay.destinationPosition]);

  function textInRects(chars, rects) {
    return chars.filter(char => char.rect && rects.some(rect => char.rect[0] >= rect[0] - 1 && char.rect[2] <= rect[2] + 1
      && char.rect[1] >= rect[1] - 2 && char.rect[3] <= rect[3] + 2))
      .map(char => char.c + (char.spaceAfter ? ' ' : '')).join('').trim();
  }

  // The cited entry's text, null when the link isn't a citation, or undefined until the
  // pages involved have been read
  function linkedEntry(view, overlay) {
    let key = linkKey(overlay);
    if (linkEntries.has(key)) {
      return linkEntries.get(key);
    }
    let destination = overlay.destinationPosition;
    let source = view._pdfPages?.[overlay.position.pageIndex]?.chars;
    let target = view._pdfPages?.[destination.pageIndex]?.chars;
    if (!source || !target) {
      return undefined;
    }
    let entry = CiteCardCitations.entryAt(target, destination.rects[0]);
    let result = CiteCardCitations.linkFitsEntry(textInRects(source, overlay.position.rects), entry) ? entry : null;
    linkEntries.set(key, result);
    return result;
  }

  async function loadLinkedEntry(view, overlay) {
    await pageChars(view, overlay.position.pageIndex);
    await pageChars(view, overlay.destinationPosition.pageIndex);
    return linkedEntry(view, overlay);
  }

  // The references a clicked citation cites, or [] when it isn't a genuine citation
  function citedReferences(view, overlay) {
    if (overlay.cited) {
      return overlay.cited;
    }
    let paper = describePaper(view);
    if (!paper) {
      return [];
    }
    let references = [];
    for (let { text, index } of overlay.references) {
      text = text.trim();
      if (!references.some(reference => reference.text === text)) {
        references.push({ text, number: index || null });
      }
    }
    let word = overlay.word.map(char => char.c).join('');
    let { left, right } = textAround(view, overlay);
    return CiteCardCitations.citedReferences(word, references, paper, left, right);
  }

  function el(tag, className, text) {
    let node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  }

  function link(className, text, url) {
    let node = el('span', className, text);
    node.dataset.url = url;
    return node;
  }

  function scholarSearchURL(query) {
    return 'https://scholar.google.com/scholar?q=' + encodeURIComponent(query);
  }

  // number: the reference's number in the paper's reference list, if it has one
  function renderPaper(row, meta, number, text) {
    let title = link('citecard-title', meta.title, meta.titleURL);
    if (number) {
      title.prepend(el('span', 'citecard-marker', '[' + number + ']'));
    }
    row.replaceChildren(title);
    if (meta.metaLine) {
      row.append(el('div', 'citecard-meta', meta.metaLine));
    }
    if (meta.abstract) {
      let abstract = el('div', 'citecard-abstract', meta.abstract);
      row.append(abstract);
      // Abstracts longer than four lines are cut off until expanded
      if (abstract.scrollHeight > abstract.clientHeight + 1) {
        let more = el('button', 'citecard-link citecard-more', 'Show more');
        more.addEventListener('click', () => {
          let expanded = abstract.classList.toggle('expanded');
          more.textContent = expanded ? 'Show less' : 'Show more';
          position();
        });
        row.append(more);
      }
    }
    let links = el('div', 'citecard-links');
    links.append(zoteroButton(meta, text));
    for (let { label, url } of meta.links) {
      links.append(link('citecard-link', label, url));
    }
    row.append(links);
    // Without this note an OpenAlex card would pass for a Google Scholar one
    if (meta.scholarNote) {
      let note = el('div', 'citecard-note');
      if (meta.scholarNote === 'blocked') {
        note.append('Google Scholar asked for a CAPTCHA, so this is from OpenAlex. ', scholarButton('Open Google Scholar', meta.title));
      }
      else if (meta.scholarNote === 'signed-out') {
        note.append('From OpenAlex. ', scholarButton('Sign in to Google Scholar'));
      }
      else {
        note.append('From OpenAlex.');
      }
      row.append(note);
    }
  }

  function scholarButton(label, search) {
    let button = el('button', 'citecard-link', label);
    button.addEventListener('click', () => {
      closeCard();
      host.openScholar(search);
    });
    return button;
  }

  // Opens the paper when it's already in a Zotero library, otherwise adds it
  function zoteroButton(meta, reference) {
    let button = el('button', 'citecard-link');
    let showOpen = itemID => {
      button.textContent = 'Open in Zotero';
      button.onclick = () => {
        closeCard();
        host.openInZotero(itemID);
      };
    };
    if (meta.libraryItemID) {
      showOpen(meta.libraryItemID);
    }
    else {
      button.textContent = 'Add to Zotero';
      button.onclick = async () => {
        button.disabled = true;
        button.textContent = 'Adding…';
        let itemID = await host.addToZotero({ doi: meta.doi, arxiv: meta.arxiv, titleURL: meta.titleURL, title: meta.title, reference })
          .catch(error => {
            host.log('add failed: ' + error.message);
            return null;
          });
        button.disabled = false;
        if (itemID) {
          showOpen(itemID);
        }
        else {
          button.textContent = 'Couldn\'t add — retry';
        }
      };
    }
    return button;
  }

  function renderUnresolved(row, text, message) {
    row.replaceChildren(el('div', 'citecard-reference', text));
    if (message) {
      row.append(el('div', 'citecard-message', message));
    }
    let links = el('div', 'citecard-links');
    links.append(link('citecard-link', 'Search Google Scholar', scholarSearchURL(text)));
    row.append(links);
  }

  // Which reference of a citation such as [10, 37] was clicked: the number under the click,
  // or the nearest one. Citations without numbers start at their first reference.
  function clickedReferenceIndex(overlay, references, clickPosition) {
    let x = clickPosition?.rects?.[0]?.[0];
    if (x === undefined || !overlay.word) {
      return 0;
    }
    let numbers = [];
    let current = null;
    for (let char of overlay.word) {
      if (/\d/.test(char.c)) {
        if (!current) {
          current = { digits: '', from: char.rect[0], to: char.rect[2] };
          numbers.push(current);
        }
        current.digits += char.c;
        current.to = char.rect[2];
      }
      else {
        current = null;
      }
    }
    let distance = number => (x < number.from ? number.from - x : x > number.to ? x - number.to : 0);
    let clicked = numbers.sort((a, b) => distance(a) - distance(b))[0];
    let index = clicked ? references.findIndex(reference => reference.number === Number(clicked.digits)) : -1;
    return Math.max(index, 0);
  }

  // A citation such as [10, 37] shows one reference at a time. Numbered references get a
  // clickable number each; others get arrows and a counter.
  function openCard(view, overlay, clickPosition, references) {
    closeCard();
    let numbered = references.every(reference => reference.number);
    // Looked up only when shown, so flipping past references doesn't send requests for them
    let lookups = new Map();
    card = el('div', 'citecard');
    card.anchor = { view, overlay };
    card.addEventListener('click', event => {
      let target = (event.target.closest ? event.target : event.target.parentElement)?.closest('[data-url]');
      if (target) {
        host.open(target.dataset.url);
      }
    });
    let row = el('div');
    let counter = el('span', 'citecard-counter');
    let numberButtons = [];
    if (references.length > 1) {
      let nav = el('div', 'citecard-nav');
      let previous = el('button', 'citecard-arrow');
      let next = el('button', 'citecard-arrow');
      previous.innerHTML = CHEVRON_LEFT;
      next.innerHTML = CHEVRON_RIGHT;
      previous.title = 'Previous reference';
      next.title = 'Next reference';
      previous.addEventListener('click', () => card.show(card.index - 1));
      next.addEventListener('click', () => card.show(card.index + 1));
      if (numbered) {
        numberButtons = references.map((reference, index) => {
          let button = el('button', 'citecard-number', String(reference.number));
          button.addEventListener('click', () => card.show(index));
          return button;
        });
        nav.append(previous, ...numberButtons, next);
      }
      else {
        nav.append(previous, counter, next);
      }
      card.append(nav);
    }
    card.append(row);
    card.show = index => {
      let shown = (index + references.length) % references.length;
      let { text, number, note } = references[shown];
      card.index = shown;
      counter.textContent = (shown + 1) + ' of ' + references.length;
      numberButtons.forEach((button, i) => button.classList.toggle('current', i === shown));
      // A footnote that doesn't cite a work is shown as it is
      if (note) {
        row.replaceChildren(el('div', 'citecard-reference', text));
        position();
        return;
      }
      row.replaceChildren(el('div', 'citecard-reference loading', text));
      if (!lookups.has(shown)) {
        lookups.set(shown, host.lookup(text));
      }
      lookups.get(shown).then(meta => {
        if (card?.index !== shown || !row.isConnected) {
          return;
        }
        try {
          if (meta) {
            renderPaper(row, meta, number, text);
          }
          else {
            renderUnresolved(row, text);
          }
          position();
        }
        catch (e) {
          report(e);
          closeCard();
        }
      }, error => {
        if (card?.index === shown && row.isConnected) {
          renderUnresolved(row, text, error.message);
          position();
        }
      });
      position();
    };
    document.body.append(card);
    card.show(clickedReferenceIndex(overlay, references, clickPosition));
  }

  // Below the citation, or above it when there is more room there
  function position() {
    if (!card) {
      return;
    }
    let { view, overlay } = card.anchor;
    let margin = 12;
    let gap = 8;
    let frame = view._iframe.getBoundingClientRect();
    let rect = view.getClientRect(overlay.position.rects[0], overlay.position.pageIndex);
    let top = frame.top + rect[1];
    let bottom = frame.top + rect[3];
    let width = Math.min(560, window.innerWidth - 2 * margin);
    card.style.width = width + 'px';
    card.style.left = Math.max(margin, Math.min(frame.left + rect[0], window.innerWidth - width - margin)) + 'px';
    card.style.maxHeight = '';
    let height = card.offsetHeight;
    let below = window.innerHeight - bottom - gap - margin;
    let above = top - gap - margin;
    if (height <= below || below >= above) {
      card.style.top = bottom + gap + 'px';
      card.style.maxHeight = below + 'px';
    }
    else {
      card.style.top = Math.max(margin, top - gap - height) + 'px';
      card.style.maxHeight = above + 'px';
    }
  }

  function closeCard() {
    card?.remove();
    card = null;
  }

  function handleKeyDown(event) {
    if (!card) {
      return;
    }
    if (event.key === 'Escape') {
      closeCard();
    }
    else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && card.querySelector('.citecard-nav')) {
      card.show(card.index + (event.key === 'ArrowLeft' ? -1 : 1));
      event.preventDefault();
    }
    else {
      return;
    }
    event.stopPropagation();
  }

  function handleReaderPointerDown(event) {
    if (card && !card.contains(event.target)) {
      closeCard();
    }
  }

  function attachView(view) {
    let win = view._iframeWindow;
    // Views without these (Reading Mode, EPUBs, or a changed reader) keep Zotero's behavior
    if (attachedViews.has(view) || !win || !view._iframe
      || VIEW_METHODS.some(method => typeof view[method] !== 'function')) {
      return;
    }
    // Remember a genuine citation under a finished click so the view's own handler, which
    // runs next, can be redirected from navigating to opening the card. Anything else keeps
    // Zotero's behavior.
    let handlePointerUp = event => {
      if (event.button !== 0) {
        return;
      }
      try {
        let clickPosition = view.pointerEventToPosition(event);
        let overlay = view._getSelectableOverlay(clickPosition);
        if (overlay?.type === 'internal-link' && overlay.destinationPosition && linkedEntry(view, overlay) !== null) {
          pendingClick = { view, overlay, clickPosition, link: true };
          setTimeout(() => pendingClick = null);
          return;
        }
        let references = overlay?.type === 'citation' && overlay.references?.length ? citedReferences(view, overlay) : [];
        if (references.length) {
          pendingClick = { view, overlay, clickPosition, references };
          setTimeout(() => pendingClick = null);
        }
      }
      catch (e) {
        report(e);
      }
    };
    let listeners = [
      ['pointerup', handlePointerUp],
      ['pointerdown', closeCard],
      ['scroll', closeCard],
      ['keydown', handleKeyDown]
    ];
    for (let [type, listener] of listeners) {
      win.addEventListener(type, listener, true);
    }
    // If the card can't be shown, the click jumps to the reference list as it would without
    // the plugin. A link is followed once it turns out not to be a citation.
    view.navigate = function (location, options) {
      let navigate = () => Object.getPrototypeOf(this).navigate.call(this, location, options);
      if (pendingClick?.view === this && pendingClick.link) {
        let { overlay, clickPosition } = pendingClick;
        pendingClick = null;
        loadLinkedEntry(this, overlay).then(entry => {
          if (entry) {
            openCard(this, overlay, clickPosition, [{ text: entry, number: null }]);
          }
          else {
            navigate();
          }
        }).catch(error => {
          report(error);
          closeCard();
          navigate();
        });
        return;
      }
      if (pendingClick?.view === this) {
        let { overlay, clickPosition, references } = pendingClick;
        pendingClick = null;
        try {
          openCard(this, overlay, clickPosition, references);
          return;
        }
        catch (e) {
          report(e);
          closeCard();
        }
      }
      return navigate();
    };
    profileOf(view);
    // Zotero reads the paper's citations and links after the view opens and updates its
    // statistics when done, which is when they can be tidied
    let updateViewStats = view._updateViewStats;
    if (typeof updateViewStats === 'function') {
      view._updateViewStats = function (...args) {
        let result = updateViewStats.apply(this, args);
        tidyView(this);
        return result;
      };
    }
    attachedViews.set(view, () => {
      delete view.navigate;
      delete view._updateViewStats;
      for (let [type, listener] of listeners) {
        win.removeEventListener(type, listener, true);
      }
    });
  }

  // hyperref often makes separate links of "Chung et al." and "2022a". Links to the same place
  // with only spaces or punctuation between them are merged into one, so a citation highlights
  // and clicks as a whole; on one line the gap between them is covered too. Two citations of
  // the same paper, as in "[41] … [41]", have words between them and stay apart.
  function mergeSplitLinks(chars, overlays) {
    if (!chars) {
      return;
    }
    let indexes = link => chars.flatMap((char, i) => (char.rect && link.position.rects.some(rect => insideRect(char.rect, rect)) ? [i] : []));
    let links = overlays.filter(overlay => overlay.type === 'internal-link' && overlay.destinationPosition)
      .map(link => ({ link, chars: indexes(link) }))
      .filter(({ chars }) => chars.length)
      .sort((a, b) => a.chars[0] - b.chars[0]);
    let current = links[0];
    for (let next of links.slice(1)) {
      let gap = chars.slice(current.chars.at(-1) + 1, next.chars[0]).map(char => char.c).join('');
      if (gap.length > 4 || !/^[\s,;.([]*$/.test(gap)
        || JSON.stringify(current.link.destinationPosition) !== JSON.stringify(next.link.destinationPosition)) {
        current = next;
        continue;
      }
      let last = current.link.position.rects.at(-1);
      let first = next.link.position.rects[0];
      let sameLine = Math.min(last[3], first[3]) - Math.max(last[1], first[1]) > (last[3] - last[1]) / 2;
      current.link.position = {
        ...current.link.position,
        rects: sameLine
          ? [...current.link.position.rects.slice(0, -1), [last[0], Math.min(last[1], first[1]), first[2], Math.max(last[3], first[3])], ...next.link.position.rects.slice(1)]
          : [...current.link.position.rects, ...next.link.position.rects]
      };
      current.chars = [...current.chars, ...next.chars];
      overlays.splice(overlays.indexOf(next.link), 1);
    }
  }

  // How long setting up a paper takes, for bug reports: each step, how often page text is read
  // and how often Zotero had to load it, and the reference lists read
  const profiles = new WeakMap();
  function profileOf(view) {
    if (!profiles.has(view)) {
      profiles.set(view, { opened: Date.now(), steps: {}, reads: 0, loads: 0, loadTime: 0 });
    }
    return profiles.get(view);
  }

  async function step(view, name, run) {
    let started = Date.now();
    try {
      return await run();
    }
    finally {
      let steps = profileOf(view).steps;
      steps[name] = (steps[name] || 0) + Date.now() - started;
    }
  }

  // A page's characters, loading them when Zotero doesn't have them
  async function pageChars(view, pageIndex) {
    let profile = profileOf(view);
    profile.reads++;
    if (!view._pdfPages[pageIndex]) {
      let started = Date.now();
      profile.loads++;
      await view._ensureBasicPageData(pageIndex);
      profile.loadTime += Date.now() - started;
    }
    return view._pdfPages[pageIndex].chars;
  }

  // Citations are set up in two steps. As soon as a paper opens, the plugin reads its pages'
  // text and adds the citations it finds against the paper's reference lists, and footnote
  // marks, so they can be clicked at once; Zotero can take a minute or more to read a long,
  // link-heavy paper itself. When Zotero has read it, its citations and links are tidied to
  // match what the plugin opens cards for, and where they cover a citation the plugin found,
  // the plugin's, already matched to its entry, is kept.
  const setups = new WeakMap();
  function tidyView(view) {
    let setup = setups.get(view);
    if (!setup) {
      setup = {};
      setups.set(view, setup);
    }
    if (!setup.found && view._iframeWindow?.PDFViewerApplication?.pagesCount) {
      setup.found = findCitations(view).catch(report);
    }
    if (setup.found && !setup.tidied && zoteroHasRead(view)) {
      setup.tidied = setup.found.then(() => tidyZoteroOverlays(view)).catch(report);
    }
  }

  async function findCitations(view) {
    let started = Date.now();
    await step(view, 'reference lists', () => addMissingCitations(view));
    await step(view, 'footnotes', () => addFootnoteCitations(view));
    let profile = profileOf(view);
    host.log(`found ${[...ownOf(view).pages.values()].flat().length} citations in ${Date.now() - started} ms, `
      + `${Date.now() - profile.opened} ms after opening (`
      + Object.entries(profile.steps).map(([name, time]) => `${name} ${time} ms`).join(', ')
      + `); read page text ${profile.reads} times, loading it ${profile.loads} times in ${profile.loadTime} ms; `
      + `reference lists: ${profile.lists?.join(', ') || 'none'}`);
  }

  // Zotero's citations and links are tidied: split links merged, author-year words merged
  // into whole citations, citations that open no card, such as equation numbers or a
  // paper's own author list, removed, and links on authors' names in papers citing by number
  // removed. Then the plugin's citations are put back over them.
  async function tidyZoteroOverlays(view) {
    let started = Date.now();
    let waited = started - profileOf(view).opened;
    await cleanUpZoteroOverlays(view);
    restoreOwnOverlays(view);
    host.log(`Zotero read the paper in ${waited} ms; tidied its citations in ${Date.now() - started} ms`);
  }

  async function cleanUpZoteroOverlays(view) {
    let paper = describePaper(view);
    for (let [pageIndex, overlays] of Object.entries(view._processedPageOverlays)) {
      let hasCitations = overlays.some(overlay => overlay.type === 'citation');
      if (!hasCitations && !overlays.some(overlay => overlay.type === 'internal-link')) {
        continue;
      }
      let chars = await pageChars(view, Number(pageIndex));
      mergeSplitLinks(chars, overlays);
      // In a numbered list only the numbers are citations, so a link on the authors' names
      // before one, as in "Ho et al. [31]", is left out
      for (let link of overlays.filter(overlay => overlay.type === 'internal-link' && overlay.destinationPosition)) {
        let entry = await loadLinkedEntry(view, link);
        if (entry && /^\s*[[(]?\d{1,3}[\]).]/.test(entry) && !/\d/.test(textInRects(chars, link.position.rects))) {
          overlays.splice(overlays.indexOf(link), 1);
        }
      }
      if (!paper || !hasCitations) {
        continue;
      }
      if (paper.real && !paper.numbered) {
        mergeCitationWords(chars, overlays);
      }
      for (let overlay of overlays.filter(overlay => overlay.type === 'citation')) {
        if (!citedReferences(view, overlay).length) {
          overlays.splice(overlays.indexOf(overlay), 1);
        }
      }
    }
  }

  // The lines of a page's characters, each with its text, left edge, whether it ends a
  // paragraph, and where it starts and ends and where its characters are among the page's
  function pageLines(chars) {
    let lines = [];
    let start = 0;
    for (let i = 0; i < chars.length; i++) {
      if (chars[i].lineBreakAfter || chars[i].paragraphBreakAfter || i === chars.length - 1) {
        let indexes = [];
        for (let k = start; k <= i; k++) {
          if (chars[k].rect) {
            indexes.push(k);
          }
        }
        let line = indexes.map(k => chars[k]);
        if (line.length) {
          lines.push({
            start,
            end: i + 1,
            indexes,
            chars: line,
            text: line.map(char => char.c + (char.spaceAfter ? ' ' : '')).join('').trim(),
            x: line[0].rect[0],
            paragraphEnd: !!chars[i].paragraphBreakAfter
          });
        }
        start = i + 1;
      }
    }
    return lines;
  }

  // Running headers and footers, such as "Supplementary Material 19", and page numbers, from
  // each page's lines: lines among the first or last three of a page that, numbers aside, are
  // among those of two other pages and have words, or are only a number. Returned as
  // "pageIndex:start" keys.
  function runningLines(pages) {
    let bare = text => text.replace(/\d+/g, '#');
    let edges = pages.map(lines => [...new Set([...lines.slice(0, 3), ...lines.slice(-3)])]);
    let count = new Map();
    for (let lines of edges) {
      for (let text of new Set(lines.map(line => bare(line.text)))) {
        count.set(text, (count.get(text) || 0) + 1);
      }
    }
    return new Set(edges.flatMap((lines, pageIndex) => lines
      .filter(line => /^\d+$/.test(line.text) || /(\p{L}.*){4}/u.test(line.text) && count.get(bare(line.text)) >= 3)
      .map(line => pageIndex + ':' + line.start)));
  }

  // Some papers' citations aren't found by Zotero at all, as in Econometrica's style, "(He,
  // 1997)", or only some are. The plugin reads each reference list (after each "References"
  // heading, or a list labeled [1], [2], … without a heading), finds citations in the text
  // outside the lists, and adds those that name entries and aren't already a citation or
  // link: author-year citations, bracketed numbers or labels such as "[3–5]" or "[AFO17]",
  // and superscript numbers. A citation names entries of the first list after it that has
  // them, so in a thesis each chapter's citations go to its own list, and in a book with notes
  // after each chapter they go to the bibliography at the end. Each keeps the entries it
  // names, so a click opens their card without resolving it again.
  async function addMissingCitations(view) {
    let pageCount = view._iframeWindow.PDFViewerApplication.pagesCount;
    let linesOf = async pageIndex => {
      return pageLines(await pageChars(view, pageIndex));
    };
    // A list starts after a heading, or without one at a line starting "[1]" soon followed by
    // one starting "[2]"
    let headings = [];
    let all = [];
    let pages = [];
    await step(view, 'reading pages', async () => {
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        pages.push(await linesOf(pageIndex));
        pages[pageIndex].forEach((line, i) => all.push({ pageIndex, i, line }));
      }
    });
    let running = runningLines(pages);
    all.forEach(({ pageIndex, i, line }, g) => {
      let previous = headings.at(-1);
      if (CiteCardCitations.isBibliographyHeading(line.text)) {
        headings.push({ pageIndex, line: i, start: line.start, at: g });
      }
      else if (/^\s*\[1\]/.test(line.text) && all.slice(g + 1, g + 16).some(next => /^\s*\[2\]/.test(next.line.text))
        && !(previous && g - previous.at <= 3)) {
        headings.push({ pageIndex, line: i - 1, start: line.start, at: g });
      }
    });
    let lists = [];
    for (let [i, heading] of headings.entries()) {
      let { entries, end } = await step(view, 'reading lists', () => readBibliography(heading, headings[i + 1], pageCount, linesOf, running));
      if (entries.length >= 3) {
        let byLabel = new Map(entries.filter(entry => entry.number !== null).map(entry => [String(entry.number), entry]));
        // A list continuing another's numbers, as an appendix's from [62], shares its entries
        if (typeof entries[0].number === 'number' && entries[0].number > 1 && lists.length) {
          byLabel = new Map([...lists.at(-1).byLabel, ...byLabel]);
        }
        lists.push({
          pageIndex: heading.pageIndex,
          start: heading.start,
          end,
          entries,
          texts: entries.map(entry => entry.text),
          byLabel,
          superscripts: ['dot', 'paren', 'plain'].includes(entries[0].style)
        });
      }
    }
    profileOf(view).lists = lists.map(list => `pages ${list.pageIndex + 1}–${list.end.pageIndex + 1} (${list.entries.length} entries)`);
    if (lists.length) {
      await step(view, 'matching citations', () => addCitations(view, lists, pageCount));
    }
  }

  // Adds the citations of reference lists' entries found in the text outside the lists
  async function addCitations(view, lists, pageCount) {
    let labels = new Set(lists.flatMap(list => [...list.byLabel.keys()]));
    // The lists after a place in the text, nearest first, then the last list for text after
    // all of them, as in an appendix
    let listsAfter = (pageIndex, index) => {
      let after = lists.filter(list => list.pageIndex > pageIndex || list.pageIndex === pageIndex && list.start > index);
      return after.length ? after : [lists.at(-1)];
    };
    let name = (citation, pageIndex) => {
      for (let list of listsAfter(pageIndex, citation.from)) {
        let named = citation.labels
          ? (citation.labels.every(label => list.byLabel.has(label)) ? citation.labels.map(label => list.byLabel.get(label)) : [])
          : CiteCardCitations.matchAuthorYear(citation, list.texts).map(text => list.entries[list.texts.indexOf(text)]);
        if (named.length && (!citation.superscript || list.superscripts || !bracketed)) {
          return named;
        }
      }
      return [];
    };
    // The text of a page outside the lists, in stretches, as { from, text, charAt }; a list
    // may start and end on the same page
    let stretches = async pageIndex => {
      let chars = await pageChars(view, pageIndex);
      let cuts = lists.map(list => [list.pageIndex < pageIndex ? 0 : list.pageIndex === pageIndex ? list.start : Infinity,
        list.end.pageIndex > pageIndex ? chars.length : list.end.pageIndex === pageIndex ? list.end.start : -Infinity])
        .filter(([from, to]) => from < to).sort((a, b) => a[0] - b[0]);
      let result = [];
      let at = 0;
      for (let [from, to] of [...cuts, [chars.length, chars.length]]) {
        if (from > at) {
          result.push({ from: at, to: from, ...textOf(chars.slice(at, from)) });
        }
        at = Math.max(at, to);
      }
      return { chars, stretches: result };
    };
    // A paper citing with bracketed numbers doesn't also cite with superscripts, so there a
    // raised number is math or an affiliation. Papers with "[1]" labels that cite with
    // superscripts, as SPIE's do, have hardly any bracketed citations.
    let bracketed = 0;
    for (let pageIndex = 0; pageIndex < pageCount && bracketed < 3; pageIndex++) {
      for (let { text } of (await stretches(pageIndex)).stretches) {
        bracketed += new Set(CiteCardCitations.findLabeledCitations(text, labels).map(citation => citation.group)).size;
      }
    }
    bracketed = bracketed >= 3;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      let taken = ownTaken(view, pageIndex);
      let { chars, stretches: parts } = await stretches(pageIndex);
      let found = [];
      for (let { from, to, text, charAt } of parts) {
        found.push(...[...CiteCardCitations.findAuthorYearCitations(text), ...CiteCardCitations.findLabeledCitations(text, labels)]
          .map(citation => ({ ...citation, from: from + charAt[citation.start], to: from + charAt[citation.end - 1] })));
        // Superscript citations go with lists labeled "1.", "(1)" or "1", or with "[1]" labels in
        // a paper without bracketed citations. On the first page, the author block before the
        // abstract carries affiliation marks.
        let runsFrom = from;
        if (pageIndex === 0) {
          let opening = text.search(/\b(Abstract|ABSTRACT|Introduction|INTRODUCTION|Summary|SUMMARY)\b/);
          runsFrom = opening < 0 ? from : from + charAt[opening];
        }
        for (let run of superscriptRuns(chars, runsFrom, to)) {
          found.push({ ...run, labels: run.numbers, superscript: true });
        }
      }
      let added = [];
      for (let citation of found) {
        let word = chars.slice(citation.from, citation.to + 1).filter(char => char.rect);
        let named = word.length && !word.some(char => taken.some(rect => insideRect(char.rect, rect))) ? name(citation, pageIndex) : [];
        if (!named.length) {
          continue;
        }
        let overlay = citationOverlay(pageIndex, citation.from, word, named);
        taken.push(...overlay.position.rects);
        added.push(overlay);
      }
      addOverlays(view, pageIndex, added);
    }
  }

  // A citation the plugin adds, keeping the entries it names. A small one, such as a raised
  // footnote mark, gets at least a line's height and some room on each side, so it can be hit.
  function citationOverlay(pageIndex, index, word, named) {
    let rects = lineRects(word).map(([x1, y1, x2, y2]) => {
      let grow = Math.max(0, 9 - (y2 - y1)) / 2;
      let side = grow ? 1.5 : 0;
      return [x1 - side, y1 - grow, x2 + side, y2 + grow];
    });
    return {
      type: 'citation',
      word,
      position: { pageIndex, rects },
      sortIndex: [String(pageIndex).padStart(5, '0'), String(index).padStart(6, '0'), '00000'].join('|'),
      references: named.map(({ text, position }) => ({ text, position })),
      cited: named.map(({ text, number, note }) => ({ text, number, note }))
    };
  }

  // The citations the plugin added, by page. Zotero rebuilds a page's overlays from its
  // processed overlays whenever it loads the page again, and replaces those when it has read
  // the paper, so the plugin keeps its own to put back. Lists the plugin made itself, before
  // Zotero read the paper, are remembered as its own.
  const own = new WeakMap();
  function ownOf(view) {
    if (!own.has(view)) {
      own.set(view, { pages: new Map(), lists: new WeakSet() });
    }
    return own.get(view);
  }

  function zoteroHasRead(view) {
    let lists = ownOf(view).lists;
    return Object.values(view._processedPageOverlays || {}).some(list => !lists.has(list));
  }

  function addOverlays(view, pageIndex, added) {
    if (!added.length) {
      return;
    }
    let mine = ownOf(view);
    mine.pages.set(pageIndex, [...(mine.pages.get(pageIndex) || []), ...added]);
    let list = view._processedPageOverlays[pageIndex];
    if (!list) {
      // Keeps the page's own links, which Zotero lists before it has read the paper
      list = [...(view._pdfPages[pageIndex]?.overlays || [])];
      mine.lists.add(list);
      view._processedPageOverlays[pageIndex] = list;
    }
    placeOwn(list, mine.pages.get(pageIndex));
    if (view._pdfPages[pageIndex]) {
      view._pdfPages[pageIndex].overlays = list;
    }
  }

  // Where the plugin's own citations already are on a page
  function ownTaken(view, pageIndex) {
    return (ownOf(view).pages.get(pageIndex) || []).flatMap(overlay => overlay.position.rects);
  }

  // Puts the plugin's citations into a page's overlays, removing Zotero's citations and links
  // under them
  function placeOwn(list, mine) {
    let words = mine.flatMap(overlay => overlay.word);
    for (let overlay of list.filter(overlay => !mine.includes(overlay) && (overlay.type === 'citation' || overlay.type === 'internal-link'))) {
      if (words.some(char => char.rect && overlay.position.rects.some(rect => insideRect(char.rect, rect)))) {
        list.splice(list.indexOf(overlay), 1);
      }
    }
    list.push(...mine.filter(overlay => !list.includes(overlay)));
  }

  // Puts the plugin's citations back once Zotero has replaced the overlays with its own
  function restoreOwnOverlays(view) {
    for (let [pageIndex, mine] of ownOf(view).pages) {
      let list = view._processedPageOverlays[pageIndex] ??= [];
      placeOwn(list, mine);
      if (view._pdfPages[pageIndex]) {
        view._pdfPages[pageIndex].overlays = list;
      }
    }
  }


  // Runs of small raised digits in characters from one index to another, as superscript
  // citations ("RAxML¹²", "in¹¹", "arylalkynes.¹⁶,²³") and footnote marks are set, split at
  // commas, with the numbers in each part. The run must sit above what comes before it, with no
  // space, on one line at one height, and end the word. Before it comes punctuation other than
  // a closing bracket, or a word of two or more letters that isn't a math function, a unit or
  // other notation and has no Greek letter. So math isn't a run: "R³", "10⁵", "cm²", "(x)²",
  // "‖x‖²₂", "cos²", "σ²", "QP²GI", "C(sp²)".
  const MATH_WORDS = /^(sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|arcsin|arccos|arctan|log|ln|exp|max|min|sup|inf|lim|det|arg|deg|dim|ker|mod|gcd|var|cov|tr|diag|rank|mm|cm|km|nm|kg|mg|ms|ns|Hz|dB|sp)$/i;
  function superscriptRuns(chars, from, to) {
    let runs = [];
    for (let i = Math.max(from, 1); i < to; i++) {
      let char = chars[i];
      let before = chars[i - 1];
      if (!/\d/.test(char.c) || /[\d,–-]/.test(before.c) || !char.rect || !before.rect || before.spaceAfter
        || !(char.fontSize < before.fontSize * 0.95)
        || (char.rect[1] - before.rect[1]) / (before.rect[3] - before.rect[1]) < 0.25) {
        continue;
      }
      let word = 0;
      while (i - 1 - word >= 0 && /\p{L}/u.test(chars[i - 1 - word].c) && !(word && chars[i - 1 - word].spaceAfter)) {
        word++;
      }
      let base = chars.slice(i - word, i).map(char => char.c).join('');
      if (word ? word < 2 || MATH_WORDS.test(base) || /\p{Script=Greek}/u.test(base) : !/[.,;:’”"'%]/.test(before.c)) {
        continue;
      }
      let end = i;
      while (end + 1 < to && /[\d,–-]/.test(chars[end + 1].c) && chars[end + 1].fontSize === char.fontSize && !chars[end].spaceAfter
        && !chars[end].lineBreakAfter && !chars[end].paragraphBreakAfter && chars[end + 1].rect
        && Math.abs(chars[end + 1].rect[1] - char.rect[1]) < (char.rect[3] - char.rect[1]) / 3) {
        end++;
      }
      let text = chars.slice(i, end + 1).map(char => char.c).join('').replace(/[,–-]+$/, '');
      // A letter or a subscript against the run continues the word or formula; PDFs often leave
      // out the space after a footnote mark, so the gap is measured
      let after = chars[end + 1];
      let inWord = /[\p{L}\d]/u.test(after?.c || '') && !chars[end].spaceAfter && !chars[end].lineBreakAfter
        && after.rect?.[0] - chars[end].rect[2] < before.fontSize * 0.15;
      if (!inWord && CiteCardCitations.citationNumbers(text).length) {
        // Each number or range in the run is its own citation
        let start = i;
        for (let part of text.split(',')) {
          runs.push({ from: start, to: start + part.length - 1, numbers: CiteCardCitations.citationNumbers(part) });
          start += part.length + 1;
        }
      }
      i = end;
    }
    return runs;
  }

  // Papers in the humanities and law cite in footnotes. Every footnote mark opens a card for
  // its footnote. A footnote citing a work is looked up; one pointing to an earlier note
  // ("Harden (n 11)") or back to the last citation ("Ibid.") is looked up as that citation;
  // one that only comments is shown as it is. Footnotes are the lines at the bottom of a page,
  // set smaller than the text above them, that start with a number; running headers and
  // footers aren't part of them. Marks are small raised numbers in the text above.
  async function addFootnoteCitations(view) {
    let pageCount = view._iframeWindow.PDFViewerApplication.pagesCount;
    let pages = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      pages.push(pageLines(await pageChars(view, pageIndex)));
    }
    let running = runningLines(pages);
    let size = line => line.chars.map(char => char.fontSize).sort((a, b) => a - b)[Math.floor(line.chars.length / 2)];
    let texts = new Map();
    let lastCiting = null;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      let chars = await pageChars(view, pageIndex);
      let lines = pages[pageIndex].filter(line => !running.has(pageIndex + ':' + line.start));
      // The body text's size: the largest that a good share of the page's characters are set
      // in, since headings have few characters and footnotes and labels are smaller
      let bySize = new Map();
      let lineChars = lines.flatMap(line => line.chars);
      for (let char of lineChars) {
        let rounded = Math.round(char.fontSize * 10) / 10;
        bySize.set(rounded, (bySize.get(rounded) || 0) + 1);
      }
      let body = Math.max(...[...bySize].filter(([, count]) => count >= lineChars.length * 0.15).map(([size]) => size));
      let area = lines.length;
      while (area > 0 && size(lines[area - 1]) < body * 0.92) {
        area--;
      }
      // A footnote starts with its number and then a word, a quote or a bracket, unlike a table's
      // row of numbers or a formula. Footnotes are numbered one after another, so a line
      // continuing one with a number, such as pages "477, 479.", doesn't start another.
      let footnotes = [];
      for (let line of lines.slice(area)) {
        let label = line.text.match(/^(\d{1,3})\.?\s*(?=[\p{L}“"‘'«([])/u);
        let number = Number(label?.[1]);
        if (label && (!footnotes.length || number === footnotes.at(-1).number + 1)) {
          footnotes.push({ number, text: line.text.slice(label[0].length) });
        }
        else if (footnotes.length) {
          footnotes.at(-1).text += ' ' + line.text;
        }
      }
      if (!footnotes.length) {
        continue;
      }
      let taken = ownTaken(view, pageIndex);
      chars = await pageChars(view, pageIndex);
      let marks = new Map(superscriptRuns(chars, 0, lines[area]?.start ?? chars.length)
        .filter(run => run.numbers.length === 1).map(run => [Number(run.numbers[0]), run]));
      let added = [];
      for (let footnote of footnotes) {
        let { kind, number } = CiteCardCitations.footnoteKind(footnote.text);
        let cited = kind === 'cites' ? footnote.text
          : kind === 'refers' ? texts.get(Number(number))
          : kind === 'earlier' ? lastCiting : null;
        texts.set(footnote.number, cited || footnote.text);
        if (cited) {
          lastCiting = cited;
        }
        let mark = marks.get(footnote.number);
        let word = mark && chars.slice(mark.from, mark.to + 1);
        if (!word || word.some(char => taken.some(rect => insideRect(char.rect, rect)))) {
          continue;
        }
        let position = { pageIndex, rects: [word[0].rect] };
        added.push(citationOverlay(pageIndex, mark.from, word, [cited
          ? { text: cited, number: footnote.number, position }
          : { text: footnote.text, number: footnote.number, note: true, position }]));
      }
      addOverlays(view, pageIndex, added);
    }
  }


  // Characters' text with their spaces and line breaks, and which character each position of
  // the text comes from
  function textOf(chars) {
    let text = '';
    let charAt = [];
    chars.forEach((char, i) => {
      let piece = char.c + (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter ? ' ' : '');
      text += piece;
      charAt.push(...Array(piece.length).fill(i));
    });
    return { text, charAt };
  }

  // The entries of a reference list after its heading, up to the next list's heading or an
  // appendix, as { text, number, style, position }, leaving out running headers and footers,
  // and where the list ends, as { pageIndex, start }: the page and index of the first character
  // after it. A labeled list, [1], [2], …, 1., 2., …,
  // (1), (2), …, or [AFO17], [BM14a], …, is split at its labels, since the end of one entry and the start of
  // the next can share a line in PDF text; numbers count only in sequence, so "2. Methods"
  // after the list isn't an entry. Otherwise an entry starts on a line after a paragraph's
  // end, or outdented from the line before it in a list with hanging indents.
  async function readBibliography(heading, next, pageCount, linesOf, running) {
    let pages = [];
    let last = next ? next.pageIndex : pageCount - 1;
    for (let pageIndex = heading.pageIndex; pageIndex <= last; pageIndex++) {
      let lines = await linesOf(pageIndex);
      let from = pageIndex === heading.pageIndex ? heading.line + 1 : 0;
      let kept = [];
      let ended = false;
      for (let i = from; i < lines.length && !ended; i++) {
        ended = pageIndex === next?.pageIndex && i > next.line;
        if (!ended && !running.has(pageIndex + ':' + lines[i].start)) {
          ended = /^(([A-Z]|\d{1,2})\.?\s+)?(appendix|appendices|supplementary)/i.test(lines[i].text);
          if (!ended) {
            kept.push(lines[i]);
          }
        }
      }
      pages.push({ pageIndex, lines: kept });
      if (ended) {
        break;
      }
    }
    let labeled = pages.flatMap(({ pageIndex, lines }) => lines.flatMap(line => line.chars.map((char, k) => ({ char, pageIndex, index: line.indexes[k] }))));
    let { text, charAt } = textOf(labeled.map(({ char }) => char));
    // The list ends where the next label is further away than any entry is long, as where a
    // thesis chapter's list is followed by the next chapter, whose citations continue its
    // numbers. An appendix's list may continue the numbers of the paper's, from its first label.
    let sequence = matches => {
      matches = [...matches];
      let from = expected => {
        let found = [];
        for (let match of matches) {
          if (found.length && match.index - found.at(-1).index > 1500) {
            break;
          }
          // One number may be missing, as where a paper printed an entry's label wrong
          if (Number(match[1]) === expected || found.length && Number(match[1]) === expected + 1) {
            found.push(match);
            expected = Number(match[1]) + 1;
          }
        }
        return found;
      };
      let found = from(1);
      return found.length < 3 && matches[0]?.index < 300 ? from(Number(matches[0][1])) : found;
    };
    let seen = new Set();
    let alpha = [...text.matchAll(/\[(\p{Lu}[\p{L}+]{0,7}\d{2}[a-z]?)\]\s*(?=\S)/gu)]
      .filter(match => !seen.has(match[1]) && seen.add(match[1]));
    // Plain numbers, as in "1 World Health Organization…" or "8 (a) Q. J. Yao…", count only at
    // the start of a line
    let firstPosition = [];
    charAt.forEach((char, position) => firstPosition[char] ??= position);
    let lineStarts = [];
    let count = 0;
    for (let { lines } of pages) {
      for (let line of lines) {
        lineStarts.push(firstPosition[count]);
        count += line.chars.length;
      }
    }
    let plain = lineStarts.flatMap(position => {
      let match = text.slice(position, position + 8).match(/^(\d{1,3})\s+(?=\p{M}?\p{L}|\()/u);
      return match ? [Object.assign(match, { index: position })] : [];
    });
    // The last entry ends at the first paragraph end after its year
    let lastEnd = start => {
      let year = new RegExp(CiteCardCitations.YEAR.source);
      for (let position = start; position < Math.min(text.length, start + 800); position++) {
        if (labeled[charAt[position]].char.paragraphBreakAfter && year.test(text.slice(start, position + 1))) {
          return position + 1;
        }
      }
      return Math.min(text.length, start + 800);
    };
    let labeledEntries = (style, labels) => labels.map((label, i) => {
      let start = label.index + label[0].indexOf(label[1]);
      let { char, pageIndex } = labeled[charAt[start]];
      return {
        text: text.slice(start - (/[[(]/.test(label[0]) ? 1 : 0), labels[i + 1]?.index ?? lastEnd(start)).trim(),
        number: /^\d+$/.test(label[1]) ? Number(label[1]) : label[1],
        style,
        position: { pageIndex, rects: [char.rect] }
      };
    });
    // A labeled list counts when it starts right after the heading and most of its entries are
    // references, not, say, a numbered list of affiliations after them or of notes after a
    // chapter
    for (let [style, labels] of [['bracket', sequence(text.matchAll(/\[(\d{1,3})\]\s*(?=\S)/g))],
      ['dot', sequence(text.matchAll(/(?:^|\s)(\d{1,3})\.\s+(?=\p{M}?\p{L}|\()/gu))],
      ['paren', sequence(text.matchAll(/(?:^|\s)\((\d{1,3})\)\s+(?=\p{M}?\p{L}|\()/gu))], ['plain', sequence(plain)], ['alpha', alpha]]) {
      // It starts the list, so a numbered list further on, as in an appendix, isn't taken
      let entries = labels.length >= 3 && labels[0].index < 300 ? labeledEntries(style, labels) : [];
      if (entries.length && entries.filter(entry => CiteCardCitations.looksLikeReference(entry.text)).length >= entries.length * 0.6) {
        let after = labeled[charAt[lastEnd(labels.at(-1).index) - 1]];
        return { entries, end: { pageIndex: after.pageIndex, start: after.index + 1 } };
      }
    }
    // Otherwise the list goes on through the pages where most entries look like references, and
    // on the page after them up to the first entry that doesn't, so it ends before an appendix
    let lines = pages.flatMap(({ pageIndex, lines }) => lines.map(line => ({ ...line, pageIndex })));
    let starts = CiteCardCitations.entryStarts(lines);
    let candidates = [];
    lines.forEach((line, i) => {
      if (starts[i]) {
        let end = starts.indexOf(true, i + 1);
        let last = lines[(end < 0 ? Math.min(lines.length, i + 12) : end) - 1];
        let text = lines.slice(i, lines.indexOf(last) + 1).map(line => line.text).join(' ');
        candidates.push({ text, reference: CiteCardCitations.looksLikeReference(text), pageIndex: line.pageIndex, rect: line.chars[0].rect, last });
      }
    });
    let chosen = [];
    for (let { pageIndex } of pages) {
      let onPage = candidates.filter(candidate => candidate.pageIndex === pageIndex);
      let references = onPage.filter(candidate => candidate.reference);
      if (chosen.length && references.length < onPage.length / 2) {
        let tail = onPage.findIndex(candidate => !candidate.reference);
        chosen.push(...onPage.slice(0, tail));
        break;
      }
      chosen.push(...references);
    }
    let lastLine = chosen.at(-1)?.last;
    return {
      entries: chosen.map(({ text, pageIndex, rect }) => ({ text, number: null, position: { pageIndex, rects: [rect] } })),
      end: lastLine ? { pageIndex: lastLine.pageIndex, start: lastLine.end } : { pageIndex: heading.pageIndex, start: heading.start }
    };
  }

  // Whether a character's center is inside a rectangle
  function insideRect(rect, outer) {
    let x = (rect[0] + rect[2]) / 2;
    let y = (rect[1] + rect[3]) / 2;
    return x >= outer[0] && x <= outer[2] && y >= outer[1] && y <= outer[3];
  }

  function mergeCitationWords(chars, overlays) {
    if (!chars) {
      return;
    }
    let indexOf = char => chars.findIndex(c => c.c === char.c && c.rect?.[0] === char.rect[0] && c.rect?.[1] === char.rect[1]);
    let words = overlays.filter(overlay => overlay.type === 'citation' && overlay.word?.length && !overlay.cited)
      .map(overlay => ({ overlay, start: indexOf(overlay.word[0]), end: indexOf(overlay.word.at(-1)) }))
      .filter(word => word.start >= 0 && word.end >= word.start)
      .sort((a, b) => a.start - b.start);
    let current = words[0];
    for (let next of words.slice(1)) {
      // The text after the first word up to the next, with its spaces and line breaks
      let gap = chars.slice(current.end, next.start)
        .map((char, i) => (i ? char.c : '') + (char.spaceAfter || char.lineBreakAfter ? ' ' : '')).join('');
      let word = chars.slice(current.start, current.end + 1).map(char => char.c).join('');
      if (!CiteCardCitations.joinsCitation(word, gap)) {
        current = next;
        continue;
      }
      let merged = current.overlay;
      merged.word = chars.slice(current.start, next.end + 1);
      merged.references = [...merged.references, ...next.overlay.references.filter(reference => !merged.references.some(r => r.text === reference.text))];
      merged.position = { ...merged.position, rects: lineRects(merged.word) };
      current.end = next.end;
      overlays.splice(overlays.indexOf(next.overlay), 1);
    }
  }

  // One rectangle for each line the characters are on
  function lineRects(chars) {
    let rects = [];
    for (let { rect } of chars) {
      let last = rects.at(-1);
      if (last && Math.min(last[3], rect[3]) - Math.max(last[1], rect[1]) > (rect[3] - rect[1]) / 2) {
        rects[rects.length - 1] = [Math.min(last[0], rect[0]), Math.min(last[1], rect[1]), Math.max(last[2], rect[2]), Math.max(last[3], rect[3])];
      }
      else {
        rects.push([...rect]);
      }
    }
    return rects;
  }

  function attachViews() {
    for (let view of reader._views) {
      attachView(view);
      if (attachedViews.has(view)) {
        tidyView(view);
      }
    }
  }


  // Drops hover popups on citations, including citation links. A link whose pages haven't
  // been read yet has its popup held back until they are, and restored if it isn't a
  // citation and is still hovered. Errors attaching to views never stop the reader's update.
  reader._updateState = function (state, init) {
    for (let key of POPUP_KEYS) {
      let popup = state[key];
      if (popup?.type === 'citation') {
        state = { ...state, [key]: null };
      }
      else if (popup?.type === 'internal-link' && popup.destinationPosition) {
        let view = key === 'primaryViewOverlayPopup' ? reader._primaryView : reader._secondaryView;
        let entry = view && linkedEntry(view, popup);
        if (entry === undefined && view) {
          loadLinkedEntry(view, popup).then(loaded => {
            let hovered = view._selectedOverlay;
            if (loaded === null && hovered && linkKey(hovered) === linkKey(popup)) {
              readerPrototype._updateState.call(reader, { [key]: popup });
            }
          }).catch(report);
        }
        if (entry !== null) {
          state = { ...state, [key]: null };
        }
      }
    }
    let result = readerPrototype._updateState.call(this, state, init);
    try {
      attachViews();
    }
    catch (e) {
      report(e);
    }
    return result;
  };

  document.addEventListener('pointerdown', handleReaderPointerDown, true);
  document.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('resize', closeCard);
  attachViews();

  window.__citecard = {
    teardown() {
      closeCard();
      delete reader._updateState;
      for (let detach of attachedViews.values()) {
        detach();
      }
      attachedViews.clear();
      document.removeEventListener('pointerdown', handleReaderPointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', closeCard);
      style.remove();
      delete window.__citecard;
    }
  };
})();
