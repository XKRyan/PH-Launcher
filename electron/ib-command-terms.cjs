const SUBJECTS = [
  { id: 'common', label: '常用动作速查', group: '通用', edition: '非官方跨科整理' },
  { id: 'all', label: '全部已收录科目', group: '通用', edition: '各科词表合集' },
  {
    id: 'language-a', label: 'Language A（文学／语言与文学）', group: '语言', edition: '现行指南 · 首考 2026',
    sourceUrl: 'https://www.ibo.org/programmes/diploma-programme/curriculum/language-and-literature/language-a-language-and-literature/',
  },
  {
    id: 'language-b', label: 'Language B', group: '语言', edition: '现行指南 · 首考 2020',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/language-b-guide.pdf',
  },
  {
    id: 'language-ab-initio', label: 'Language ab initio', group: '语言', edition: '现行指南 · 首考 2020',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/language-ab-initio-guide.pdf',
  },
  {
    id: 'math-aa', label: '数学 AA', group: '数学', edition: '现行指南 · 首考 2021',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/dp-mathematics-analysis-and-approaches-guide-en.pdf',
  },
  {
    id: 'math-ai', label: '数学 AI', group: '数学', edition: '现行指南 · 首考 2021',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/dp-mathematics-applications-and-interpretation-guide-en.pdf',
  },
  {
    id: 'biology', label: '生物 Biology', group: '科学', edition: '现行指南 · 首考 2025',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/biology-guide.pdf',
  },
  {
    id: 'chemistry', label: '化学 Chemistry', group: '科学', edition: '现行指南 · 首考 2025',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/chemistry-guide.pdf',
  },
  {
    id: 'physics', label: '物理 Physics', group: '科学', edition: '现行指南 · 首考 2025',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/physics-guide.pdf',
  },
  {
    id: 'ess', label: '环境系统与社会 ESS', group: '科学', edition: '现行指南 · 首考 2026',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/environmental-systems-societies-guide.pdf',
  },
  {
    id: 'economics', label: '经济 Economics', group: '人文与社会', edition: '现行指南 · 首考 2022',
    sourceUrl: 'https://www.ibo.org/programmes/diploma-programme/curriculum/individuals-and-societies/economics/',
  },
  {
    id: 'business', label: '商业管理 Business', group: '人文与社会', edition: '现行指南 · 首考 2024',
    sourceUrl: 'https://www.ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/business-management-guide.pdf',
  },
  {
    id: 'history-through-2027', label: '历史 History（考试至 2027）', group: '人文与社会', edition: '旧课程 · 最后考试 2027',
    sourceUrl: 'https://www.ibo.org/programmes/diploma-programme/curriculum/individuals-and-societies/history/',
  },
  {
    id: 'history-from-2028', label: '历史 History（首考 2028）', group: '人文与社会', edition: '新课程 · 首考 2028',
    sourceUrl: 'https://www-prod.ibo.org/university-admission/latest-curriculum-updates/history-updates/',
  },
  {
    id: 'geography', label: '地理 Geography', group: '人文与社会', edition: '现行指南 · 首考 2019',
    sourceUrl: 'https://www.ibo.org/programmes/diploma-programme/curriculum/individuals-and-societies/geography/',
  },
  {
    id: 'psychology', label: '心理学 Psychology', group: '人文与社会', edition: '新课程 · 首考 2027',
    sourceUrl: 'https://ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/psychology-first-assessment-2027-guide-sbs.pdf',
  },
  {
    id: 'global-politics', label: '全球政治 Global Politics', group: '人文与社会', edition: '现行指南 · 首考 2026',
    sourceUrl: 'https://ibo.org/globalassets/new-structure/university-admission/pdfs/subject-guides/global-politics-guide-first-assessment-2026.pdf',
  },
  {
    id: 'computer-science', label: '计算机科学 Computer Science', group: '其他', edition: '新课程 · 首考 2027',
    sourceUrl: 'https://ibo.org/university-admission/latest-curriculum-updates/computer-science-updates/',
  },
  {
    id: 'visual-arts', label: '视觉艺术 Visual Arts', group: '其他', edition: '新课程 · 首考 2027',
    sourceUrl: 'https://ibo.org/university-admission/latest-curriculum-updates/visual-arts-updates/',
  },
];

