// Injects content.js into each reader tab and gives it access to lookups and link
// opening, which need Zotero's privileges.
var CiteCard = {
  SCHOLAR_REQUEST_GAP: 2000,
  SCHOLAR_BLOCK_PAUSE: 30 * 60 * 1000,
  SIGNED_OUT_RECHECK: 60 * 1000,
  UNEXPECTED_REPLY_LIMIT: 3,
  _paneID: null,
  _source: null,
  _cache: new Map(),
  _windows: new Set(),
  _scholarAccount: undefined,
  _scholarAccountCheckedAt: 0,
  _scholarBlockedAt: 0,
  _scholarQueue: Promise.resolve(),
  _scholarLastRequest: 0,
  _unexpectedScholarReplies: 0,

  async init({ id, version, rootURI }) {
    this.log(`version ${version} starting in Zotero ${Zotero.version}`);
    // citations.js is injected ahead of content.js, which uses it
    this._source = await Zotero.File.getContentsFromURLAsync(rootURI + 'citations.js') + '\n'
      + await Zotero.File.getContentsFromURLAsync(rootURI + 'content.js');
    this._paneID = await Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + 'prefs.xhtml',
      scripts: [rootURI + 'preferences.js'],
      label: 'Citation Cards'
    });
    Zotero.CiteCard = this;
    Zotero.Reader.registerEventListener('renderToolbar', this._handleRenderToolbar, id);
    for (let reader of Zotero.Reader._readers) {
      this._attach(reader);
    }
  },

  shutdown() {
    delete Zotero.CiteCard;
    Zotero.PreferencePanes.unregister(this._paneID);
    Zotero.Reader.unregisterEventListener('renderToolbar', this._handleRenderToolbar);
    for (let win of this._windows) {
      if (!Cu.isDeadWrapper(win)) {
        win.wrappedJSObject.__citecard?.teardown();
        delete win.wrappedJSObject.__citecardHost;
      }
    }
    this._windows.clear();
  },

  _handleRenderToolbar(event) {
    CiteCard._attach(event.reader);
  },

  async _attach(reader) {
    await reader._initPromise;
    let win = reader._iframeWindow;
    if (!win || this._windows.has(win)) {
      return;
    }
    this._windows.add(win);
    win.addEventListener('unload', () => this._windows.delete(win), { once: true });
    win.wrappedJSObject.__citecardHost = Cu.cloneInto({
      lookup: text => this._toContent(win, this._lookup(text)),
      openInZotero: itemID => this._toContent(win, this._openInZotero(itemID)),
      addToZotero: paper => this._toContent(win, this._addToZotero(paper)),
      log: message => this.log(`item ${reader.itemID}: ${message}`),
      open: url => Zotero.launchURL(url),
      openScholar: search => this.openScholar(search)
    }, win, { cloneFunctions: true });
    let script = win.document.createElement('script');
    script.textContent = this._source;
    win.document.documentElement.append(script);
    script.remove();
  },

  _toContent(win, promise) {
    return new win.Promise((resolve, reject) => {
      promise.then(
        result => !Cu.isDeadWrapper(win) && resolve(Cu.cloneInto(result, win)),
        error => !Cu.isDeadWrapper(win) && reject(new win.Error(error.message))
      );
    });
  },

  // Results from OpenAlex while Scholar is signed out or paused aren't kept, so they're
  // retried with Scholar later. Whether the paper is in the library is checked each time.
  async _lookup(text) {
    let promise = this._cache.get(text);
    if (!promise) {
      promise = this._resolve(text);
      this._cache.set(text, promise);
      promise.then(
        meta => ['blocked', 'signed-out'].includes(meta?.scholarNote) && this._cache.delete(text),
        () => this._cache.delete(text)
      );
    }
    let meta = await promise;
    return meta && { ...meta, libraryItemID: await this._findInLibrary(meta) };
  },

  // A regular item, outside the trash, with the paper's DOI or the same title
  async _findInLibrary(meta) {
    let compactTitle = CiteCardLookup.compact(meta.title);
    let longestWord = meta.title.split(/[^\p{L}\p{N}]+/u).reduce((a, b) => (b.length > a.length ? b : a), '');
    for (let library of Zotero.Libraries.getAll()) {
      if (library.libraryType === 'feed') {
        continue;
      }
      let search = new Zotero.Search();
      search.libraryID = library.libraryID;
      search.addCondition('joinMode', 'any');
      search.addCondition('title', 'contains', longestWord);
      if (meta.doi) {
        search.addCondition('DOI', 'contains', meta.doi);
      }
      let items = await Zotero.Items.getAsync(await search.search());
      let match = items.find(item => item.isRegularItem() && !item.deleted
        && ((meta.doi && Zotero.Utilities.cleanDOI(item.getField('DOI') || '')?.toLowerCase() === meta.doi.toLowerCase())
          || CiteCardLookup.compact(item.getField('title')) === compactTitle));
      if (match) {
        return match.id;
      }
    }
    return null;
  },

  // Opens the item's PDF (or other attachment) in a reader tab, or selects the item in the
  // library when it has none
  async _openInZotero(itemID) {
    let pane = Zotero.getActiveZoteroPane();
    let attachment = await Zotero.Items.get(itemID).getBestAttachment();
    if (attachment) {
      await pane.viewAttachment(attachment.id);
    }
    else {
      await pane.selectItem(itemID);
    }
  },

  // Adds the paper as Zotero's "Add Item by Identifier" does, by DOI or arXiv ID, into the
  // library or collection selected in Zotero, then looks for a free PDF if none came with it.
  // Publisher pages often refuse Zotero's own page loading, so pages aren't used. Scholar
  // results carry no DOI, so one is looked up in OpenAlex, with the same title and author
  // checks as an OpenAlex card. Returns the new item's ID, or null when nothing was saved.
  async _addToZotero({ doi, arxiv, titleURL, title, reference }) {
    if (!doi && !arxiv) {
      ({ doi, arxiv } = CiteCardLookup.findIdentifiers(titleURL || ''));
    }
    if (!doi && !arxiv) {
      let work = await CiteCardLookup.search([title], reference, (url, type) => this._request(url, type));
      let found = work && CiteCardLookup.fromOpenAlex(work, reference);
      doi = found?.doi;
      arxiv = found?.arxiv;
    }
    if (!doi && !arxiv) {
      this.log(`could not add ${JSON.stringify(title)}: no DOI or arXiv ID found`);
      return null;
    }
    let pane = Zotero.getActiveZoteroPane();
    let collection = pane.getSelectedCollection();
    let translate = new Zotero.Translate.Search();
    translate.setIdentifier(doi ? { DOI: doi } : { arXiv: arxiv });
    translate.setTranslator(await translate.getTranslators());
    let [item] = await translate.translate({
      libraryID: pane.getSelectedLibraryID(),
      collections: collection ? [collection.id] : false
    });
    if (!item) {
      this.log(`could not add ${doi || 'arXiv:' + arxiv}: no translator result`);
      return null;
    }
    this.log(`added ${doi || 'arXiv:' + arxiv} as item ${item.id}`);
    if (!await item.getBestAttachment()) {
      Zotero.Attachments.addAvailableFile(item).catch(e => this.log('PDF search failed: ' + e));
    }
    return item.id;
  },

  // Writes to Zotero's debug output, which users can submit with bug reports
  log(message) {
    Zotero.debug('[Citation Cards] ' + message);
  },

  _scholarBlocked() {
    return Date.now() - this._scholarBlockedAt < this.SCHOLAR_BLOCK_PAUSE;
  },

  // True after several Scholar replies in a row that aren't in the expected format
  scholarFormatChanged() {
    return this._unexpectedScholarReplies >= this.UNEXPECTED_REPLY_LIMIT;
  },

  // Google Scholar first; OpenAlex when Scholar is signed out, blocked or has no match.
  // Every OpenAlex result carries scholarNote, saying why Scholar wasn't used: 'blocked',
  // 'signed-out' or 'unavailable' (no match or a failed request).
  async _resolve(text) {
    let started = Date.now();
    let reference = JSON.stringify(text.slice(0, 60));
    let scholarNote = 'unavailable';
    let scholarOutcome;
    if (this._scholarBlocked()) {
      scholarNote = 'blocked';
      scholarOutcome = 'paused after a CAPTCHA';
    }
    else if (!await this.scholarAccount()) {
      scholarNote = 'signed-out';
      scholarOutcome = 'signed out';
    }
    else {
      try {
        let reply = await this._scholarRequest(CiteCardLookup.scholarURL(text));
        if (CiteCardLookup.isScholarReply(reply)) {
          this._unexpectedScholarReplies = 0;
        }
        else {
          this._unexpectedScholarReplies++;
          this.log(`unexpected Scholar reply (${this._unexpectedScholarReplies} in a row), keys: ${Object.keys(reply || {}).join(',')}`);
        }
        let meta = CiteCardLookup.fromScholarReply(reply);
        if (meta) {
          this.log(`${reference}: Scholar match in ${Date.now() - started} ms`);
          return meta;
        }
        scholarOutcome = 'no Scholar match';
      }
      catch (e) {
        scholarNote = this._scholarBlocked() ? 'blocked' : 'unavailable';
        scholarOutcome = 'Scholar failed: ' + e.message;
      }
    }
    let meta = await CiteCardLookup.openAlex(text, (url, type) => this._request(url, type));
    this.log(`${reference}: ${scholarOutcome}; OpenAlex ${meta ? 'match' : 'no match'} in ${Date.now() - started} ms`);
    return meta && { ...meta, scholarNote };
  },

  // The signed-in account's email, or null when signed out. Being signed out is only
  // remembered for a minute, so a sign-in made anywhere in the plugin's cookie jar is seen.
  async scholarAccount() {
    let signedOutExpired = this._scholarAccount === null
      && Date.now() - this._scholarAccountCheckedAt > this.SIGNED_OUT_RECHECK;
    if (this._scholarAccount === undefined || signedOutExpired) {
      try {
        let reply = await this._scholarRequest(CiteCardLookup.scholarLoginURL());
        // Scholar capitalizes the email's first letter; addresses are case-insensitive
        this._scholarAccount = reply.u ? (reply.e?.toLowerCase() || 'Google account') : null;
        this._scholarAccountCheckedAt = Date.now();
      }
      catch (e) {
        return null;
      }
    }
    return this._scholarAccount;
  },

  // Opens a Zotero window that shares the plugin's Scholar cookie jar: Google sign-in, or,
  // given a search, that Scholar search, where Scholar shows its CAPTCHA to be solved.
  // Closing it rechecks the sign-in and lifts the pause after a CAPTCHA.
  openScholar(search) {
    let url = search
      ? CiteCardLookup.SCHOLAR + '/scholar?hl=en&q=' + encodeURIComponent(search)
      : 'https://accounts.google.com/ServiceLogin?hl=en&continue=' + encodeURIComponent(CiteCardLookup.SCHOLAR + '/');
    let win = Zotero.openInViewer(url, {
      userContextId: SCHOLAR_CONTEXT_ID,
      customUserAgent: this._userAgent()
    });
    win.addEventListener('unload', () => {
      this._scholarAccount = undefined;
      this._scholarBlockedAt = 0;
    }, { once: true });
    return win;
  },

  // Signing out clears the plugin's Google cookies, which affects nothing else in Zotero
  signOutOfScholar() {
    Services.cookies.removeCookiesWithOriginAttributes(JSON.stringify({ userContextId: SCHOLAR_CONTEXT_ID }));
    this._scholarAccount = null;
    this._cache.clear();
  },

  // Firefox's own user agent, which Google accepts for sign-in, unlike Zotero's
  _userAgent() {
    let platform = Zotero.isMac ? 'Macintosh; Intel Mac OS X 10.15' : Zotero.isWin ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
    let version = parseInt(Services.appinfo.platformVersion);
    return `Mozilla/5.0 (${platform}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
  },

  // Scholar requests go one at a time, a couple of seconds apart, like a person clicking.
  // A reply that isn't JSON is Scholar's CAPTCHA page, as are 403 and 429 answers.
  _scholarRequest(url) {
    let request = this._scholarQueue.then(async () => {
      let wait = this._scholarLastRequest + this.SCHOLAR_REQUEST_GAP - Date.now();
      if (wait > 0) {
        await Zotero.Promise.delay(wait);
      }
      this._scholarLastRequest = Date.now();
      let xhr;
      try {
        xhr = await Zotero.HTTP.request('GET', url, {
          responseType: 'text',
          headers: { 'User-Agent': this._userAgent() },
          userContextId: SCHOLAR_CONTEXT_ID,
          timeout: 15000
        });
      }
      catch (e) {
        if (e.status === 403 || e.status === 429) {
          this._scholarBlockedAt = Date.now();
          this.log(`Scholar answered ${e.status}; pausing Scholar for 30 minutes`);
        }
        throw new Error(e.status ? 'HTTP ' + e.status : 'network error');
      }
      let reply;
      try {
        reply = JSON.parse(xhr.response);
      }
      catch (e) {
        this._scholarBlockedAt = Date.now();
        this.log('Scholar answered with a page instead of JSON (CAPTCHA); pausing Scholar for 30 minutes');
        throw new Error('Google Scholar asked for a CAPTCHA');
      }
      if (CiteCardLookup.wantsCaptcha(reply)) {
        this._scholarBlockedAt = Date.now();
        this.log('Scholar sent only a search link, as it does when it wants a CAPTCHA; pausing Scholar for 30 minutes');
        throw new Error('Google Scholar asked for a CAPTCHA');
      }
      return reply;
    });
    this._scholarQueue = request.catch(() => {});
    return request;
  },

  // OpenAlex answers 429 once the day's budget is spent, which lookups can't recover from
  async _request(url, type) {
    let key = Zotero.Prefs.get(OPENALEX_KEY_PREF, true);
    if (key && url.startsWith('https://api.openalex.org/')) {
      url += '&api_key=' + encodeURIComponent(key);
    }
    try {
      let xhr = await Zotero.HTTP.request('GET', url, { responseType: type, timeout: 15000 });
      return xhr.response;
    }
    catch (e) {
      // The API key is left out of the log
      this.log(`request failed (${e.status ? 'HTTP ' + e.status : 'network error'}): ${url.replace(/&api_key=[^&]*/, '')}`);
      if (e.status === 429 && url.startsWith('https://api.openalex.org/')) {
        throw new Error(key
          ? 'OpenAlex daily limit reached for your API key.'
          : 'OpenAlex daily limit reached. Add a free OpenAlex API key in Zotero Settings → Citation Cards.');
      }
      return null;
    }
  }
};
