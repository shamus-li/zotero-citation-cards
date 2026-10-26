// Regression tests for citations.js, run against the citations Zotero detected in real papers
// of different styles (tests/fixtures/papers). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('zotero-citation-cards/citations.js', root), 'utf8'), context);
const Citations = context.CiteCardCitations;
// Values made inside the vm context have that context's prototypes, which deepEqual rejects
const plain = value => JSON.parse(JSON.stringify(value));

function load(name) {
  let paper = JSON.parse(readFileSync(new URL(`tests/fixtures/papers/${name}.json`, root), 'utf8'));
  let description = Citations.describePaper(paper.references.map(r => r.text), paper.references.filter(r => r.number).length);
  let cited = citation => Citations.citedReferences(citation.word, citation.refs.map(id => paper.references[id]), description, citation.left, citation.right);
  return { ...paper, description, cited };
}

const accepted = paper => paper.citations.filter(citation => paper.cited(citation).length > 0);

test('papers whose "references" are affiliations, algorithm steps, tables or lists are left alone', () => {
  for (let name of ['apjl-eht-affiliations', 'icml-consistency-algorithm', 'jmlr-gsplat-math', 'iclr-inversebench-table', 'iclr-score-sde-list']) {
    let paper = load(name);
    assert.equal(paper.description.real, false, name);
    assert.equal(accepted(paper).length, 0, name);
  }
});

test('bracketed numbered citations are all accepted', () => {
  for (let name of ['ijcv-brackets', 'iccv-brackets', 'eccv-brackets', 'neurips-brackets', 'siam-brackets', 'ieee-tip-brackets', 'optics-express-brackets', 'arxiv-millivid-ranges']) {
    let paper = load(name);
    assert.equal(paper.description.real, true, name);
    assert.equal(paper.description.numbered, true, name);
    assert.equal(accepted(paper).length, paper.citations.length, name);
  }
});

test('superscript citations are accepted', () => {
  for (let name of ['nature-photonics-superscript', 'acs-superscript']) {
    let paper = load(name);
    assert.equal(paper.description.real, true, name);
    assert.equal(accepted(paper).length, paper.citations.length, name);
  }
});

test('equation numbers matched to a real reference list are rejected', () => {
  let paper = load('econometrica-equations');
  assert.equal(paper.description.real, true);
  assert.ok(paper.citations.every(citation => citation.word.startsWith('(')));
  assert.equal(accepted(paper).length, 0);
});

test('author-year citations resolve to one reference, or none when Zotero linked the wrong paper', () => {
  let paper = load('acm-tog-author-year');
  assert.equal(paper.description.numbered, false);
  let outcomes = paper.citations.map(citation => paper.cited(citation).length);
  assert.equal(outcomes.filter(n => n === 1).length, 178);
  assert.equal(outcomes.filter(n => n > 1).length, 0);
  assert.equal(outcomes.filter(n => n === 0).length, 9);
});

test('author-year resolution picks the right paper in hard cases', () => {
  let paper = load('acm-tog-author-year');
  let find = (word, before) => paper.citations.find(c => c.word === word && c.left.endsWith(before));
  let title = citation => [...paper.cited(citation)].map(r => r.text.slice(0, 60));

  // Two citations share a year: "[Hartley and Zisserman 2000; Triggs et al. 2000]"
  assert.match(title(find('2000', 'Hartley and Zisserman '))[0], /^Richard Hartley and Andrew Zisserman/);
  // Three Schönberger 2016 papers; no "et al." means the single-author one
  assert.match(title(paper.citations.find(c => c.word === 'Schönberger' && c.right.startsWith('Schönberger 2016;')))[0], /^Johannes L\. Schönberger\. 2016\. COLMAP/);
  // Where Zotero linked "Moulon et al. 2016" to the Schönberger papers: no card
  let moulon = paper.citations.find(c => c.word === '2016' && c.left.endsWith('Moulon et al. ')
    && c.refs.every(id => !paper.references[id].text.startsWith('Pierre Moulon')));
  assert.deepEqual(title(moulon), []);
  // The paper's own author list next to its year, "… and Vladlen Koltun. 2017. Tanks and
  // Temples", isn't a citation of Koltun's other 2017 paper
  assert.deepEqual(title(paper.citations.find(c => c.word === 'Koltun' && c.right.startsWith('Koltun. 2017. Tanks'))), []);
  // "and" fused onto a name: "Zhouand Koltun 2013"
  assert.match(title(paper.citations.find(c => c.word === 'Koltun' && c.right.startsWith('Koltun 2013')))[0], /^Qian-Yi Zhou and Vladlen Koltun\. 2013/);
  // Names fused with "et al." in the PDF text: "Strechaet al. [2008]"
  assert.match(title(paper.citations.find(c => c.word === 'Strecha' && /Strechaet al/.test(c.right)))[0], /^Christoph Strecha/);
});