const TERMS = {
  analyse: ['Analyse', '分析', '拆开材料或观点，找出关键组成、联系与由此得到的结论。', ['Analyze']],
  annotate: ['Annotate', '标注', '在图、表或材料旁加入简短而有针对性的说明。'],
  apply: ['Apply', '应用', '把概念、规则、理论或方法用于题目给出的具体情境。'],
  calculate: ['Calculate', '计算', '写出必要步骤并得到数值结果；单位和有效数字也要核对。'],
  classify: ['Classify', '分类', '依据清楚的共同特征，把材料放入合适类别。'],
  comment: ['Comment', '评论', '围绕给定陈述或结果作出判断，并指出判断依据。'],
  compare: ['Compare', '比较', '全程对应两个或多个对象，持续说明它们的相似点。'],
  'compare-and-contrast': ['Compare and contrast', '比较与对比', '用同一组维度对应说明相似点与不同点。'],
  complete: ['Complete', '补全', '补上缺失的信息、步骤、数据或图示要素。'],
  construct: ['Construct', '构建', '把信息组织成符合要求的图表、模型、逻辑结构或表达式。'],
  contrast: ['Contrast', '对比', '全程对应两个或多个对象，持续说明它们的不同点。'],
  deduce: ['Deduce', '推断', '只根据已给信息进行推理，得出能够成立的结论。'],
  define: ['Define', '定义', '准确、简洁地说明术语或概念的含义。'],
  demonstrate: ['Demonstrate', '论证／展示', '用推理、证据、例子或实际应用把结论说明清楚。'],
  derive: ['Derive', '推导', '从已知关系逐步变形或推理，得到要求的关系式或结果。'],
  describe: ['Describe', '描述', '有条理地写出对象、过程、趋势或情境的具体特征。'],
  design: ['Design', '设计', '提出能满足目标和约束的方案、方法或实验流程。'],
  determine: ['Determine', '确定', '运用题目信息和方法，得到唯一或明确的答案。'],
  differentiate: ['Differentiate', '求导', '对函数求导，并按题目要求保留过程或形式。'],
  discuss: ['Discuss', '讨论', '呈现多方面论据并加以权衡，最后给出有证据支持的结论。'],
  distinguish: ['Distinguish', '区分', '点明两个或多个概念的关键差异，避免只分别定义。'],
  draw: ['Draw', '准确作图', '按数据和比例画出带必要标签的准确图形或图像。'],
  estimate: ['Estimate', '估算', '使用合理假设或近似，得到接近真实值的结果。'],
  evaluate: ['Evaluate', '评价', '依据证据权衡优势、局限和影响，并作出判断。'],
  examine: ['Examine', '审视', '深入检查观点或概念，揭示假设、关系和可能问题。'],
  explain: ['Explain', '解释', '把原因、机制或因果链写清楚，回答“为什么”或“如何”。'],
  explore: ['Explore', '探究', '从多个角度调查材料或观点，发展并检验可能的理解。'],
  find: ['Find', '求出', '选择合适的方法，得到题目要求的结果。'],
  formulate: ['Formulate', '形成／表述', '把想法整理成清楚、系统且可检验的表达。'],
  hence: ['Hence', '由此', '必须利用前一问或前一步的结果继续作答。'],
  'hence-or-otherwise': ['Hence or otherwise', '由此或另法', '优先使用前一结果继续；也可采用另一种完整而有效的方法。'],
  identify: ['Identify', '识别', '从材料或可能选项中给出正确名称、特征或答案。'],
  integrate: ['Integrate', '积分', '对函数积分，并按题目要求处理常数、范围或应用情境。'],
  interpret: ['Interpret', '解读', '结合知识说明信息的意义、趋势或可得到的结论。'],
  investigate: ['Investigate', '探究', '有系统地观察、计算或检验，以建立事实并形成结论。'],
  justify: ['Justify', '论证理由', '给出足以支持答案或结论的理由、证据或数学过程。'],
  label: ['Label', '加标签', '在图示的正确位置写出名称、变量、单位或其他必要标记。'],
  list: ['List', '列出', '给出一组简短答案；除非题目另有要求，不展开解释。'],
  measure: ['Measure', '测量', '用合适工具、尺度或方法取得所需量值。'],
  outline: ['Outline', '概述', '写出主要特征、阶段或结构，不展开所有细节。'],
  plot: ['Plot', '描点作图', '把数据点放在正确坐标位置，并按要求形成图像。'],
  predict: ['Predict', '预测', '根据规律、模型或证据给出预期结果。'],
  prepare: ['Prepare', '编制', '根据给定信息制作题目要求的账表、报表或其他规范成果。'],
  present: ['Present', '呈现', '用适合题目与受众的形式，清楚地展示所要求的内容。'],
  prove: ['Prove', '证明', '用连贯且严格的逻辑步骤得到要求的结论。'],
  recommend: ['Recommend', '建议', '提出最合适的行动，并用情境证据说明为何这样选。'],
  show: ['Show', '写出过程', '给出足以看出结果如何得到的计算或推导步骤。'],
  'show-that': ['Show that', '证明给定结果', '从题目信息得到指定结果；过程必须完整，不能只重写答案。'],
  sketch: ['Sketch', '示意作图', '画出总体形状或关系，并保留截距、极值、趋势等关键特征。'],
  solve: ['Solve', '求解', '使用代数、数值或图像方法得到所有符合条件的答案。'],
  state: ['State', '陈述', '直接给出名称、数值或简短结论，不额外展开。'],
  suggest: ['Suggest', '提出', '给出一个合理的解释、假设、方案或可能答案。'],
  'to-what-extent': ['To what extent', '在多大程度上', '权衡支持与反对证据，明确主张成立的范围、条件和限度。'],
  trace: ['Trace', '追踪', '按顺序跟随算法、过程或变化，写出关键中间状态与结果。'],
  verify: ['Verify', '验证', '提供计算、推理或证据，确认给定结果成立。'],
  'write-down': ['Write down', '直接写出', '从题目或已有结果直接得到答案，通常不需展示计算。'],
};

