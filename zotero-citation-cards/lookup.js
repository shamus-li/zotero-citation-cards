// Resolves the text of a reference-list entry to what a card shows, from Google Scholar or
// OpenAlex. Abstracts of arXiv papers found through OpenAlex come from arXiv, since
// OpenAlex often lacks or garbles them.
// `request(url, type)` resolves to parsed JSON (type 'json') or text (type 'text'), or null
// when the request fails; it throws to stop a lookup, as when OpenAlex's daily limit is spent.
var CiteCardLookup = {
  OPENALEX_FIELDS: 'id,doi,title,publication_year,cited_by_count,authorships,primary_location,best_oa_location,abstract_inverted_index',
  SCHOLAR: 'https://scholar.google.com',
  MAX_AUTHORS: 4,
  MAX_VENUE_LENGTH: 40,
  REFERENCE_NUMBER: /^\s*(\[\d+\]|\d+\.)\s*/,

  // The request the Google Scholar PDF Reader makes when a reference is clicked. Scholar
  // marks the reply with l: "1" when it has matched the reference to one paper, which it
  // only does for signed-in requests.
  scholarURL(text) {
    let query = text.replace(this.REFERENCE_NUMBER, '').replace(/([a-z])- ([a-z])/g, '$1$2').replace(/\s+/g, ' ').trim();
    return this.SCHOLAR + '/scholar?oi=gsr-r&q=' + encodeURIComponent(query) + '&output=gsb&hl=en&rfa=1';
  },

  // Signed-in replies to this request carry the account's user ID (u) and email (e)
  scholarLoginURL() {
    return this.SCHOLAR + '/scholar?oi=gsr&q=&output=gsb&gsr_login&gsr_hv=5&hl=en';
  },

  // A reply to a reference search always has a result list (r), empty when nothing matched,
  // and a matched result has a title. Anything else means Scholar has changed its format.
  isScholarReply(reply) {
    return Array.isArray(reply?.r) && (reply.l !== '1' || !!reply.r[0]?.t);
  },

  // When Scholar wants a CAPTCHA solved, a reference search gets only a link to a normal
  // search (L) and no results, even for a matched paper; a real miss has no L
  wantsCaptcha(reply) {
    return !!reply?.L && !reply.r?.length;
  },

  fromScholarReply(reply) {
    let result = reply?.l === '1' && reply.r?.[0];
    return result?.u ? this.fromScholar(result) : null;
  },

  // Result links go through Scholar's click-tracking redirect; the target is its url parameter
  unwrapScholarURL(url) {
    let absolute = new URL(url, this.SCHOLAR);
    return absolute.pathname === '/scholar_url' ? absolute.searchParams.get('url') : absolute.href;
  },

  fromScholar(result) {
    let links = ['c', 'r', 'v'].map(key => result.l?.[key])
      .filter(link => link?.u)
      .map(link => ({ label: link.l, url: this.SCHOLAR + link.u }));
    return {
      title: this.cleanTitle(result.t),
      titleURL: this.unwrapScholarURL(result.u),
      metaLine: this.cleanTitle(result.m),
      abstract: this.cleanAbstract(this.cleanTitle(result.s)),
      links
    };
  },

  async openAlex(text, request) {
    text = this.cleanReference(text);
    let { doi, arxiv } = this.findIdentifiers(text);
    let work = null;
    let lookupDOI = doi || (arxiv && '10.48550/arXiv.' + arxiv);
    if (lookupDOI) {
      work = await request('https://api.openalex.org/works/doi:' + encodeURIComponent(lookupDOI)
        + '?select=' + this.OPENALEX_FIELDS, 'json');
    }
    if (!work) {
      work = await this.search(this.guessTitles(text), text, request);
    }
    if (!work) {
      return null;
    }
    let meta = this.fromOpenAlex(work, text);
    meta.arxiv = meta.arxiv || arxiv;
    if (meta.arxiv) {
      meta.abstract = await this.arxivAbstract(meta.arxiv, request) || meta.abstract;
    }
    return meta;
  },

  cleanReference(text) {
    return text
      .replace(this.REFERENCE_NUMBER, '')
      .replace(/([a-z])- ([a-z])/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
  },

  findIdentifiers(text) {
    let doi = text.match(/\b10\.\d{4,9}\/\S+/)?.[0].replace(/[.,;)\]]+$/, '') || null;
    let arxiv = text.match(/(?:arXiv[:\s]*|arxiv\.org\/(?:abs|pdf)\/|abs\/)(\d{4}\.\d{4,5})/i)?.[1] || null;
    return { doi, arxiv };
  },

  // Letters and digits only, so line-break hyphens, spacing lost in PDF text, ligatures and
  // accents don't affect comparisons
  compact(text) {
    return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  },

  // A found title is the cited paper only if it appears whole in the reference text
  titleMatches(title, text) {
    let compactTitle = this.compact(title || '');
    return compactTitle.length >= 8 && this.compact(text).includes(compactTitle);
  },

  // A different paper can share a title, so one of the found paper's authors must be named
  // in the reference. Names that don't reduce to Latin letters can't be compared.
  authorsMatch(work, text) {
    let surnames = (work.authorships || [])
      .map(authorship => this.compact((authorship.author?.display_name || '').trim().split(/\s+/).pop()))
      .filter(surname => surname.length >= 2);
    let compactText = this.compact(text);
    return !surnames.length || surnames.some(surname => compactText.includes(surname));
  },

  // Pieces of the reference that could be its title: a quoted title, as in Econometrica's
  // style, then sentence-like pieces. In "Authors: Title" styles the author list before the
  // colon is dropped. Remaining pieces of author lists are skipped because they contain
  // several commas or end in an initial.
  guessTitles(text) {
    let quoted = text.match(/[“"]([^”"]{8,}?)[,.]?[”"]/)?.[1];
    return [quoted, ...text
      .split(/[.?!]\s+/)
      .map(part => part.match(/^[^:]*,[^:]*:\s+(.+)$/)?.[1] || part)
      .filter(part => part.split(' ').length >= 3
        && (part.match(/,/g) || []).length < 2
        && !/\b[A-Z]$/.test(part)
        && !/^In\s|^In:|preprint|arXiv|\bpp\b/i.test(part))]
      .filter(Boolean)
      .slice(0, 2);
  },

  // OpenAlex search needs every word to match. A hyphen may be real ("Score-based") or left
  // from a word split across lines ("denois-ing"), so a title with hyphens is also tried
  // with them joined. When PDF text has fused two words ("withconvolutional") nothing comes
  // back, so the last try leaves out the longest word.
  // OpenAlex keeps duplicate records of popular papers, so among matches prefer ones with
  // an abstract, then the most cited. No match leaves the card showing the reference text.
  async search(titles, text, request) {
    let queries = [];
    for (let title of titles) {
      queries.push(title);
      let joined = title.replace(/(\p{Ll})-(\p{Ll})/gu, '$1$2');
      if (joined !== title) {
        queries.push(joined);
      }
      let words = title.split(' ');
      if (words.length >= 4) {
        let longest = words.reduce((a, b) => (b.length > a.length ? b : a));
        queries.push(words.filter(word => word !== longest).join(' '));
      }
    }
    for (let query of queries) {
      // OpenAlex rejects ? and * as wildcards, which titles such as "…compete with BM3D?" contain
      query = query.replace(/[?*]/g, ' ').trim();
      let json = await request('https://api.openalex.org/works?per-page=10&search=' + encodeURIComponent(query)
        + '&select=' + this.OPENALEX_FIELDS, 'json');
      let works = (json?.results || []).filter(work => this.titleMatches(this.cleanTitle(work.title), text)
        && this.authorsMatch(work, text));
      works.sort((a, b) => (!!b.abstract_inverted_index - !!a.abstract_inverted_index)
        || (b.cited_by_count - a.cited_by_count));
      if (works.length) {
        return works[0];
      }
    }
    return null;
  },

  async arxivAbstract(id, request) {
    let xml = await request('https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(id), 'text');
    let summary = xml?.match(/<entry>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1];
    return summary ? this.cleanAbstract(this.decodeEntities(summary)) : null;
  },

  decodeEntities(text) {
    return text
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(code))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
  },

  // "Ashish Vaswani" -> "A Vaswani", as Google Scholar lists authors
  shortAuthor(name) {
    let parts = name.trim().split(/\s+/);
    let last = parts.pop();
    return [parts.map(part => part[0]).join(''), last].filter(Boolean).join(' ');
  },

  // "A Vaswani, N Shazeer, … - Venue…, 2017", in Google Scholar's style
  metaLine(authors, venue, year) {
    let names = authors.slice(0, this.MAX_AUTHORS).map(name => this.shortAuthor(name)).join(', ');
    if (authors.length > this.MAX_AUTHORS) {
      names += '…';
    }
    if (venue && venue.length > this.MAX_VENUE_LENGTH) {
      venue = venue.slice(0, this.MAX_VENUE_LENGTH).trimEnd() + '…';
    }
    return [names, [venue, year].filter(Boolean).join(', ')].filter(Boolean).join(' - ');
  },

  cleanTitle(title) {
    return this.decodeEntities((title || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  },

  // Math symbols and Greek letters written out in formulas
  TEX_SYMBOLS: {
    le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼', equiv: '≡', cdot: '·', times: '×',
    pm: '±', mp: '∓', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', infty: '∞', to: '→',
    rightarrow: '→', leftarrow: '←', mapsto: '↦', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', ldots: '…',
    cdots: '⋯', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
    phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π',
    Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
  },

  // Publishers such as Springer set each formula in an abstract as a small LaTeX document,
  // "\documentclass[12pt]{minimal} \usepackage{amsmath} … \begin{document}$\hat{coreg}(X) := \dim X$\end{document}",
  // which is shown as its formula in plain text, "coreg(X) := dim X". An abstract cut off
  // inside one ends there.
  cleanAbstract(text) {
    if (!text) {
      return null;
    }
    let formula = math => {
      math = math.replace(/\$/g, '').replace(/\\(begin|end)\s*\{[^{}]*\}|\\left|\\right/g, ' ')
        .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2');
      // A command's argument, as in "\hat{reg}" or "\mathrm{coreg}", stands for it
      let unwrapped;
      while ((unwrapped = math.replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1')) !== math) {
        math = unwrapped;
      }
      return math.replace(/\\([a-zA-Z]+)/g, (_, name) => this.TEX_SYMBOLS[name] ?? name)
        .replace(/\\\\|[{}&]/g, ' ').replace(/\s+/g, ' ').trim();
    };
    let cleaned = text.replace(/\\documentclass[\s\S]*?\\begin\s*\{document\}([\s\S]*?)\\end\s*\{document\}/g, (_, math) => ` ${formula(math)} `);
    let cut = cleaned.search(/\\documentclass/);
    if (cut >= 0) {
      cleaned = cleaned.slice(0, cut).trim() + '…';
    }
    return cleaned.replace(/\s+/g, ' ').trim() || null;
  },

  abstractFromIndex(index) {
    if (!index) {
      return null;
    }
    let words = [];
    for (let [word, positions] of Object.entries(index)) {
      for (let position of positions) {
        words[position] = word;
      }
    }
    return words.join(' ');
  },

  // Duplicate records sometimes carry the date of a later reprint, so when every year the
  // reference mentions is clearly earlier, show the reference's year
  displayYear(year, text) {
    let years = (text.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
    if (year && years.length && years.every(y => y < year - 1)) {
      return Math.max(...years);
    }
    return year || (years.length ? Math.max(...years) : null);
  },

  fromOpenAlex(work, text) {
    let doi = work.doi?.replace(/^https:\/\/doi\.org\//, '') || null;
    let landingPages = [work.primary_location?.landing_page_url, work.best_oa_location?.landing_page_url, doi && 'doi:' + doi];
    let arxiv = landingPages.map(url => url?.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})|10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i))
      .find(Boolean)?.slice(1).find(Boolean) || null;
    let title = this.cleanTitle(work.title);
    let links = [];
    if (work.cited_by_count) {
      links.push({ label: 'Cited by ' + work.cited_by_count.toLocaleString(), url: 'https://openalex.org/works?filter=cites:' + work.id.split('/').pop() });
    }
    links.push({ label: 'Google Scholar', url: this.SCHOLAR + '/scholar?q=' + encodeURIComponent(title) });
    doi = /^10\.48550\//i.test(doi || '') ? null : doi;
    return {
      title,
      titleURL: doi ? 'https://doi.org/' + doi : arxiv ? 'https://arxiv.org/abs/' + arxiv : work.id,
      metaLine: this.metaLine((work.authorships || []).map(authorship => authorship.author.display_name),
        work.primary_location?.source?.display_name, this.displayYear(work.publication_year, text)),
      abstract: this.cleanAbstract(this.abstractFromIndex(work.abstract_inverted_index)),
      links,
      doi,
      arxiv
    };
  }
};