test('names and years of one author-year citation are joined, separate citations are not', () => {
  for (let gap of [' et al. ', ' and ', ' ', ', ', 'et al. [', 'and ', ' & ', ' et al., ', ' et al. (']) {
    assert.equal(Citations.joinsCitation('Agarwal', gap), true, JSON.stringify(gap));
  }
  for (let gap of ['; ', '], advanced ', ') and ', '. In this work ', ' 2011; Shan et al. ']) {
    assert.equal(Citations.joinsCitation('Agarwal', gap), false, JSON.stringify(gap));
  }
  // A year ends a citation: "Hall et al., 1999, and Abadie, 2002"
  assert.equal(Citations.joinsCitation('1999', ', and '), false);
  assert.equal(Citations.joinsCitation('2022a', ' and '), false);
});

test('reference list headings are recognized', () => {
  for (let line of ['References', 'REFERENCES', '7. References', 'Bibliography', 'VI. REFERENCES']) {
    assert.equal(Citations.isBibliographyHeading(line), true, line);
  }
  for (let line of ['References to prior work are given below.', 'Referenced works', '2.1 Background', 'references.', '112 References']) {
    assert.equal(Citations.isBibliographyHeading(line), false, line);
  }
});

test('author-year citations Zotero missed are found in the text and matched to entries', () => {
  // Econometrica's text and some of its references, where Zotero finds no citations
  const text = 'the conditional quantile curves may cross for different values of u (He, 1997). Similar issues also arise in estimation (Hall et al., 1999, and Abadie, 2002). As noted in Chernozhukov and Hansen (2006) and by Koenker (1994, p. 3), see also Dette et al. (2006). In 1997 (the year) Table 2 (2001 data) shows';
  const entries = [
    'Abadie, A. (2002): “Bootstrap tests for distributional treatment effects in instrumental variable models,” Journal of the American Statistical Association, 97, 284–292.',
    'Abadie, A., Angrist, J., and G. Imbens (2002): “Instrumental Variables Estimates of the Effect of Subsidized Training on the Quantiles of Trainee Earnings,” Econometrica, 70, 91–117.',
    'Chernozhukov, V., and C. Hansen (2006): “Instrumental quantile regression inference for structural and treatment effect models,” Journal of Econometrics, 132, 491–525.',
    'Dette, H., Neumeyer, N., and K. F. Pilz (2006): “A simple nonparametric estimator of a strictly monotone regression function,” Bernoulli, 12, 469–490.',
    'Hall, P., Wolff, R., and Q. Yao (1999): “Methods for estimating a conditional distribution function,” Journal of the American Statistical Association, 94, 154–163.',
    'He, X. (1997): “Quantile curves without crossing,” American Statistician, 51, 186–192.',
    'Koenker, R. (1994): “Confidence intervals for regression quantiles,” in Asymptotic Statistics, ed. by P. Mandl and M. Huskova. Springer.'
  ];
  let found = Citations.findAuthorYearCitations(text);
  let named = found.map(citation => [text.slice(citation.start, citation.end), Citations.matchAuthorYear(citation, entries).map(entry => entry.slice(0, 12))]);
  assert.deepEqual(plain(named.filter(([, matches]) => matches.length)), [
    ['He, 1997', ['He, X. (1997']],
    ['Hall et al., 1999', ['Hall, P., Wo']],
    ['Abadie, 2002', ['Abadie, A. (']],
    ['Chernozhukov and Hansen (2006)', ['Chernozhukov']],
    ['Koenker (1994', ['Koenker, R. ']],
    ['Dette et al. (2006)', ['Dette, H., N']]
  ]);
  // Text that isn't a citation matches no entry
  assert.ok(named.every(([citation, matches]) => matches.length || /^(In|Table)/.test(citation)));
  // A name starts a word: in "the model Choi et al." the "del" of "model" isn't a particle
  const model = 'trained the model Choi et al. (2021) and van der Vaart (1998)';
  assert.deepEqual(plain(Citations.findAuthorYearCitations(model).map(c => model.slice(c.start, c.end))), ['Choi et al. (2021)', 'van der Vaart (1998)']);
});