function termsByObjective(groups) {
  const records = new Map();
  for (const [objective, keys] of Object.entries(groups)) {
    for (const key of keys) {
      if (!records.has(key)) records.set(key, { key, objectives: [] });
      records.get(key).objectives.push(objective);
    }
  }
  return [...records.values()];
}

function termsWithoutObjective(keys) {
  return keys.map((key) => ({ key, objectives: [] }));
}

const COMMON_TERMS = termsWithoutObjective([
  'analyse', 'compare', 'compare-and-contrast', 'contrast', 'define', 'describe', 'discuss', 'evaluate',
  'examine', 'explain', 'identify', 'justify', 'outline', 'state', 'suggest', 'to-what-extent',
]);

const LANGUAGE_A_TERMS = termsByObjective({
  AO1: ['compare', 'compare-and-contrast', 'contrast', 'describe', 'discuss', 'explain', 'interpret', 'investigate', 'justify', 'to-what-extent'],
  AO2: ['analyse', 'comment', 'compare', 'compare-and-contrast', 'contrast', 'discuss', 'evaluate', 'examine', 'explain', 'explore', 'investigate', 'justify', 'to-what-extent'],
  AO3: ['analyse', 'comment', 'compare', 'compare-and-contrast', 'contrast', 'describe', 'discuss', 'evaluate', 'examine', 'explain', 'explore', 'interpret', 'justify', 'present', 'to-what-extent'],
});

const LANGUAGE_ACQUISITION_TERMS = termsByObjective({
  AO1: ['demonstrate', 'describe', 'present'],
  AO2: ['demonstrate', 'describe', 'explain', 'identify', 'present'],
  AO3: ['demonstrate', 'describe', 'discuss', 'explain', 'identify', 'outline', 'present', 'state'],
  AO4: ['discuss', 'explain', 'outline', 'present', 'state'],
  AO5: ['analyse', 'demonstrate', 'discuss', 'evaluate', 'examine', 'explain', 'identify', 'present'],
});

