// Regression tests for lookup.js, run against saved Scholar, OpenAlex and arXiv replies so
// they need no network. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const context = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL('zotero-citation-cards/lookup.js', root), 'utf8'), context);
const Lookup = context.CiteCardLookup;

const fixture = name => readFileSync(new URL('tests/fixtures/' + name, root), 'utf8');
const json = name => JSON.parse(fixture(name));
// Values made inside the vm context have that context's prototypes, which deepEqual rejects
const plain = value => JSON.parse(JSON.stringify(value));

// A stand-in for the plugin's request function: answers from fixtures by URL, null otherwise,
// and records every URL asked for
function fakeRequest(routes) {
  let calls = [];
  let request = async url => {
    calls.push(decodeURIComponent(url));
    let route = routes.find(([matches]) => matches(decodeURIComponent(url)));
    return route ? route[1]() : null;
  };
  return { request, calls };
}

const BURGER = '10. Burger, H.C., Schuler, C.J., Harmeling, S.: Image denois-ing: Can plain neural networks compete with bm3d? In:CVPR, pp. 2392–2399 (2012) 2, 4';
const LEFKIMMIATIS = '37. Lefkimmiatis, S.: Non-local color image denoising withconvolutional neural networks. In: CVPR. IEEE Com-puter Society (2016) 2, 20';
const HO = 'Ho, J., Jain, A., and Abbeel, P. Denoising diffusion probabilistic models. arXiv preprint arXiv:2006.11239, 2020.';
const VASWANI = '[1] A. Vaswani, N. Shazeer, N. Parmar, J. Uszkoreit, L. Jones, A. N. Gomez, Ł. Kaiser, and I. Polosukhin. Atten- tion is all you need. In Advances in Neural Information Processing Systems, 2017.';
const MILDENHALL = '[4] B. Mildenhall, P. P. Srinivasan, M. Tancik, J. T. Barron, R. Ramamoorthi, and R. Ng. NeRF: Representing scenes as neural radiance fields for view synthesis. In ECCV, 2020.';

test('Scholar request sends the reference without its number or line-break hyphens', () => {
  let url = new URL(Lookup.scholarURL(VASWANI));
  assert.ok(url.searchParams.get('q').startsWith('A. Vaswani'));
  assert.ok(url.searchParams.get('q').includes('Attention is all you need'));
  assert.equal(url.searchParams.get('output'), 'gsb');
});

test('a matched signed-in Scholar reply becomes a card', () => {
  let meta = Lookup.fromScholarReply(json('scholar-signed-in.json'));
  assert.equal(meta.title, 'Image denoising: Can plain neural networks compete with BM3D?');
  assert.equal(meta.titleURL, 'https://ieeexplore.ieee.org/abstract/document/6247952/');
  assert.match(meta.metaLine, /^HC Burger, CJ Schuler, S Harmeling\s-\s2012 IEEE conference/);
  assert.match(meta.abstract, /^Image denoising can be described as the problem of mapping/);
  assert.ok(!meta.abstract.includes('<'));
  assert.deepEqual(plain(meta.links.map(link => link.label.replace(/\d+/, 'N'))), ['Cited by N', 'Related articles', 'All N versions']);
  assert.ok(meta.links.every(link => link.url.startsWith('https://scholar.google.com/scholar?')));
});

test('an unmatched (signed-out) Scholar reply is not used', () => {
  assert.equal(Lookup.fromScholarReply(json('scholar-signed-out.json')), null);
  assert.equal(Lookup.fromScholarReply({ l: '1', r: [] }), null);
  assert.equal(Lookup.fromScholarReply(null), null);
});

test('a reply asking for a CAPTCHA is told apart from a miss', () => {
  // Shapes Scholar sent on 2026-10-24: a flagged session, and a real miss when signed in
  assert.equal(Lookup.wantsCaptcha({ L: '?q=Building+Rome+in+a+day&hl=en&as_sdt=0,33', p: '', r: [] }), true);
  assert.equal(Lookup.wantsCaptcha({ u: 'x', x: 'y', p: '', r: [] }), false);
  assert.equal(Lookup.wantsCaptcha(json('scholar-signed-in.json')), false);
});