test('a citation is not resolved to a neighboring citation\'s paper', () => {
  // Zotero linked "Thies et al. 2019" only to Fried et al. 2019, which the next citation names
  const fried = { text: 'Ohad Fried, Ayush Tewari, Michael Zollhöfer, Adam Finkelstein, Eli Shechtman, Dan B Goldman, Kyle Genova, Zeyu Jin, Christian Theobalt, and Maneesh Agrawala. 2019. Text-based editing of talking-head video. ACM Trans. Graph. 38, 4 (2019).' };
  const paper = { real: true, numbered: false };
  const left = 'or by using proxy geometries [Aliev et al. 2019; ';
  assert.deepEqual(plain(Citations.citedReferences('Thies et al. 2019', [fried], paper, left, 'Thies et al. 2019] or conventional renderings [Fried et al. 2019')), []);
  assert.deepEqual(plain(Citations.citedReferences('Thies', [fried], paper, left, 'Thies et al. 2019] or conventional renderings [Fried et al. 2019')), []);
  assert.equal(Citations.citedReferences('Fried et al. 2019', [fried], paper, 'conventional renderings [', 'Fried et al. 2019; Kim et al. 2018]').length, 1);
});

test('labeled reference lists and their citations are read', () => {
  assert.deepEqual(plain(Citations.entryLabel('[12] A. Vaswani, N. Shazeer. Attention is all you need.')), { style: 'bracket', label: '12' });
  assert.deepEqual(plain(Citations.entryLabel('12. Sakai, Y. et al. Automatic detection of early gastric cancer.')), { style: 'dot', label: '12' });
  assert.deepEqual(plain(Citations.entryLabel('[AFO17] D. Arcara, G. Farkas, A. Ortega. The strange duality conjecture.')), { style: 'alpha', label: 'AFO17' });
  assert.equal(Citations.entryLabel('2010. Building Rome in a day.'), null);
  for (let line of ['■ REFERENCES', 'References and Notes', '• Bibliography', 'References.', 'Notes and references']) {
    assert.equal(Citations.isBibliographyHeading(line), true, line);
  }

  let numbers = new Set(Array.from({ length: 30 }, (_, i) => String(i + 1)));
  let text = 'as shown before [1–3], and later [6, 7]; see also [12, p. 4]. For x ∈ [1, 2] and the interval [0, 1], with [45] not an entry.';
  assert.deepEqual(plain(Citations.findLabeledCitations(text, numbers).map(c => [text.slice(c.start, c.end), c.labels])), [
    ['[1–3]', ['1', '2', '3']],
    ['[6', ['6']],
    ['7]', ['7']],
    ['[12, p. 4]', ['12']]
  ]);
  let alpha = new Set(['AFO17', 'BM14a', 'Kol99']);
  let math = 'by [AFO17] and [BM14a, Kol99], and [Kol99, Theorem 2.1], but not [ABC12] or [Lemma 3].';
  assert.deepEqual(plain(Citations.findLabeledCitations(math, alpha).map(c => c.labels)), [['AFO17'], ['BM14a'], ['Kol99'], ['Kol99']]);
});

test('footnotes are told apart by what they do', () => {
  // From the law and history papers in the test set
  const kind = text => plain(Citations.footnoteKind(text));
  assert.deepEqual(kind('Edoardo Chiti and Pedro Gustavo Teixeira, ‘The Constitutional Implications of the European Responses to the Financial and Public Debt Crisis’ (2013) 50 Common Market Law Review 683, 697.'), { kind: 'cites' });
  assert.deepEqual(kind('Case C-370/12 Pringle ECLI:EU:C:2012:756, [2012] OJ C303, para 135.'), { kind: 'cites' });
  assert.deepEqual(kind('Harden (n 11).'), { kind: 'refers', number: '11' });
  assert.deepEqual(kind('Ian Harden, id, p. 74. Later on, these policies have been complemented with other economic policies.'), { kind: 'earlier' });
  assert.deepEqual(kind('Ibid., 45.'), { kind: 'earlier' });
  assert.deepEqual(kind('See section 3 below.'), { kind: 'note' });
  assert.deepEqual(kind('In the Delors Report we find the principle of parallelism as the leading idea.'), { kind: 'note' });
});

