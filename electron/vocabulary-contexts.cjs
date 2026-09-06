'use strict';

// Original offline example sentences written for PH Launcher.
const CONTEXTS = Object.freeze([
  { word: 'evidence', level: 'foundation', sentence: 'The broken branch provided evidence that strong winds had crossed the valley during the night.' },
  { word: 'assumption', level: 'foundation', sentence: 'Our travel budget rests on the assumption that train prices will remain stable through June.' },
  { word: 'variable', level: 'foundation', sentence: 'The team changed one variable while keeping the water temperature and container size constant.' },
  { word: 'concentration', level: 'foundation', sentence: 'A lower salt concentration allowed more bean seeds to germinate during the classroom investigation.' },
  { word: 'adaptation', level: 'foundation', sentence: 'Thick waxy leaves are an adaptation that helps this coastal plant retain water in summer.' },
  { word: 'scarcity', level: 'foundation', sentence: 'Water scarcity led the town council to repair leaking pipes before building another reservoir.' },
  { word: 'incentive', level: 'foundation', sentence: 'Free morning buses gave families an incentive to leave their cars at home on weekdays.' },
  { word: 'bias', level: 'foundation', sentence: 'The editor checked every headline for bias before publishing the student newspaper online.' },
  { word: 'sustainable', level: 'foundation', sentence: 'The café chose a sustainable menu based on seasonal ingredients from nearby farms.' },
  { word: 'migration', level: 'foundation', sentence: 'Satellite records helped researchers follow the annual migration of whales across the southern ocean.' },

  { word: 'infer', level: 'intermediate', sentence: 'From the empty nests, researchers could infer that the birds had already left the island.' },
  { word: 'justify', level: 'intermediate', sentence: 'Maya used survey results and cost estimates to justify extending library hours during examinations.' },
  { word: 'evaluate', level: 'intermediate', sentence: 'The committee will evaluate each proposal against its cost, accessibility, and likely environmental impact.' },
  { word: 'perspective', level: 'intermediate', sentence: 'A shopkeeper offered a different perspective on how the street closure affected local families.' },
  { word: 'implication', level: 'intermediate', sentence: 'One implication of the warmer winters is that farmers may need to alter planting dates.' },
  { word: 'contrast', level: 'intermediate', sentence: 'The quiet opening creates a sharp contrast with the crowded final scene of the play.' },
  { word: 'ambiguous', level: 'intermediate', sentence: 'Because the instructions were ambiguous, two groups recorded their measurements in different units.' },
  { word: 'coherent', level: 'intermediate', sentence: 'Her revised essay presented a coherent argument linking every example to the central claim.' },
  { word: 'relevant', level: 'intermediate', sentence: 'Please include only relevant observations from the field trip in your final laboratory report.' },
  { word: 'hypothesis', level: 'intermediate', sentence: 'Their hypothesis predicted that shaded soil would retain moisture longer than exposed soil.' },
  { word: 'uncertainty', level: 'intermediate', sentence: 'The engineer reported the measurement uncertainty instead of presenting the bridge dimensions as exact.' },
  { word: 'catalyst', level: 'intermediate', sentence: 'Adding the catalyst shortened the reaction time without changing the final amount of product.' },
  { word: 'diffusion', level: 'intermediate', sentence: 'Food colouring spread through the warm water by diffusion before anyone stirred the beaker.' },
  { word: 'momentum', level: 'intermediate', sentence: 'The campaign gained momentum after several neighbourhood groups volunteered to organize weekend cleanups.' },
  { word: 'proportional', level: 'intermediate', sentence: 'Within the tested range, the spring extension was proportional to the weight attached below.' },
  { word: 'replicate', level: 'intermediate', sentence: 'A second laboratory tried to replicate the result using fresh samples and identical equipment.' },
  { word: 'anomaly', level: 'intermediate', sentence: 'The unusually high reading was treated as an anomaly until the sensor could be checked.' },
  { word: 'inequality', level: 'intermediate', sentence: 'The report connected housing inequality with unequal access to reliable transport and public services.' },
  { word: 'intervention', level: 'intermediate', sentence: 'After the reading intervention, teachers compared progress with results from the previous semester.' },
  { word: 'causation', level: 'intermediate', sentence: 'The researchers warned that a strong correlation did not by itself demonstrate causation.' },

  { word: 'nevertheless', level: 'advanced', sentence: 'The route was longer than expected; nevertheless, the rescue team reached the village before nightfall.' },
  { word: 'equilibrium', level: 'advanced', sentence: 'After several price adjustments, supply and demand moved toward equilibrium in the local market.' },
  { word: 'elasticity', level: 'advanced', sentence: 'The retailer estimated demand elasticity before deciding whether a small price increase would reduce revenue.' },
  { word: 'externality', level: 'advanced', sentence: 'Residents argued that airport noise was an externality ignored by the proposed expansion plan.' },
  { word: 'sovereignty', level: 'advanced', sentence: 'The treaty debate balanced national sovereignty against the benefits of coordinated regional action.' },
  { word: 'disparity', level: 'advanced', sentence: 'The survey revealed a persistent disparity in internet access between central and remote communities.' },
  { word: 'corroborate', level: 'advanced', sentence: 'Investigators used timestamped photographs to corroborate the witness account of the damaged entrance.' },
  { word: 'equivocal', level: 'advanced', sentence: 'The pilot study produced equivocal results, with neither method showing a consistent advantage.' },
  { word: 'inadvertent', level: 'advanced', sentence: 'An inadvertent spreadsheet change removed three responses before the team noticed the mismatch.' },
  { word: 'tenuous', level: 'advanced', sentence: 'The article drew a tenuous connection between two events separated by decades and continents.' },
  { word: 'ostensible', level: 'advanced', sentence: 'The committee questioned whether efficiency was the ostensible reason for closing the community clinic.' },
  { word: 'substantiate', level: 'advanced', sentence: 'Archived receipts helped substantiate her claim that the repairs had been completed on schedule.' },
  { word: 'mitigate', level: 'advanced', sentence: 'Planting trees along the playground could mitigate summer heat without reducing space for sport.' },
  { word: 'exacerbate', level: 'advanced', sentence: 'Cutting the late bus service may exacerbate isolation for residents without private transport.' },
  { word: 'ubiquitous', level: 'advanced', sentence: 'Smartphones became ubiquitous on campus, yet reliable charging points remained surprisingly difficult to find.' },
  { word: 'pragmatic', level: 'advanced', sentence: 'Facing limited funds, the club chose a pragmatic repair instead of replacing every bicycle.' },
  { word: 'empirical', level: 'advanced', sentence: 'The policy review relied on empirical findings from several cities rather than political slogans.' },
  { word: 'delineate', level: 'advanced', sentence: 'The map uses shaded boundaries to delineate areas where seasonal flooding is most likely.' },
  { word: 'reconcile', level: 'advanced', sentence: 'Accountants struggled to reconcile the paper receipts with totals recorded in the shared database.' },
  { word: 'salient', level: 'advanced', sentence: 'The speaker summarized three salient findings before inviting questions from the audience.' },
  { word: 'conjecture', level: 'advanced', sentence: 'Without further excavation, the proposed trade route remains an interesting but untested conjecture.' },
  { word: 'paradigm', level: 'advanced', sentence: 'Remote sensing introduced a new paradigm for monitoring forests across inaccessible mountain regions.' },
  { word: 'plausible', level: 'advanced', sentence: 'Her explanation seemed plausible until the security footage established a different sequence of events.' },
  { word: 'contingent', level: 'advanced', sentence: 'Funding for the field trip remained contingent on receiving written permission from every family.' },
  { word: 'converge', level: 'advanced', sentence: 'The independent estimates converge near the same value despite using different sampling methods.' },
  { word: 'diverge', level: 'advanced', sentence: 'The two forecasts diverge sharply once they apply different assumptions about future energy prices.' },
  { word: 'scrutinize', level: 'advanced', sentence: 'Reviewers will scrutinize the raw data before accepting the surprising conclusion in the report.' },
  { word: 'aggregate', level: 'advanced', sentence: 'The dashboard displays aggregate attendance figures while protecting the identity of individual students.' },
  { word: 'intrinsic', level: 'advanced', sentence: 'Her intrinsic curiosity kept the investigation moving even after the competition had ended.' },
  { word: 'disseminate', level: 'advanced', sentence: 'Local clinics used radio broadcasts to disseminate practical health guidance during the storm.' },
].map((entry) => Object.freeze(entry)));

const BY_WORD = new Map(CONTEXTS.map((entry) => [entry.word, entry]));

function findContext(word) {
  if (typeof word !== 'string') return null;
  return BY_WORD.get(word.trim().toLowerCase()) || null;
}

module.exports = { CONTEXTS, findContext };