test('replies in an unexpected format are recognized', () => {
  assert.equal(Lookup.isScholarReply(json('scholar-signed-in.json')), true);
  assert.equal(Lookup.isScholarReply(json('scholar-signed-out.json')), true);
  assert.equal(Lookup.isScholarReply({ r: [] }), true);
  assert.equal(Lookup.isScholarReply({}), false);
  assert.equal(Lookup.isScholarReply({ l: '1', r: [{}] }), false);
  assert.equal(Lookup.isScholarReply(null), false);
});

test('Scholar redirect links are unwrapped to their target', () => {
  assert.equal(Lookup.unwrapScholarURL('https://scholar.google.com/scholar_url?url=https://arxiv.org/abs/1706.03762&hl=en'), 'https://arxiv.org/abs/1706.03762');
  assert.equal(Lookup.unwrapScholarURL('/scholar?cluster=1'), 'https://scholar.google.com/scholar?cluster=1');
});

test('titles are guessed across citation styles', () => {
  assert.equal(Lookup.guessTitles(Lookup.cleanReference(BURGER))[0], 'Image denois-ing: Can plain neural networks compete with bm3d');
  assert.equal(Lookup.guessTitles(Lookup.cleanReference(LEFKIMMIATIS))[0], 'Non-local color image denoising withconvolutional neural networks');
  assert.equal(Lookup.guessTitles(Lookup.cleanReference(HO))[0], 'Denoising diffusion probabilistic models');
  assert.equal(Lookup.guessTitles(Lookup.cleanReference(VASWANI))[0], 'Attention is all you need');
  assert.equal(Lookup.guessTitles(Lookup.cleanReference(MILDENHALL))[0], 'NeRF: Representing scenes as neural radiance fields for view synthesis');
  assert.equal(Lookup.guessTitles(Lookup.cleanReference('[36] He, X. (1997): “Quantile Curves Without Crossing,” American Statistician, 51, pp. 186–192.'))[0], 'Quantile Curves Without Crossing');
});

test('a found title must appear whole in the reference', () => {
  assert.equal(Lookup.titleMatches('Attention Is All You Need', VASWANI), true);
  assert.equal(Lookup.titleMatches('All you need is love', VASWANI), false);
  assert.equal(Lookup.titleMatches('NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis', MILDENHALL), true);
  assert.equal(Lookup.titleMatches('D-NeRF: Neural Radiance Fields for Dynamic Scenes', MILDENHALL), false);
});

test('a same-title paper by other authors is rejected', async () => {
  let results = json('openalex-search-burger.json');
  for (let authorship of results.results[0].authorships) {
    authorship.author.display_name = 'Someone Else';
  }
  let { request } = fakeRequest([[url => url.includes('search='), () => results]]);
  assert.equal(await Lookup.openAlex(BURGER, request), null);
  assert.equal(Lookup.authorsMatch({ authorships: [] }, BURGER), true);
});

test('DOIs and arXiv IDs are found in references', () => {
  assert.deepEqual(plain(Lookup.findIdentifiers('See doi:10.1109/cvpr.2016.90.')), { doi: '10.1109/cvpr.2016.90', arxiv: null });
  assert.equal(Lookup.findIdentifiers(HO).arxiv, '2006.11239');
});

test('OpenAlex finds a reference by its guessed title, joining a word split across lines', async () => {
  let { request, calls } = fakeRequest([[url => url.includes('search=Image denoising'), () => json('openalex-search-burger.json')]]);
  let meta = await Lookup.openAlex(BURGER, request);
  assert.deepEqual(calls.map(url => url.match(/search=([^&]*)/)[1].slice(0, 20)), ['Image denois-ing: Ca', 'Image denoising: Can']);
  assert.equal(meta.title, 'Image denoising: Can plain neural networks compete with BM3D?');
  assert.equal(meta.titleURL, 'https://doi.org/10.1109/cvpr.2012.6247952');
  assert.equal(meta.doi, '10.1109/cvpr.2012.6247952');
  assert.match(meta.metaLine, /^HC Burger, CJ Schuler, S Harmeling - IEEE Computer Society Conference on Comp…, 2012$/);
  assert.match(meta.abstract, /^Image denoising can be described/);
  assert.deepEqual(plain(meta.links.map(link => link.label.replace(/[\d,]+/, 'N'))), ['Cited by N', 'Google Scholar']);
});