test('unusual author-year citations match their entries', () => {
  // Citations and entries from the test set that the plugin used to miss
  // As the plugin places them: a citation naming entries, where no earlier one took its place
  const match = (text, entries) => {
    let placed = [];
    for (let citation of Citations.findAuthorYearCitations(text)) {
      let named = Citations.matchAuthorYear(citation, entries);
      if (named.length && !placed.some(other => other.start < citation.end && citation.start < other.end)) {
        placed.push({ ...citation, named });
      }
    }
    return plain(placed.map(citation => [text.slice(citation.start, citation.end), citation.named.map(entry => entry.slice(0, 12))]));
  };
  const entries = [
    'OpenAI. GPT-Image-1.5. https://openai.com/index/new-chatgpt-images-is-here/, 2026. Accessed: 2026-03-19.',
    'Black Forest Labs. FLUX.2: Frontier Visual Intelligence. https://bfl.ai/blog/flux-2, 2025.',
    'R Development Core Team (2007): R: A language and environment for statistical computing. R Foundation for Statistical Computing, Vienna.',
    'Event Horizon Telescope Collaboration, Akiyama, K., Alberdi, A., et al. 2019a, ApJL, 875, L1',
    'Event Horizon Telescope Collaboration, Akiyama, K., Alberdi, A., et al. 2019b, ApJL, 875, L2',
    'Gravity Collaboration, Abuter, R., Amorim, A., et al. 2018a, A&A, 615, L15',
    'Gravity Collaboration, Abuter, R., Amorim, A., et al. 2018b, A&A, 618, L10',
    'Thompson, A. R.; Moran, J. M.; and Swenson Jr, G. W. 2017. Interferometry and synthesis in radio astronomy. Springer Nature.',
    'Radford M Neal et al. Mcmc using hamiltonian dynamics. Handbook of markov chain monte carlo, 2(11):2, 2011.',
    'Edward DA, Chapman T. 2011. Mechanisms underlying reproductive trade-offs: Costs of reproduction. Oxford University Press.',
    'VTT Technical Research Centre of Finland Ltd: LIPASTO unit emissions, database, available at: http://lipasto.vtt.fi/, 2017.',
    'Team Hunyuan3D, Shuhui Yang, Mingxin Yang, Yifei Feng, Xin Huang, Sheng Zhang. Hunyuan3D 2.1: From images to high-fidelity 3D assets, 2025.',
    'Michal Janc ̌ osek and Tomáš Pajdla. 2011. Multi-view reconstruction preserving weakly-supported surfaces. In CVPR.',
    'Gneiting, T. and Raftery, A. E. Strictly proper scoring rules, prediction, and estimation. JASA, 102(477):359–378, 2007.',
    'Abadie, A. (2002): “Bootstrap tests for distributional treatment effects in instrumental variable models,” JASA, 97, 284–292.',
    'World Health Organization. Global report on diabetes. Geneva: WHO; 2016.',
    'Hyungjin Chung, Jeongsol Kim, Michael T Mccann, Marc L Klasky, and Jong Chul Ye. Diffusion posterior sampling for general noisy inverse problems. In ICLR, 2023.',
    'Hyungjin Chung, Suhyeon Lee, and Jong Chul Ye. Decomposed diffusion sampler for accelerating large-scale inverse problems. In ICLR, 2024.',
    'Hyungjin Chung, Byeongsu Sim, Dohoon Ryu, and Jong Chul Ye. Improving diffusion models for inverse problems using manifold constraints. In NeurIPS, 2022.',
    'Hyungjin Chung, Dohoon Ryu, Michael T Mccann, Marc L Klasky, and Jong Chul Ye. Solving 3D inverse problems using pre-trained 2D diffusion models. In CVPR, 2023.',
    'Peng Wang and Rajesh Menon. 2015. Ultra-high-sensitivity color imaging via a transparent diffractive-filter array. Optica 2, 11 (Nov 2015), 933–939.',
    'Peng Wang and Rajesh Menon. 2018. Computational multispectral video imaging. J. Opt. Soc. Am. A 35, 1 (Jan 2018), 189–199.'
  ];
  const text = 'models (Black Forest Labs, 2025; OpenAI, 2026) in R (R Development Core Team, 2007), as in (The EHT Collaboration et al. 2019b) '
    + 'and (Gravity Collaboration et al. 2018b), see (Thompson, Moran, and Swenson Jr 2017) and (Neal et al., 2011; Edward and Chapman, 2011) '
    + 'with (VTT Technical Research Centre of Finland Ltd, 2017), Hunyuan3D 2.1 (Hunyuan3D et al., 2025), Jancosek and Pajdla [2011], '
    + 'rules (Gneit- ing & Raftery, 2007), Abadie’s (2002) test, the WHO report (WHO, 2016), and DPS (Chung et al., 2023a) with DiffusionMBIR (Chung et al., 2023b). '
    + 'Recently, Wang and Menon [2015; 2018] introduced filter arrays.';
  assert.deepEqual(match(text, entries), [
    ['Black Forest Labs, 2025', ['Black Forest']],
    ['OpenAI, 2026', ['OpenAI. GPT-']],
    ['R Development Core Team, 2007', ['R Developmen']],
    ['The EHT Collaboration et al. 2019b', ['Event Horizo']],
    ['Gravity Collaboration et al. 2018b', ['Gravity Coll']],
    ['Thompson, Moran, and Swenson Jr 2017', ['Thompson, A.']],
    ['Neal et al., 2011', ['Radford M Ne']],
    ['Edward and Chapman, 2011', ['Edward DA, C']],
    ['VTT Technical Research Centre of Finland Ltd, 2017', ['VTT Technica']],
    ['Hunyuan3D et al., 2025', ['Team Hunyuan']],
    ['Jancosek and Pajdla [2011]', ['Michal Janc ']],
    ['Gneit- ing & Raftery, 2007', ['Gneiting, T.']],
    ['Abadie’s (2002)', ['Abadie, A. (']],
    ['WHO, 2016', ['World Health']],
    ['Chung et al., 2023a', ['Hyungjin Chu']],
    ['Chung et al., 2023b', ['Hyungjin Chu']],
    ['Wang and Menon [2015', ['Peng Wang an']],
    ['2018', ['Peng Wang an']]
  ]);
  // Different groups with the same last word don't match each other
  assert.equal(Citations.groupMatches('Planck Collaboration', 'Event Horizon Telescope Collaboration'), false);
  assert.equal(Citations.groupMatches('EHT Collaboration', 'Event Horizon Telescope Collaboration'), true);
});

