// Original short example sentences written for PH Launcher. Dictionary meanings
// can be enriched locally from ECDICT; these are not an official IB word list.
const groups = {
  '学术表达': [
    ['evidence', '证据；依据', 'The evidence supports a different explanation.'],
    ['assumption', '假设；未经证实的前提', 'Our prediction depends on one important assumption.'],
    ['infer', '推断', 'We can infer the temperature from the change in colour.'],
    ['justify', '证明合理；给出理由', 'Use two sources to justify your conclusion.'],
    ['evaluate', '评价；权衡价值', 'We evaluate the proposal against its costs and benefits.'],
    ['perspective', '视角；观点', 'The interview offers a local perspective on the policy.'],
    ['implication', '可能的影响；含义', 'One implication of this finding is that the model needs revision.'],
    ['contrast', '对比；差异', 'The contrast between the two accounts is striking.'],
    ['ambiguous', '有歧义的；含糊的', 'The ambiguous wording allows two interpretations.'],
    ['coherent', '连贯的；一致的', 'A coherent argument connects each claim to evidence.'],
    ['relevant', '相关的；切题的', 'Only one of these examples is relevant to the question.'],
    ['nevertheless', '尽管如此；然而', 'The sample was small; nevertheless, the pattern was consistent.'],
  ],
  '自然科学': [
    ['hypothesis', '假说；可检验的解释', 'The experiment was designed to test this hypothesis.'],
    ['variable', '变量', 'Only one variable was changed during each trial.'],
    ['uncertainty', '不确定度；不确定性', 'Each measurement includes an estimate of uncertainty.'],
    ['equilibrium', '平衡', 'The system returns to equilibrium after a small disturbance.'],
    ['concentration', '浓度；专注', 'A higher concentration caused the reaction to proceed faster.'],
    ['catalyst', '催化剂', 'The catalyst increases the rate without being consumed overall.'],
    ['diffusion', '扩散', 'Diffusion moves particles down a concentration gradient.'],
    ['adaptation', '适应；适应性特征', 'This adaptation helps the plant survive in dry conditions.'],
    ['momentum', '动量；势头', 'The total momentum remains constant in an isolated system.'],
    ['proportional', '成比例的', 'The extension is proportional to force within the elastic limit.'],
    ['replicate', '重复；复制', 'Another group will replicate the experiment next week.'],
    ['anomaly', '异常；反常现象', 'We repeated the measurement to investigate the anomaly.'],
  ],
  '经济与人文': [
    ['scarcity', '稀缺', 'Scarcity forces people to choose between competing uses of resources.'],
    ['incentive', '激励；诱因', 'The discount provides an incentive to use public transport.'],
    ['elasticity', '弹性', 'Price elasticity measures how strongly demand responds to price.'],
    ['externality', '外部性', 'Noise pollution is a negative externality of the airport.'],
    ['inequality', '不平等；不等式', 'The policy aims to reduce income inequality.'],
    ['intervention', '干预', 'The report compares the outcomes before and after the intervention.'],
    ['bias', '偏见；偏差', 'We examined the source for political bias.'],
    ['sovereignty', '主权', 'The agreement raised questions about national sovereignty.'],
    ['causation', '因果关系', 'A correlation alone does not establish causation.'],
    ['sustainable', '可持续的', 'The city needs a sustainable approach to water use.'],
    ['migration', '迁移；移民', 'The map shows patterns of migration over three decades.'],
    ['disparity', '差距；不均衡', 'The data reveal a large disparity in access to education.'],
  ],
};
function starterPacks() { return Object.entries(groups).map(([subject, words]) => ({ subject, count: words.length })); }
function starterCards(subject) {
  if (!Object.hasOwn(groups, subject)) throw new Error('未知入门词组');
  return groups[subject].map(([word, meaning, context]) => ({ word, meaning, context, subject, source: 'PH Launcher 原创例句' }));
}
module.exports = { starterPacks, starterCards };