const MATH_TERMS = termsWithoutObjective([
  'calculate', 'comment', 'compare', 'compare-and-contrast', 'construct', 'contrast', 'deduce',
  'demonstrate', 'describe', 'determine', 'differentiate', 'distinguish', 'draw', 'estimate', 'explain',
  'find', 'hence', 'hence-or-otherwise', 'identify', 'integrate', 'interpret', 'investigate', 'justify',
  'label', 'list', 'plot', 'predict', 'prove', 'show', 'show-that', 'sketch', 'solve', 'state', 'suggest',
  'verify', 'write-down',
]);

const SUBJECT_TERM_ENTRIES = {
  common: COMMON_TERMS,
  'language-a': LANGUAGE_A_TERMS,
  'language-b': LANGUAGE_ACQUISITION_TERMS,
  'language-ab-initio': LANGUAGE_ACQUISITION_TERMS,
  'math-aa': MATH_TERMS,
  'math-ai': MATH_TERMS,
  biology: termsByObjective({
    AO1: ['define', 'draw', 'label', 'list', 'measure', 'state'],
    AO2: ['annotate', 'calculate', 'describe', 'distinguish', 'estimate', 'identify', 'outline'],
    AO3: ['analyse', 'comment', 'compare', 'compare-and-contrast', 'construct', 'deduce', 'design', 'determine', 'discuss', 'evaluate', 'explain', 'justify', 'predict', 'sketch', 'suggest'],
  }),
  chemistry: termsByObjective({
    AO1: ['draw', 'state'],
    AO2: ['annotate', 'calculate', 'describe', 'estimate', 'outline'],
    AO3: ['comment', 'compare', 'contrast', 'deduce', 'determine', 'discuss', 'evaluate', 'explain', 'predict', 'sketch', 'suggest'],
  }),
  physics: termsByObjective({
    AO1: ['draw', 'state'],
    AO2: ['annotate', 'calculate', 'describe', 'estimate', 'outline'],
    AO3: ['analyse', 'determine', 'discuss', 'explain', 'predict', 'show', 'sketch', 'suggest'],
  }),
  ess: termsByObjective({
    AO1: ['define', 'draw', 'label', 'list', 'measure', 'state'],
    AO2: ['annotate', 'apply', 'calculate', 'describe', 'distinguish', 'estimate', 'identify', 'interpret', 'outline'],
    'AO3/4': ['analyse', 'comment', 'compare', 'compare-and-contrast', 'construct', 'contrast', 'deduce', 'demonstrate', 'derive', 'design', 'determine', 'discuss', 'evaluate', 'examine', 'explain', 'justify', 'predict', 'sketch', 'suggest', 'to-what-extent'],
  }),
  economics: termsByObjective({
    AO1: ['define', 'describe', 'list', 'outline', 'state'],
    AO2: ['analyse', 'apply', 'comment', 'distinguish', 'explain', 'suggest'],
    AO3: ['compare', 'compare-and-contrast', 'contrast', 'discuss', 'evaluate', 'examine', 'justify', 'recommend', 'to-what-extent'],
    AO4: ['calculate', 'construct', 'derive', 'determine', 'draw', 'identify', 'label', 'measure', 'plot', 'show', 'show-that', 'sketch', 'solve'],
  }),
  business: termsByObjective({
    AO1: ['define', 'describe', 'identify', 'list', 'outline', 'state'],
    AO2: ['analyse', 'apply', 'comment', 'demonstrate', 'distinguish', 'explain', 'suggest'],
    AO3: ['compare', 'compare-and-contrast', 'contrast', 'discuss', 'evaluate', 'examine', 'justify', 'recommend', 'to-what-extent'],
    AO4: ['annotate', 'calculate', 'complete', 'construct', 'determine', 'draw', 'label', 'plot', 'prepare'],
  }),
  'history-through-2027': termsByObjective({
    AO2: ['analyse'],
    AO3: ['compare-and-contrast', 'discuss', 'evaluate', 'examine', 'to-what-extent'],
  }),
  'history-from-2028': termsWithoutObjective(['analyse', 'discuss', 'examine', 'explain', 'to-what-extent']),
  geography: termsByObjective({
    AO1: ['classify', 'define', 'describe', 'determine', 'estimate', 'identify', 'outline', 'state'],
    AO2: ['analyse', 'distinguish', 'explain', 'suggest'],
    AO3: ['compare', 'compare-and-contrast', 'contrast', 'discuss', 'evaluate', 'examine', 'justify', 'to-what-extent'],
    AO4: ['annotate', 'construct', 'draw', 'label'],
  }),
  psychology: termsByObjective({
    AO1: ['describe', 'state'],
    AO2: ['analyse', 'apply', 'comment', 'design', 'explain', 'interpret', 'predict', 'suggest'],
    AO3: ['compare-and-contrast', 'discuss', 'evaluate', 'examine', 'to-what-extent'],
  }),
  'global-politics': termsByObjective({
    AO1: ['define', 'describe', 'identify', 'list', 'outline'],
    AO2: ['analyse', 'distinguish', 'explain', 'suggest'],
    AO3: ['compare', 'compare-and-contrast', 'contrast', 'discuss', 'evaluate', 'examine', 'justify', 'recommend', 'to-what-extent'],
  }),
  'computer-science': termsByObjective({
    AO1: ['define', 'label', 'list', 'state'],
    AO2: ['calculate', 'describe', 'distinguish', 'estimate', 'identify', 'outline', 'trace'],
    AO3: ['compare', 'construct', 'deduce', 'discuss', 'evaluate', 'explain', 'justify', 'sketch', 'suggest', 'to-what-extent'],
  }),
  'visual-arts': termsWithoutObjective(['analyse', 'demonstrate', 'describe', 'evaluate', 'examine', 'explain', 'justify', 'outline', 'present']),
};