test('ranges, further years and numbers cited in words are found', () => {
  let numbers = new Set(Array.from({ length: 40 }, (_, i) => String(i + 1)));
  let text = 'spectral datacube [6]–[9] and others [10]–[12], see ref. 16 and refs. 3–5, but not [3]–[2].';
  assert.deepEqual(plain(Citations.findLabeledCitations(text, numbers).map(c => [text.slice(c.start, c.end), c.labels])), [
    ['[6]–[9]', ['6', '7', '8', '9']],
    ['[10]–[12]', ['10', '11', '12']],
    ['ref. 16', ['16']],
    ['refs. 3–5', ['3', '4', '5']],
    ['[3]', ['3']],
    ['[2]', ['2']]
  ]);
  const entries = [
    'Heiger, M. E., Li, T. S., Pace, A. B., et al. 2024, ApJ, 961, 234',
    'Heiger, M. E., Li, T. S., Pace, A. B., et al. 2026, ApJ, 980, 12',
    'Ji, A. P., Frebel, A., Chiti, A., & Simon, J. D. 2016a, Natur, 531, 610',
    'Ji, A. P., Frebel, A., Simon, J. D., & Chiti, A. 2016b, ApJ, 830, 93',
    'Smith, J. 2001, ApJ, 1, 1',
    'Smith, J. 2003, ApJ, 2, 2'
  ];
  let years = '(e.g. Heiger et al. 2024, 2026; Ji et al. 2016a,b), as Smith (2001, 2003) showed (Smith 2001, p. 5).';
  assert.deepEqual(plain(Citations.findAuthorYearCitations(years)
    .map(c => [years.slice(c.start, c.end), Citations.matchAuthorYear(c, entries).map(e => e.slice(0, 12))])), [
    ['Heiger et al. 2024', ['Heiger, M. E']],
    ['2026', ['Heiger, M. E']],
    ['Ji et al. 2016a', ['Ji, A. P., F']],
    ['b', ['Ji, A. P., F']],
    ['Smith (2001', ['Smith, J. 20']],
    ['2003', ['Smith, J. 20']],
    ['Smith 2001', ['Smith, J. 20']]
  ]);
  // After a semicolon, a bare year before a separator or the end is the same authors'
  let semicolon = '(Smith, 2001; 2003) but not (Smith, 2001; 2003 data)';
  assert.deepEqual(plain(Citations.findAuthorYearCitations(semicolon).map(c => [semicolon.slice(c.start, c.end), c.year])),
    [['Smith, 2001', '2001'], ['2003', '2003'], ['Smith, 2001', '2001']]);
});