test('OpenAlex searches leave out the wildcard characters OpenAlex rejects', async () => {
  let { request, calls } = fakeRequest([[url => url.includes('search=Image denoising'), () => json('openalex-search-burger.json')]]);
  let work = await Lookup.search(['Image denoising: Can plain neural networks compete with BM3D?'], BURGER, request);
  assert.equal(work.title, 'Image denoising: Can plain neural networks compete with BM3D?');
  assert.ok(calls.every(url => !/search=[^&]*[?*]/.test(url)));
});

test('OpenAlex retries without the longest word when PDF text fused two words', async () => {
  let { request, calls } = fakeRequest([
    [url => url.includes('withconvolutional'), () => json('openalex-search-lefkimmiatis-fused.json')],
    [url => url.includes('search=Non-local color image denoising neural networks'), () => json('openalex-search-lefkimmiatis-retry.json')]
  ]);
  let meta = await Lookup.openAlex(LEFKIMMIATIS, request);
  assert.equal(calls.filter(url => url.includes('api.openalex.org/works?')).length, 3);
  assert.equal(meta.title, 'Non-local Color Image Denoising with Convolutional Neural Networks');
});

test('real hyphens are kept in OpenAlex searches', async () => {
  let { calls, request } = fakeRequest([]);
  await Lookup.search(['Score-based generative modeling through stochastic differential equations'], 'Yang Song. Score-based generative modeling through stochastic differential equations. ICLR, 2021.', request);
  assert.ok(calls[0].includes('search=Score-based generative'));
});

test('arXiv papers get their abstract from arXiv, not OpenAlex', async () => {
  let { request, calls } = fakeRequest([
    [url => url.includes('works/doi:10.48550/arXiv.2006.11239'), () => json('openalex-doi-ddpm.json')],
    [url => url.includes('export.arxiv.org'), () => fixture('arxiv-ddpm.xml')]
  ]);
  let meta = await Lookup.openAlex(HO, request);
  assert.equal(calls.length, 2);
  assert.equal(meta.title, 'Denoising Diffusion Probabilistic Models');
  assert.match(meta.abstract, /^We present high quality image synthesis results using diffusion probabilistic models/);
});

test('a reference OpenAlex cannot match gives no card', async () => {
  let { request, calls } = fakeRequest([]);
  assert.equal(await Lookup.openAlex(BURGER, request), null);
  // At most three searches for each of two guessed titles
  assert.ok(calls.length <= 6);
});

test('a duplicate record dated after the reference shows the reference year', () => {
  assert.equal(Lookup.displayYear(2025, VASWANI), 2017);
  assert.equal(Lookup.displayYear(2012, BURGER), 2012);
});

test('HTML entities in titles and abstracts are decoded', () => {
  assert.equal(Lookup.cleanTitle('A &amp; B &hellip; <b>C</b>&#8230;'), 'A & B … C…');
});

test('formulas a publisher set as LaTeX documents show as formulas', () => {
  const tex = '\\documentclass[12pt]{minimal} \\usepackage{amsmath} \\usepackage{wasysym} \\setlength{\\oddsidemargin}{-69pt} \\begin{document}';
  assert.equal(Lookup.cleanAbstract(`The absolute coregularity is defined to be ${tex}$$\\begin{aligned} \\hat{coreg}(X):= \\dim X - \\hat{reg}(X)-1. \\end{aligned}$$\\end{document}The coregularity is`),
    'The absolute coregularity is defined to be coreg(X):= dim X - reg(X)-1. The coregularity is');
  assert.equal(Lookup.cleanAbstract(`for ${tex}$\\alpha \\leq \\frac{1}{2}$\\end{document} and`), 'for α ≤ 1/2 and');
  // Cut off inside one, as Scholar's snippets can be
  assert.equal(Lookup.cleanAbstract(`The absolute coregularity is defined to be ${tex}…`), 'The absolute coregularity is defined to be…');
});
