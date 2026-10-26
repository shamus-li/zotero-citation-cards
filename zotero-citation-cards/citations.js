// Decides which of the citations Zotero detects in a PDF are genuine, and which references
// they cite. Zotero sometimes reads an affiliation list, algorithm steps or a table as the
// reference list, and equation numbers as citations; those must not open cards.
var CiteCardCitations = {
  YEAR: /(?<!\d)(1[89]\d\d|20\d\d)[a-z]?(?![\da-z])/g,
  // How much text on each side of a clicked author-year citation is read
  CONTEXT: 45,
  // A lone author's name ending in a period: "Jacques Hadamard.", "Brian DO Anderson.",
  // "Pieter Hendrik van Cittert."
  SINGLE_AUTHOR: /^(\p{Lu}[\p{L}'’-]*\.?\s+|(van|von|de|der|den|di|da|del|du|le|la)\s+){1,4}\p{Lu}[\p{L}'’-]+\./u,

  compact(text) {
    return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  },

  // A bibliography entry has a year and starts with author names, not with a figure, table,
  // theorem or section heading, which can also mention a year and "et al."
  looksLikeReference(text) {
    let body = text.replace(/^\s*(\[\d+\]|\(\d+\)|\d+\.?)\s*/, '');
    if (/^(Figure|Fig\.|Table|Algorithm|Proposition|Theorem|Lemma|Corollary|Definition|Remark|Section|Appendix|Equation|Eq\.)\s/i.test(body)) {
      return false;
    }
    // An organization and the year, as ACM sets them: "Draco. 2019.", "Blender Online Community. 2018."
    if (/^\p{Lu}[\p{L}\d'’&-]*(\s+\p{Lu}[\p{L}\d'’&-]*){0,3}\.\s+(1[89]|20)\d\d[a-z]?\./u.test(body)) {
      return true;
    }
    // A sentence isn't one: "After solving Eq. (3) …", "We conduct experiments …"
    if (/^\p{Lu}\p{Ll}+\s+(?!(?:and|et|van|von|de|der|den|di|da|del|du|le|la)\b)\p{Ll}/u.test(body)) {
      return false;
    }
    let head = body.slice(0, 80);
    let names = (head.match(/\b[A-Z][a-zà-ÿ'’-]+/g) || []).length + (head.match(/\b[A-Z]\./g) || []).length;
    return new RegExp(this.YEAR.source).test(text) && body.length >= 20
      && (/,| and |&|et al/.test(head) || this.SINGLE_AUTHOR.test(head)) && names >= 2;
  },

  // What the paper's reference list looks like, from the reference texts Zotero found:
  // whether it's real, whether references are numbered, and how numbers are labeled
  describePaper(referenceTexts, numberedCount) {
    let texts = [...new Set(referenceTexts.map(text => text.trim()))];
    let real = texts.filter(text => this.looksLikeReference(text)).length;
    let labels = { bracket: 0, parenthesis: 0 };
    for (let text of texts) {
      if (/^\s*\[/.test(text)) {
        labels.bracket++;
      }
      else if (/^\s*\(/.test(text)) {
        labels.parenthesis++;
      }
    }
    return {
      real: texts.length >= 3 && real / texts.length >= 0.6,
      numbered: numberedCount > texts.length / 2,
      bracketLabels: labels.bracket > texts.length / 2,
      parenthesisLabels: labels.parenthesis > texts.length / 2
    };
  },

  // Numbered citations: [10] always counts. A plain number is a superscript citation unless
  // references are labeled [1], when it's more likely a number in the text. A number in
  // parentheses is usually an equation, unless references are labeled (1).
  isNumberedCitation(word, paper) {
    if (/[[\]]/.test(word)) {
      return true;
    }
    if (word.trim().startsWith('(')) {
      return paper.parenthesisLabels;
    }
    return !paper.bracketLabels;
  },

  // The first author's name as written: up to the first comma, colon, "and", the year, or a
  // period after a word ("Pascal Vincent. A connection…", "OpenAI. GPT-Image…"), not after an
  // initial ("Diederik P. Kingma"), without "et al." or a leading "The"
  firstAuthor(text) {
    return text.replace(/^\s*(\[[^\]]{1,12}\]|\(\d+\)|\d+\.?)\s*/, '')
      .split(/,|:|\sand\s|&|(?<=\p{L}{2})\.\s|\.\s+(?=\(?(?:1[89]|20)\d\d)|\s+\(?(?=(?:1[89]|20)\d\d)/u)[0]
      .replace(/\s+et\s*al\.?$/, '').replace(/^the\s+/i, '').trim();
  },

  // The first author's surname, compacted: "Jakob Engel, …" → "engel", "Burger, H.C., …" →
  // "burger", "A. Vaswani, …" → "vaswani", "Noah Snavely. 2010. …" → "snavely", with
  // initials without periods, as in biomedicine, "Bartel DP. 2004. …" → "bartel", without a
  // suffix, "Swenson Jr, G. W." → "swenson", and with an accent the PDF text split off,
  // "Michal Janc ̌ osek" → "jancosek"
  firstAuthorSurname(text) {
    // A split-off accent joins the letters before it and a lowercase rest after it
    let accented = this.firstAuthor(text).replace(/\s+(?=[\u0300-\u036f\u00a8\u00b4\u00b8\u02c6-\u02dd`~])/gu, '')
      .replace(/([\u0300-\u036f\u00a8\u00b4\u00b8\u02c6-\u02dd`~])\s+(?=\p{Ll})/gu, '$1');
    let words = accented.split(/\s+/);
    let names = words.filter(word => !/^((\p{Lu}\.)+|\p{Lu}{1,3}|\p{Lu}\.-\p{Lu}\.|Jr\.?|Sr\.?|II|III|IV)$/u.test(word));
    return this.compact((names.length ? names : words).at(-1) || '');
  },

  // Words ending the name of a group or organization that authors works
  GROUP_WORDS: 'Collaboration|Consortium|Team|Group|Groups|Survey|Project|Collaborators|Office|Organization|Organisation|Institute|Association|Agency|Committee|Council|Society|Foundation|Commission|Bureau|Department|Board|Network|Initiative|Panel|Programme|Program|Center|Centre|Administration|Union|Labs|Laboratory|Laboratories|Authority|Service|Services|Ministry|Forum|Alliance|Federation|Working Group',

  // Whether a group author in a citation is an entry's first author: the same words, or an
  // abbreviation of them, as "EHT Collaboration" of "Event Horizon Telescope Collaboration"
  // or "WHO" of "World Health Organization"
  groupMatches(cited, author) {
    let clean = text => text.replace(/^the\s+/i, '').replace(/,?\s+(Ltd|Inc|LLC|GmbH|AG|SA)\.?$/i, '').trim();
    cited = clean(cited);
    author = clean(author);
    if (this.compact(cited) === this.compact(author)) {
      return true;
    }
    let initials = (text, expand) => text.split(/[\s-]+/).filter(word => !/^(of|for|and|the|de|du|des|la|le|on|in|&)$/i.test(word))
      .map(word => (expand && /^[\p{Lu}\d.&]{2,}$/u.test(word) ? word.replace(/[.&]/g, '') : word[0] || '')).join('').toUpperCase();
    let citedWords = cited.split(/\s+/);
    let authorWords = author.split(/\s+/);
    let groupWord = word => new RegExp('^(' + this.GROUP_WORDS + ')$', 'i').test(word);
    // "EHT Collaboration" and "Event Horizon Telescope Collaboration" share their last word
    if (citedWords.length > 1 && groupWord(citedWords.at(-1))) {
      return this.compact(citedWords.at(-1)) === this.compact(authorWords.at(-1))
        && initials(citedWords.slice(0, -1).join(' '), true) === initials(authorWords.slice(0, -1).join(' '), false)
        && initials(citedWords.slice(0, -1).join(' '), true).length >= 2;
    }
    // "WHO" for "World Health Organization"
    return citedWords.length === 1 && /^[\p{Lu}\d]{2,}$/u.test(cited) && initials(author, false) === cited && authorWords.length >= 2;
  },

  // Author-year citations: Zotero links each name and year separately, sometimes to the
  // wrong paper. Of the references it linked, keep the one containing the year nearest the
  // click and the most author names from the same citation (text up to the nearest ";").
  // Ties go to multi-author papers after "et al." and single-author papers otherwise.
  // Returns [] when no linked reference fits, so no card opens.
  resolveAuthorYear(left, right, references) {
    // PDF text often loses the space before "et al." and "and": "Strechaet al.", "Zhouand Koltun"
    let fixEtAl = text => text.replace(/(\w)et\.?\s*al/g, '$1 et al').replace(/(\p{Ll})and(\s+(?=\p{Lu})|\s*$)/gu, '$1 and ');
    left = fixEtAl(left.split(';').pop());
    right = fixEtAl(right.split(';')[0]);
    let text = left + right;
    let years = [...text.matchAll(this.YEAR)]
      .map(match => ({ year: match[0], distance: Math.abs(match.index - left.length) }))
      .sort((a, b) => a.distance - b.distance);
    let names = (text.match(/[A-ZÀ-Ý][\p{L}'’-]+/gu) || []).map(name => this.compact(name)).filter(name => name.length > 1);
    let etAl = /et al/.test(text);
    for (let { year } of years) {
      let pattern = new RegExp('(?<!\\d)' + year + '(?![\\da-z])');
      let candidates = references.filter(reference => pattern.test(reference.text));
      if (!candidates.length) {
        continue;
      }
      // A citation names the first author, so a reference whose first author isn't in the
      // text is another paper, as when a paper's own author list sits next to a year
      candidates = candidates.filter(reference => names.includes(this.firstAuthorSurname(reference.text)));
      if (!candidates.length) {
        return [];
      }
      let score = reference => names.filter(name => this.compact(reference.text.slice(0, 150)).includes(name)).length;
      let top = Math.max(...candidates.map(score));
      if (top === 0) {
        return [];
      }
      let best = candidates.filter(reference => score(reference) === top);
      if (best.length > 1) {
        let authors = reference => {
          let head = reference.text.slice(0, reference.text.search(pattern));
          return (head.match(/,/g) || []).length + (head.match(/\sand\s|&/g) || []).length;
        };
        let target = etAl ? Math.max(...best.map(authors)) : Math.min(...best.map(authors));
        best = best.filter(reference => authors(reference) === target);
      }
      return best;
    }
    return [];
  },

  // Zotero marks each name and year of an author-year citation separately. A word and the
  // next belong to one citation when the text between them is only "et al.", "and", "&" or
  // punctuation that doesn't end a citation: "Agarwal et al. 2011", "Hartley and Zisserman
  // 2000", "Strechaet al. [2008]", but not "2011; Shan" or "2000], advanced". A citation
  // ends with its year, so "Hall et al., 1999, and Abadie, 2002" is two.
  joinsCitation(word, gap) {
    return !/\d[a-z]?$/.test(word) && gap.length <= 12 && /^[\s,.&([]*((et\s*al|and)[\s,.&([]*)*$/.test(gap);
  },

  // The heading of a paper's reference list: "References", "7. REFERENCES", "Bibliography",
  // "■ REFERENCES", "References.", "Notes and references", "Appendix References". It starts with a capital, so the
  // end of a sentence wrapped onto its own line ("references.") isn't one, and its section
  // number has at most two digits, so a running header such as "112 References" isn't one.
  isBibliographyHeading(line) {
    let match = line.match(/^[\s\p{S}\p{P}]*(\d{1,2}\.?|[IVX]+\.)?\s*((appendix|supplementary)( material)?\s+)?((notes and )?references( and notes)?|bibliography|literature cited|works cited|references cited)\s*[:.]?\s*$/iu);
    return !!match && /\p{Lu}/u.test((match[2] || match[5])[0]);
  },

  // The label an entry of a labeled reference list starts with: "[12]", "12." or "[AFO17]".
  // Returns { style: 'bracket' | 'dot' | 'alpha', label } or null.
  entryLabel(line) {
    let match = line.match(/^\s*\[(\d{1,3})\]\s*(?=\S)/);
    if (match) {
      return { style: 'bracket', label: match[1] };
    }
    match = line.match(/^\s*(\d{1,3})\.\s+(?=\p{M}?\p{Lu}|\()/u);
    if (match) {
      return { style: 'dot', label: match[1] };
    }
    match = line.match(/^\s*\[(\p{Lu}[\p{L}+]{0,7}\d{2}[a-z]?)\]\s*(?=\S)/u);
    return match ? { style: 'alpha', label: match[1] } : null;
  },

  // The numbers in a citation such as "23,26", "1–3" or "4, 7-9"
  citationNumbers(text) {
    let numbers = [];
    for (let part of text.split(/,\s*/)) {
      let range = part.match(/^(\d{1,3})\s*[–—-]\s*(\d{1,3})$/);
      if (range && Number(range[2]) > Number(range[1]) && Number(range[2]) - Number(range[1]) < 50) {
        for (let n = Number(range[1]); n <= Number(range[2]); n++) {
          numbers.push(String(n));
        }
      }
      else if (/^\d{1,3}$/.test(part.trim())) {
        numbers.push(part.trim());
      }
      else if (part.trim()) {
        return [];
      }
    }
    return numbers;
  },

  // What a footnote does: { kind: 'cites' } when it cites a work, having a year and something
  // only references have, such as quotation marks around a title, a year in parentheses
  // ("(Addison-Wesley 2012)"), page numbers, a publisher or a case number; { kind: 'refers',
  // number } when it points to an earlier note ("Harden (n 11)", "supra note 11", "See n 88
  // above"); { kind: 'earlier' } when it points back to the last citation ("Ibid.", "Id.");
  // otherwise { kind: 'note' }, a footnote that comments.
  footnoteKind(text) {
    let year = /\b(1[5-9]|20)\d\d\b/.test(text);
    if (year && /[“"‘«]|[([](?:[^()[\]]*\s)?(1[5-9]|20)\d\d[)\]]|\bpp?\.\s*\d|\d+\s*[–-]\s*\d+|\b(vol|ed|eds|trans|no|para|art)\.?\s|Press\b|Journal|Review|Proceedings|University|Verlag|Editions?\b|\bin:|https?:|\bCase\s+[A-Z]?-?\d|ECLI|\bv\.?\s+\p{Lu}/iu.test(text)) {
      return { kind: 'cites' };
    }
    let note = text.match(/\(n\.?\s*(\d{1,3})\)|\bsupra(?: note| n\.?)?\s*(\d{1,3})|\bnn?\.?\s+(\d{1,3})\b/i);
    if (note) {
      return { kind: 'refers', number: note.slice(1).find(Boolean) };
    }
    if (/^\s*(ibid|id\b|idem|op\.? cit|loc\.? cit)/i.test(text) || /\b(ibid|op\.? cit)\b|,\s*id[.,]/i.test(text)) {
      return { kind: 'earlier' };
    }
    return { kind: 'note' };
  },

  // Bracketed citations of a labeled reference list in a page's text: "[12]", "[1, 3–5]",
  // "[6]–[9]", "[AFO17]", "[BM14a, Kol99]", "[Kol99, Theorem 2.1]", and "ref. 16". A bracket
  // counts only when every number or label in it is an entry's, given as a Set of label
  // strings. An interval after a math symbol, as in "x ∈ [1, 2]", isn't one. Each number,
  // label or range in a bracket is its own citation, so each opens its own card. Returns
  // { start, end, labels, group }, group being where the bracket starts.
  findLabeledCitations(text, labels) {
    let citations = [];
    // The parts of a citation's list, "1, 3–5" or "BM14a, Kol99, Theorem 2", from an index in
    // the text; null when a part isn't an entry's
    let partsOf = (list, offset) => {
      let parts = [];
      for (let piece of list.matchAll(/[^,;]+/g)) {
        let part = piece[0].trim();
        let start = offset + piece.index + piece[0].search(/\S/);
        let numbers = /^\d/.test(part) ? this.citationNumbers(part) : [];
        if (numbers.length || labels.has(part)) {
          parts.push({ start, end: start + part.length, labels: numbers.length ? numbers : [part] });
        }
        // A locator after the first label, as in "[Kol99, Theorem 2.1]" or "[12, p. 4]"
        else if (parts.length && /^(p|pp|ch|sec|thm|theorem|lemma|prop|proposition|corollary|section|chapter|eq|definition|remark|example|§)\b/i.test(part)) {
          parts.at(-1).end = start + part.length;
        }
        else {
          return null;
        }
      }
      return parts.length && parts.every(part => part.labels.every(label => labels.has(label))) ? parts : null;
    };
    let add = (parts, start, end) => {
      parts[0].start = start;
      parts.at(-1).end = Math.max(parts.at(-1).end, end);
      citations.push(...parts.map(part => ({ ...part, group: start })));
    };
    for (let match of text.matchAll(/\[([^\[\]]{1,80})\]/g)) {
      if (/[∈∉=≠≈≤≥<>×·+−\-*/^_|∪∩⊂⊆]$/.test(text.slice(0, match.index).trimEnd())) {
        continue;
      }
      let parts = partsOf(match[1], match.index + 1);
      if (parts) {
        add(parts, match.index, match.index + match[0].length);
      }
    }
    // Numbers cited in words: "see ref. 16", "refs. 3–5"
    for (let match of text.matchAll(/\b[Rr]efs?\.\s*(\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*)/g)) {
      let parts = partsOf(match[1], match.index + match[0].length - match[1].length);
      if (parts) {
        add(parts, match.index, match.index + match[0].length);
      }
    }
    // A range of bracketed numbers, "[6]–[9]", is one citation of all of them
    citations.sort((a, b) => a.start - b.start);
    for (let i = citations.length - 2; i >= 0; i--) {
      let [first, last] = [citations[i], citations[i + 1]];
      let from = Number(first.labels.at(-1));
      let to = Number(last.labels[0]);
      if (/^\s*[–—-]\s*$/.test(text.slice(first.end, last.start)) && to > from && to - from < 50
        && Array.from({ length: to - from - 1 }, (_, k) => String(from + k + 1)).every(label => labels.has(label))) {
        citations.splice(i, 2, {
          start: first.start,
          end: last.end,
          group: first.group,
          labels: [...first.labels, ...Array.from({ length: to - from - 1 }, (_, k) => String(from + k + 1)), ...last.labels]
        });
      }
    }
    return citations;
  },

  // Author-year citations Zotero didn't find, in a page's text: "(He, 1997)", "(Hall et al.,
  // 1999, and Abadie, 2002)", "Koenker (1994)", "Chernozhukov and Hansen (2006)". Returns
  // each name-and-year as { start, end, names, year, etAl, fallback }, end after the year (and
  // its closing parenthesis in "Koenker (1994)"); a fallback counts only where the citation
  // before it at that place names no entry. A parenthetical one must sit inside parentheses or
  // brackets.
  findAuthorYearCitations(text) {
    // Each name starts a word ("model Choi" isn't "del Choi") and matches one way, and at most
    // three names come before "and", so a long list of names, such as a collaboration's 200
    // authors, can't make the search take forever. A name may hold digits ("Hunyuan3D") and
    // accents set apart from their letters ("Mościbrodzka", "Peyr ́e"), be broken across lines
    // at a hyphen ("Gneit- ing"), and end in a suffix ("Swenson Jr").
    let accent = String.raw`[\u0300-\u036f\u00b4\u00a8\u02c6-\u02dd]`;
    let name = String.raw`(?<![\p{L}\p{M}\d'’-])(?:(?:van|von|de|der|den|di|da|del|du|le|la|Van|Von|De|Der|Den|Di|Da|Del|Du|Le|La|El|Al)\s+){0,3}\p{Lu}(?=[\p{L}\p{M}\d'’-]*\p{Ll})[\p{L}\p{M}\d'’-]+(?:\s?${accent}[\p{L}\p{M}'’-]*)*(?:(?<=-)\s\p{L}[\p{L}\p{M}'’-]*)?(?:,?\s+(?:Jr|Sr|II|III|IV)\.?(?![\p{L}]))?`;
    let authors = String.raw`(${name}(?:(?:,\s*${name}){0,3},?\s+(?:and|&)\s+${name}|\s+et\s*al\.?)?)`;
    // A group as author: "EHT Collaboration", "R Development Core Team", "Black Forest Labs",
    // "Optical Society of America", or an abbreviation alone, "(WHO, 2020)"
    let group = String.raw`((?<![\p{L}\d])(?:The\s+)?(?:(?:\p{Lu}[\p{L}\d&.'’-]*|of|for|and|on)\s+){0,6}(?:${this.GROUP_WORDS})(?:\s+(?:of|for)(?:\s+\p{Lu}[\p{L}.'’-]*){1,3})?(?:\s+(?:Ltd|Inc|LLC)\.?)?|(?<![\p{L}\d])\p{Lu}[\p{Lu}\d]{1,7}(?![\p{L}\d]))`;
    let year = String.raw`((?:1[89]|20)\d\d[a-z]?)(?![\d])`;
    let citations = [];
    // An unclosed bracket before it, however long the list of citations inside is
    let inParentheses = index => text.slice(Math.max(0, index - 1000), index).search(/[([][^()[\]]*$/) >= 0;
    let add = (match, narrative, isGroup) => {
      let end = match.index + match[0].length;
      if (narrative && /[)\]]/.test(text[end])) {
        end++;
      }
      let cited = match[1].replace(/\s+et\s*al\.?$/, '');
      let names = isGroup ? [cited] : cited.split(/,\s*(?!(?:Jr|Sr|II|III|IV)\b)|\s+(?:and|&)\s+/)
        .map(name => name.replace(/,?\s+(?:Jr|Sr|II|III|IV)\.?$/, '').replace(/[’']s$/, '').replace(/-\s+/g, '-')
          .replace(/\s+(?=[\u0300-\u036f\u00b4\u00a8\u02c6-\u02dd])/gu, ''));
      let found = { start: match.index, end, names, year: match[2], etAl: /et\s*al/.test(match[1]), group: isGroup ? cited : null };
      push(found, match.index + match[0].length);
      // The first of three or more names may be a word opening the sentence, as in "Recently,
      // Wang and Menon [2015]", so the citation without it is tried when it names no entry
      if (names.length >= 3) {
        let second = match.index + cited.indexOf(',') + 1;
        second += text.slice(second).search(/\S/);
        push({ ...found, start: second, names: names.slice(1), fallback: true }, match.index + match[0].length);
      }
    };
    // A citation, then further years or year letters of the same authors, each a citation of its
    // own: "Heiger et al. 2024, 2026", "Ji et al. 2016a,b,c", "Smith (2001, 2003)". After a
    // semicolon only a year or letter counts, and only before another separator or the end:
    // "(Kingma & Welling, 2013; 2019)", "(Akiyama et al., 2017b;a; 2019)"
    let push = (citation, offset) => {
      citations.push(citation);
      let base = citation.year;
      let pattern = /^(?:(\s*,\s*)((?:1[89]|20)\d\d[a-z]?|[a-z])(?![\p{L}\d.])|(\s*;\s*)((?:1[89]|20)\d\d[a-z]?|[a-z])(?=\s*[;,)\]]))/u;
      let more;
      while ((more = text.slice(offset).match(pattern))) {
        let separator = more[1] ?? more[3];
        let item = more[2] ?? more[4];
        if (!/^\d/.test(item) && !/[a-z]$/.test(base)) {
          break;
        }
        let start = offset + separator.length;
        citations.push({ ...citation, start, end: start + item.length, year: /^\d/.test(item) ? item : base.slice(0, 4) + item });
        if (/^\d/.test(item)) {
          base = item;
        }
        offset += more[0].length;
      }
    };
    for (let match of text.matchAll(new RegExp(group + String.raw`(?:\s+et\s*al\.?)?(?:’s|'s)?\s*[(\[]` + year, 'gu'))) {
      add(match, true, true);
    }
    for (let match of text.matchAll(new RegExp(group + String.raw`(?:\s+et\s*al\.?)?,?\s+` + year, 'gu'))) {
      if (inParentheses(match.index)) {
        add(match, false, true);
      }
    }
    for (let match of text.matchAll(new RegExp(authors + String.raw`(?:’s|'s)?\s*[(\[]` + year, 'gu'))) {
      add(match, true, false);
    }
    for (let match of text.matchAll(new RegExp(authors + String.raw`,?\s+` + year, 'gu'))) {
      if (inParentheses(match.index)) {
        add(match, false, false);
      }
    }
    // Where a group's citation and a person's overlap, the longer one stands, and each place
    // is found once. Fallbacks stay, after the citations they stand in for.
    citations.sort((a, b) => a.start - b.start || b.end - a.end || !!a.fallback - !!b.fallback);
    return citations.filter((citation, i) => citation.fallback || !citations.some((other, j) => j !== i && !other.fallback
      && other.start <= citation.start && other.end >= citation.end && (other.end - other.start > citation.end - citation.start || j < i)));
  },

  // The reference entries a found citation names: the first author's surname must start the
  // entry and its year must be in it, as must a second author named with "and". Ties go to
  // multi-author entries after "et al." and to the fewest authors otherwise.
  matchAuthorYear(citation, entries) {
    let letter = citation.year.match(/[a-z]$/)?.[0];
    let yearPattern = year => new RegExp('(?<!\\d)' + year + (/[a-z]$/.test(year) ? '(?![\\da-z])' : '(?!\\d)'));
    let [first, second] = citation.names.map(name => this.compact(name.split(/\s+/).pop()));
    let byAuthor = entries.filter(entry => (citation.group ? this.groupMatches(citation.group, this.firstAuthor(entry)) : this.firstAuthorSurname(entry) === first));
    let pick = pattern => byAuthor.filter(entry => pattern.test(entry)
      && (!second || citation.group || this.compact(entry.slice(0, Math.max(0, entry.search(pattern)))).includes(second)));
    let matches = pick(yearPattern(citation.year));
    // A year's letter not printed in the entries ("Chung et al., 2023b" where the entry says
    // 2023) is the entry's place among that author's entries of the year, in list order
    if (!matches.length && letter) {
      let same = pick(yearPattern(citation.year.slice(0, 4)));
      let index = letter.charCodeAt(0) - 97;
      if (same.length > index && !same.some(entry => new RegExp('(?<!\\d)' + citation.year.slice(0, 4) + '[a-z]').test(entry))) {
        return [same[index]];
      }
      return [];
    }
    if (matches.length < 2) {
      return matches;
    }
    let pattern = yearPattern(citation.year);
    let authors = entry => {
      let head = entry.slice(0, entry.search(pattern));
      return (head.match(/,/g) || []).length + (head.match(/\sand\s|&/g) || []).length;
    };
    let target = citation.etAl ? Math.max(...matches.map(authors)) : Math.min(...matches.map(authors));
    return matches.filter(entry => authors(entry) === target);
  },

  // Which lines of an unlabeled reference list start entries, from each line's text, left
  // edge (x) and whether Zotero marks a paragraph end after it. An entry starts after a
  // paragraph end, where a line is set as an entry's first line in a list with hanging or
  // first-line indents, or with an author's name as below.
  entryStarts(lines) {
    // An accent may follow its letter as a separate mark, as in "Thiébaut, É."
    lines = lines.map(line => ({ ...line, text: line.text.normalize('NFC') }));
    let group = new RegExp(String.raw`^(\p{Lu}[\p{L}\d&.'’-]*\s+){0,5}(${this.GROUP_WORDS})[,.:]`, 'u');
    // Whether the list sets entries with hanging indents (a first line left of the lines
    // continuing it) or first-line indents (right of them), judged from lines that clearly
    // start entries, with a surname and initials ("Gneiting, T.", "Edward DA,")
    let votes = 0;
    lines.forEach((line, i) => {
      let next = lines[i + 1];
      let dx = next ? next.x - line.x : 0;
      if (Math.abs(dx) > 3 && Math.abs(dx) < 40 && /^\p{Lu}[\p{L}'’-]+(,\s+\p{Lu}\.|\s\p{Lu}{1,3},)/u.test(line.text)) {
        votes += Math.sign(dx);
      }
    });
    // Otherwise from the first change of indent after the list's first line, which starts an
    // entry, as with lists of names written first-name first
    if (Math.abs(votes) <= 2 && lines.length) {
      let change = lines.find(line => Math.abs(line.x - lines[0].x) > 3);
      let dx = change ? change.x - lines[0].x : 0;
      votes = Math.abs(dx) < 40 ? Math.sign(dx) * 3 : 0;
    }
    let layout = votes > 2 ? 'hanging' : votes < -2 ? 'first-line' : 'flat';
    let entryX = null;
    return lines.map((line, i) => {
      let previous = lines[i - 1];
      let name = line.text.replace(/^((van|von|de|der|den|di|da|del|du|le|la)\s+)+/, '');
      // A name and a comma or initials ("Schwarzschild, K.", "Edward DA,"), or a group
      // ("Gravity Collaboration, Abuter, R."), after any line not ending inside an author list,
      // as "Bouman, K. L.; Johnson, M. D.;" does
      let surnameFirst = !/([,;&-]|\band)$/.test(previous?.text || '')
        && (/^(\p{Lu}[\p{L}'’-]+\s?){1,5}(,\s+\p{Lu}\.|\s\p{Lu}{1,3},)/u.test(name) || group.test(name));
      // A name written first-name first ("Michal Jancosek and", "J. T. Barron.", "Black Forest
      // Labs.") after a line ending as an entry does, with a year, pages or a bracket and a
      // period, or a web address
      let nameFirst = /((?:1[89]|20)\d\d[a-z]?|\d+[–-]\d+|\))\.$|https?:\/\/\S+$/.test(previous?.text || '')
        && /^((\p{Lu}\.\s?)+|(\p{Lu}[\p{L}'’-]+\s(\p{Lu}\.\s)*){1,3})\p{Lu}[\p{L}'’-]+(,|\sand\s|\.\s)/u.test(name);
      // Zotero marks paragraph ends inside entries too, so with indents a line set as a
      // continuation continues the entry whatever ends the line before; a line far away is in
      // the next column
      let dx = entryX === null ? 0 : line.x - entryX;
      let continuation = Math.abs(dx) < 40 && (layout === 'hanging' ? dx > 3 : layout === 'first-line' ? dx < -3 : false);
      // A line set as a first line starts an entry: outdented from the line before or, at the top
      // of a column, from the line after
      let next = lines[i + 1];
      let shifted = previous && Math.abs(line.x - previous.x) < 40
        ? (layout === 'hanging' ? previous.x > line.x + 3 : layout === 'first-line' ? line.x > previous.x + 3 : false)
        : !!next && Math.abs(next.x - line.x) < 40
          && (layout === 'hanging' ? next.x > line.x + 3 : layout === 'first-line' ? line.x > next.x + 3 : false);
      let start = /^\p{Lu}/u.test(name)
        && (!previous || shifted || !continuation && (previous.paragraphEnd || surnameFirst || nameFirst));
      if (start) {
        entryX = line.x;
      }
      return start;
    });
  },

  // The reference entry a PDF link points to, read from the destination page's characters
  // (Zotero's, with rect [x1, y1, x2, y2] and line and paragraph breaks). Reading starts at
  // the line beginning nearest below the link's target and stops at the paragraph's end, or
  // where the next entry starts in a list with hanging indents. Zotero sometimes breaks a
  // paragraph inside an entry, so a paragraph end only counts once the entry has a year.
  entryAt(chars, target) {
    let [x, , , y] = target;
    let lineStart = i => i === 0 || chars[i - 1].lineBreakAfter || chars[i - 1].paragraphBreakAfter;
    let near = [];
    for (let i = 0; i < chars.length; i++) {
      let rect = chars[i].rect;
      if (rect && rect[0] >= x - 6 && rect[0] <= x + 40 && rect[3] <= y + 4 && rect[3] >= y - 30) {
        near.push(i);
      }
    }
    let starts = near.filter(lineStart);
    let pool = starts.length ? starts : near;
    if (!pool.length) {
      return '';
    }
    let start = pool.reduce((a, b) => (chars[b].rect[3] > chars[a].rect[3]
      || (chars[b].rect[3] === chars[a].rect[3] && chars[b].rect[0] < chars[a].rect[0]) ? b : a));
    let firstX = chars[start].rect[0];
    let hanging = null;
    let text = '';
    for (let i = start; i < chars.length && text.length < 800; i++) {
      if (i > start && lineStart(i) && chars[i].rect) {
        let indented = chars[i].rect[0] > firstX + 3;
        hanging ??= indented;
        if (hanging && !indented) {
          break;
        }
      }
      text += chars[i].c + (chars[i].spaceAfter ? ' ' : '');
      if (chars[i].paragraphBreakAfter && new RegExp(this.YEAR.source).test(text)) {
        break;
      }
    }
    return text.trim();
  },

  // Whether a link's text fits the reference entry it points to: the entry must look like a
  // reference, a bare number must be its label, a year in the link must be in it, and a word
  // in the link must be part of one of the authors' names (links break across lines, as
  // "Er-"/"mon", and "Virieux & Operto" may link only "Operto"). A link to a part of the paper,
  // such as "Table 1", isn't a citation. PDF text can split accented names, so names are
  // compacted.
  linkFitsEntry(linkText, entry) {
    if (!this.looksLikeReference(entry)) {
      return false;
    }
    // A bare number must be the entry's own label, as in numbered reference lists
    let number = linkText.trim().match(/^[[(]?(\d{1,3})[\])]?,?$/)?.[1];
    if (number) {
      return new RegExp('^\\s*[[(]?' + number + '[\\]).]').test(entry);
    }
    // A word and a small number or letter points to a part of the paper: "Figure 4", "Table 2",
    // "Proposition 1", "Sect. 2.3.1", "Appendix C"
    if (/^\W*\p{L}+(\.\s*|\s+)\(?(\d{1,3}|\p{Lu}\d*)(\.\d+)*\)?\W*$/u.test(linkText.trim())) {
      return false;
    }
    let year = linkText.match(new RegExp(this.YEAR.source))?.[1];
    if (year && !entry.includes(year)) {
      return false;
    }
    let names = (linkText.match(/\p{L}[\p{L}'’-]*/gu) || [])
      .map(name => this.compact(name)).filter(name => name.length >= 2 && !['et', 'al', 'and'].includes(name));
    // Without a name, a year, "et al." or a number, as in "Sect. 2.3.1" or "Appendix C", it
    // isn't one
    if (!names.length) {
      return !!year || /\bet\s*al\b/.test(linkText);
    }
    // The authors come first, before the year
    let yearAt = entry.search(new RegExp(this.YEAR.source));
    let authors = entry.slice(0, Math.min(yearAt > 0 ? yearAt : 150, 150));
    let authorNames = authors.split(/,|\sand\s|&/).map(author => this.compact(author));
    return names.some(name => authorNames.some(author => name.length >= 3 ? author.includes(name) : author.endsWith(name)));
  },

  // The references a clicked citation cites, or [] when it isn't a genuine citation.
  // references: Zotero's, as { text, number }; left, right: the text beside the word.
  citedReferences(word, references, paper, left, right) {
    if (!paper.real || !references.length) {
      return [];
    }
    if (paper.numbered) {
      return this.isNumberedCitation(word, paper) ? references : [];
    }
    // A citation with a name and its year, as merged citations are, is read alone. Otherwise
    // the text read stops where the citation's brackets close, so a neighboring citation
    // isn't read as part of it: "[Aliev et al. 2019; Thies et al. 2019] or renderings [Fried"
    if (/\p{Lu}\p{Ll}/u.test(word) && new RegExp(this.YEAR.source).test(word)) {
      return this.resolveAuthorYear('', word, references);
    }
    return this.resolveAuthorYear(left, right.split(/[\])]/)[0], references);
  }
};