test('entries are told apart in lists set in different ways', () => {
  // Lines as Zotero reads them: text, left edge, and whether a paragraph end follows
  const starts = lines => plain(Citations.entryStarts(lines.map(([x, paragraphEnd, text]) => ({ x, paragraphEnd, text }))));
  // Frontiers: first lines indented right of the lines continuing them
  assert.deepEqual(starts([
    [64, false, 'Abelson, R. P. (1995). “Attitude extremity,” in Attitude Strength: Antecedents and'],
    [58, true, 'Consequences, eds R. E. Petty and J. A. Krosnick (Mahwah, NJ: Erlbaum), 25–41.'],
    [64, false, 'Ajzen, I. (1991). The theory of planned behavior. Organ. Behav. Hum. Decis.'],
    [58, true, 'Process. 50, 179–211. doi: 10.1016/0749-5978(91)90020-T'],
    [64, false, 'Armitage, C. J., and Conner, M. (2004). “The effects of implementation intentions'],
    [58, false, 'on attitude-intention-behaviour relations,” in Theoretical Developments in Social'],
    [58, false, 'for the 21st Century: The Gregynog Symposium, eds G. R. Maio and G. Haddock'],
    [58, true, '(Hove: Psychology Press), 121–143.'],
    [64, false, 'Bandura, A. (1997). Self-Efficacy: The Exercise of Control. New York, NY:'],
    [58, true, 'Freeman.']
  ]), [true, false, true, false, true, false, false, false, true, false]);
  // ICML: hanging indents, with Zotero marking paragraph ends inside entries
  assert.deepEqual(starts([
    [55, false, 'Gershman, S. J. and Blei, D. M. A tutorial on Bayesian nonpara-'],
    [65, false, 'metric models. Journal of Mathematical Psychology, 56(1):'],
    [65, false, '1–12, 2012.'],
    [55, false, 'Gneiting, T. and Raftery, A. E. Strictly proper scoring rules, pre-'],
    [65, true, 'diction, and estimation. Journal of the American Statistical'],
    [65, true, 'Association, 102(477):359–378, 2007.'],
    [55, false, 'Goodfellow, I. J., Pouget-Abadie, J., Mirza, M., Xu, B., Warde-'],
    [65, false, 'Farley, D., Ozair, S., Courville, A., and Bengio, Y. Generative'],
    [65, true, 'Adversarial Nets. Advances in Neural Information Processing'],
    [65, true, 'Systems, 2014.']
  ]), [true, false, false, true, false, false, true, false, false, false]);
  // ACM: names written first-name first, hanging indents, a paragraph end inside an entry
  assert.deepEqual(starts([
    [52, false, 'Sameer Agarwal, Yasutaka Furukawa, Noah Snavely, Ian Simon, Brian'],
    [60, true, 'Curless, Steven M. Seitz, and Richard Szeliski. 2011. Building Rome'],
    [60, true, 'in a day. Commun. ACM 54, 10 (2011).'],
    [52, false, 'Henrik Aanæs, Rasmus Ramsbøl Jensen, George Vogiatzis, Engin Tola, and'],
    [60, false, 'Anders Bjorholm Dahl. 2016. Large-scale data for multiple-view stereopsis.'],
    [60, true, 'IJCV 120, 2 (2016).']
  ]), [true, false, false, true, false, false]);
  // ACM and A&A: entries running together, no indents or paragraph ends
  assert.deepEqual(starts([
    [52, false, 'Wenzel Jakob. 2010. Mitsuba renderer. http://www.mitsuba-renderer.org.'],
    [52, false, '(2010).'],
    [52, false, 'Michal Jancosek and Tomas Pajdla. 2011. Multi-view reconstruction preserving'],
    [52, false, 'weakly-supported surfaces. In CVPR.']
  ]), [true, false, true, false]);
  assert.deepEqual(starts([
    [310, false, 'Gold, R., Broderick, A., Younsi, Z., et al. 2019, ApJS'],
    [310, false, 'Gravity Collaboration, Abuter, R., Amorim, A., et al. 2018a, A&A, 615, L15'],
    [310, false, 'Gravity Collaboration, Abuter, R., Amorim, A., et al. 2018b, A&A, 618, L10']
  ]), [true, true, true]);
  // CVPR: authors with initials first, and a company as author
  assert.deepEqual(starts([
    [50, false, 'Y. Cabon, N. Murray, and M. Humenberger. Virtual KITTI 2. arXiv preprint'],
    [50, false, 'arXiv:2001.10773, 2020.'],
    [50, false, 'J. T. Barron. A power transform. arXiv preprint arXiv:2502.10647, 2025.'],
    [50, false, 'Black Forest Labs. FLUX.2: Frontier Visual Intelligence. https://bfl.ai/blog/flux-2, 2025.']
  ]), [true, false, true, true]);
  // AAAI: authors separated by semicolons over several lines, and an accent set apart from
  // its letter ("É" as "E" and a combining accent)
  assert.deepEqual(starts([
    [54, true, 'Transactions on image processing 2(3): 296–310.'],
    [54, false, 'Bouman, K. L.; Johnson, M. D.; Dalca, A. V.; Chael, A. A.;'],
    [54, false, 'Roelofs, F.; Doeleman, S. S.; and Freeman, W. T. 2018. Re-'],
    [54, true, 'constructing video of time-varying sources.']
  ]), [true, true, false, false]);
  assert.deepEqual(starts([
    [43, false, 'Sparks, W. B., Biretta, J. A., & Macchetto, F. 1996, ApJ, 473, 254'],
    [43, false, 'Thie\u0301baut, E\u0301. 2013, in New Concepts in Imaging: Optical and Statistical'],
    [53, false, 'Models, EAS Publications Ser. 59, 157']
  ]), [true, true, false]);
});