const SUBJECT_TERM_KEYS = Object.fromEntries(
  Object.entries(SUBJECT_TERM_ENTRIES).map(([subjectId, entries]) => [subjectId, entries.map((entry) => entry.key)]),
);

function normalizeSubjectId(value) {
  const subjectId = String(value || '').trim().toLowerCase();
  if (subjectId === 'all') return 'all';
  return SUBJECT_TERM_KEYS[subjectId] ? subjectId : 'common';
}

function termRecord(key, objectives = []) {
  const [term, chinese, action, aliases = []] = TERMS[key];
  const subjectObjectives = Object.fromEntries(
    Object.entries(SUBJECT_TERM_ENTRIES)
      .filter(([, entries]) => entries.some((entry) => entry.key === key))
      .map(([subjectId, entries]) => [
        subjectId,
        [...(entries.find((entry) => entry.key === key)?.objectives || [])],
      ]),
  );
  return {
    id: key,
    term,
    chinese,
    action,
    aliases,
    objectives: [...objectives],
    subjectIds: Object.keys(subjectObjectives),
    subjectObjectives,
  };
}

function listCommandTerms({ subjectId = 'common', query = '' } = {}) {
  const normalizedSubject = normalizeSubjectId(subjectId);
  const entries = normalizedSubject === 'all'
    ? termsWithoutObjective([
      ...new Set(
        Object.entries(SUBJECT_TERM_ENTRIES)
          .filter(([id]) => id !== 'common')
          .flatMap(([, subjectEntries]) => subjectEntries.map((entry) => entry.key)),
      ),
    ])
    : SUBJECT_TERM_ENTRIES[normalizedSubject];
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('zh-CN');
  return entries
    .map((entry) => termRecord(entry.key, entry.objectives))
    .filter((item) => {
      if (!normalizedQuery) return true;
      return [item.term, item.chinese, item.action, ...item.aliases]
        .join(' ')
        .toLocaleLowerCase('zh-CN')
        .includes(normalizedQuery);
    })
    .sort((a, b) => a.term.localeCompare(b.term, 'en'));
}

function commandTermCatalog() {
  return {
    subjects: SUBJECTS.map((subject) => ({ ...subject })),
    terms: listCommandTerms({ subjectId: 'all' }),
    defaultSubjectId: 'common',
    verifiedAt: '2026-09-02',
    note: '按所示课程版本整理；中文说明是原创答题提示，请以任课教师和当前学科指南为准。',
  };
}

module.exports = {
  SUBJECTS,
  SUBJECT_TERM_ENTRIES,
  SUBJECT_TERM_KEYS,
  TERMS,
  commandTermCatalog,
  listCommandTerms,
  normalizeSubjectId,
};