test('the first author is read from different reference styles', () => {
  assert.equal(Citations.firstAuthorSurname('Jakob Engel, Vladlen Koltun, and Daniel Cremers. 2017. Direct sparse odometry.'), 'engel');
  assert.equal(Citations.firstAuthorSurname('10. Burger, H.C., Schuler, C.J., Harmeling, S.: Image denoising'), 'burger');
  assert.equal(Citations.firstAuthorSurname('[1] A. Vaswani, N. Shazeer, and N. Parmar. Attention is all you need.'), 'vaswani');
  assert.equal(Citations.firstAuthorSurname('Johannes L. Schönberger. 2016. COLMAP.'), 'schonberger');
  assert.equal(Citations.firstAuthorSurname('Abadie, A. (2002): “Bootstrap tests for distributional treatment effects.”'), 'abadie');
  assert.equal(Citations.firstAuthorSurname('Bartel DP. 2004. MicroRNAs: genomics, biogenesis, mechanism, and function. Cell 116:281–297.'), 'bartel');
  assert.equal(Citations.firstAuthorSurname('Lewis BP, Burge CB, Bartel DP. 2005. Conserved seed pairing.'), 'lewis');
  assert.equal(Citations.firstAuthorSurname('[AFO17] D. Arcara, G. Farkas, and A. Ortega. The strange duality.'), 'arcara');
});

test('rules found across the test papers', () => {
  // A sentence isn't an entry; an organization and the year is
  assert.equal(Citations.looksLikeReference('(3) After solving Eq. (3) to get the optimal weights, as in Ho et al. (2020), we obtain'), false);
  assert.equal(Citations.looksLikeReference('Draco. 2019. . https://google.github.io/draco/'), true);
  // Links to parts of the paper aren't citations, a label link without spaces is
  const entry = 'Peter Kocsis, Vincent Sitzmann, and Matthias Nießner. Intrinsic image diffusion for indoor single-view material estimation. In CVPR, 2024.';
  for (let link of ['Table 2', 'Sect. 2.3.1', '(Proposition 1)', 'Appendix C', 'Fig. A1']) {
    assert.equal(Citations.linkFitsEntry(link, entry), false, link);
  }
  assert.equal(Citations.linkFitsEntry('[Yos99,', '[Yos99] K. Yoshioka, Irreducibility of moduli spaces of vector bundles on K3 surfaces, 1999.'), true);
  // Accents the PDF set apart, in entries and in citations
  assert.equal(Citations.firstAuthorSurname('Gabriel Peyre \u0301, Marco Cuturi, et al. Computational optimal transport, 2019.'), 'peyre');
  assert.equal(Citations.firstAuthorSurname('Oriane Sime \u0301oni, Huy V. Vo, et al. DINOv3, 2025.'), 'simeoni');
  let text = '(Figalli & Glaudo, 2021; Peyr \u0301e et al., 2019) and (Akiyama et al., 2017b;a; 2019), as in [Frahm et al. 2010; Kolev et al. 2014; '
    + 'Newcombe et al. 2011; Pollefeys et al. 2008; Schöps et al. 2015; Tanskanen et al. 2013; Vogiatzis and Hernández 2011; Wendel et al. 2012]';
  let found = plain(Citations.findAuthorYearCitations(text).map(c => text.slice(c.start, c.end)));
  for (let citation of ['Peyr \u0301e et al., 2019', 'a', '2019', 'Wendel et al. 2012']) {
    assert.ok(found.includes(citation), citation);
  }
});

test('a reference list entry is told apart from other text', () => {
  assert.equal(Citations.looksLikeReference('[12] A. Vaswani, N. Shazeer, and N. Parmar. Attention is all you need. In NeurIPS, 2017.'), true);
  assert.equal(Citations.looksLikeReference('Henrik Aanæs, Rasmus Ramsbøl Jensen, and Engin Tola. 2016. Large-scale data for multiple-view stereopsis. IJCV.'), true);
  assert.equal(Citations.looksLikeReference('Zernike, F. 1938, Phy, 785, 5'), true);
  assert.equal(Citations.looksLikeReference('52 Instituto Nacional de Astrofísica, Óptica y Electrónica. Apartado Postal 51 y 216, 72000.'), false);
  assert.equal(Citations.looksLikeReference('2: y Ð A ́1rpAyq d p1  ́ Ωq ` 0 d Ωs'), false);
});

test('links in author-year papers open cards only when the linked entry fits the link text', () => {
  let pairs = JSON.parse(readFileSync(new URL('tests/fixtures/links.json', root), 'utf8'));
  for (let { paper, link, entry, fits } of pairs) {
    assert.equal(Citations.linkFitsEntry(link, entry), fits, `${paper}: ${JSON.stringify(link)} -> ${entry.slice(0, 50)}`);
  }
  let fit = pairs.filter(pair => pair.fits);
  assert.ok(fit.every(pair => Citations.looksLikeReference(pair.entry)));
  assert.ok(pairs.filter(pair => !pair.fits).every(pair => !/et al\.|&/.test(pair.link)));
});

test('hard link cases', () => {
  let fits = (link, entry) => Citations.linkFitsEntry(link, entry);
  // A single author, with no comma after the name
  assert.equal(fits('Vincent', 'Pascal Vincent. A connection between score matching and denoising autoencoders. Neural computation, 23(7):1661–1674, 2011.'), true);
  // A link broken across lines, and one naming only the second author
  assert.equal(fits('Taran-', 'Albert Tarantola. Inverse problem theory and methods for model parameter estimation. SIAM, 2005.'), true);
  assert.equal(fits('Operto', 'Jean Virieux and Stéphane Operto. An overview of full-waveform inversion in exploration geophysics. Geophysics, 74(6), 2009.'), true);
  // The link's year must be the entry's
  assert.equal(fits('2019', 'Yang Song and Stefano Ermon. Generative modeling by estimating gradients of the data distribution. In NeurIPS, 2019.'), true);
  assert.equal(fits('2021', 'Yang Song and Stefano Ermon. Generative modeling by estimating gradients of the data distribution. In NeurIPS, 2019.'), false);
  // A name that isn't among the authors
  assert.equal(fits('Chung et al.', 'Yang Song and Stefano Ermon. Generative modeling by estimating gradients of the data distribution. In NeurIPS, 2019.'), false);
  // Section, figure and equation links
  assert.equal(fits('2', '2 Background In this section, we provide a brief overview of diffusion models (Ho et al., 2020).'), false);
  assert.equal(fits('1', 'Figure 1: Samples from our model compared with Brock et al. (2019), Karras, 2020.'), false);
  // A bare number must be the entry's label
  assert.equal(fits('31', '[31] Jonathan Ho, Ajay Jain, and Pieter Abbeel. Denoising diffusion probabilistic models. NeurIPS, 2020.'), true);
  assert.equal(fits('1', 'Ruojin Cai, Guandao Yang, and Noah Snavely. Learning gradient fields for shape generation. In ECCV, 2020.'), false);
});
