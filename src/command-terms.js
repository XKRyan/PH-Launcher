(function exposeCommandTerms(root) {
  const definitions = {
    analyse: {
      term: 'Analyse', chinese: '分析',
      englishDefinition: 'Break down in order to bring out the essential elements or structure.',
      chineseDefinition: '为找出基本要素或结构而进行拆解。',
    },
    annotate: {
      term: 'Annotate', chinese: '注释',
      englishDefinition: 'Add brief notes to a diagram or graph.',
      chineseDefinition: '在图示或图表上添加简短说明。',
    },
    apply: {
      term: 'Apply', chinese: '应用',
      englishDefinition: 'Use an idea, equation, principle, theory or law in relation to a given problem or issue.',
      chineseDefinition: '将观点、方程、原理、理论或定律用于给定的问题或议题。',
    },
    calculate: {
      term: 'Calculate', chinese: '计算',
      englishDefinition: 'Obtain a numerical answer showing the relevant stages in the working.',
      chineseDefinition: '得出数值答案，并展示相关运算步骤。',
    },
    classify: {
      term: 'Classify', chinese: '分类',
      englishDefinition: 'Arrange or order by class or category.',
      chineseDefinition: '按类别进行排列或归类。',
    },
    comment: {
      term: 'Comment', chinese: '评论',
      englishDefinition: 'Give a judgement based on a given statement or result of a calculation.',
      chineseDefinition: '基于给定陈述或计算结果作出判断。',
    },
    compare: {
      term: 'Compare', chinese: '比较',
      englishDefinition: 'Give an account of the similarities between two (or more) items or situations, referring to both (all) of them throughout.',
      chineseDefinition: '说明两个或多个事物或情境的相似之处，并在全文中始终涉及双方或所有对象。',
    },
    compareContrast: {
      term: 'Compare and contrast', chinese: '比较与对比',
      englishDefinition: 'Give an account of similarities and differences between two (or more) items or situations, referring to both (all) of them throughout.',
      chineseDefinition: '说明两个或多个事物或情境的相似与不同之处，并在全文中始终涉及双方或所有对象。',
    },
    complete: {
      term: 'Complete', chinese: '补充完整',
      englishDefinition: 'Add missing information or data.',
      chineseDefinition: '添加缺失的信息或数据。',
    },
    construct: {
      term: 'Construct', chinese: '构建',
      englishDefinition: 'Display information in a diagrammatic or logical form.',
      chineseDefinition: '以图示或逻辑形式呈现信息。',
    },
    contrast: {
      term: 'Contrast', chinese: '对比',
      englishDefinition: 'Give an account of the differences between two (or more) items or situations, referring to both (all) of them throughout.',
      chineseDefinition: '说明两个或多个事物或情境的不同之处，并在全文中始终涉及双方或所有对象。',
    },
    deduce: {
      term: 'Deduce', chinese: '推断',
      englishDefinition: 'Reach a conclusion from the information given.',
      chineseDefinition: '根据给定信息得出结论。',
    },
    define: {
      term: 'Define', chinese: '定义',
      englishDefinition: 'Give the precise meaning of a word, phrase, concept or physical quantity.',
      chineseDefinition: '给出词语、短语、概念或物理量的准确含义。',
    },
    demonstrate: {
      term: 'Demonstrate', chinese: '论证',
      englishDefinition: 'Make clear by reasoning or evidence, illustrating with examples or practical application.',
      chineseDefinition: '通过推理或证据，并辅以示例或实际应用，把内容说明清楚。',
    },
    derive: {
      term: 'Derive', chinese: '推导',
      englishDefinition: 'Manipulate a mathematical relationship to give a new equation or relationship.',
      chineseDefinition: '对数学关系进行变换，得到新的方程或关系。',
    },
    describe: {
      term: 'Describe', chinese: '描述',
      englishDefinition: 'Give a detailed account.',
      chineseDefinition: '作出详细说明。',
    },
    design: {
      term: 'Design', chinese: '设计',
      englishDefinition: 'Produce a plan, simulation or model.',
      chineseDefinition: '制定方案、模拟或模型。',
    },
    determine: {
      term: 'Determine', chinese: '确定',
      englishDefinition: 'Obtain the only possible answer.',
      chineseDefinition: '得出唯一可能的答案。',
    },
    differentiate: {
      term: 'Differentiate', chinese: '求导',
      englishDefinition: 'Obtain the derivative of a function.',
      chineseDefinition: '求一个函数的导数。',
    },
    discuss: {
      term: 'Discuss', chinese: '讨论',
      englishDefinition: 'Offer a considered and balanced review that includes a range of arguments, factors or hypotheses. Opinions or conclusions should be presented clearly and supported by appropriate evidence.',
      chineseDefinition: '作出经过思考且平衡的评述，涵盖一系列论点、因素或假设；观点或结论应清晰呈现，并有适当证据支持。',
    },
    distinguish: {
      term: 'Distinguish', chinese: '区分',
      englishDefinition: 'Make clear the differences between two or more concepts or items.',
      chineseDefinition: '明确说明两个或多个概念或事物之间的差异。',
    },
    draw: {
      term: 'Draw', chinese: '绘制',
      englishDefinition: 'Represent by means of a labelled, accurate diagram or graph, using a pencil. A ruler should be used for straight lines. Diagrams should be drawn to scale. Graphs should have points correctly plotted, if appropriate, and joined in a straight line or smooth curve.',
      chineseDefinition: '用铅笔绘制带标签的准确图示或图表；直线应使用直尺，图示应按比例绘制，图表中的点应按要求准确标出并用直线或平滑曲线连接。',
    },
    estimate: {
      term: 'Estimate', chinese: '估算',
      englishDefinition: 'Obtain an approximate value.',
      chineseDefinition: '得出近似值。',
    },
    evaluate: {
      term: 'Evaluate', chinese: '评价',
      englishDefinition: 'Make an appraisal by weighing up the strengths and limitations.',
      chineseDefinition: '通过权衡优点和局限作出评估。',
    },
    examine: {
      term: 'Examine', chinese: '审视',
      englishDefinition: 'Consider an argument or concept in a way that uncovers the assumptions and interrelationships of the issue.',
      chineseDefinition: '以揭示问题中的假设和相互关系的方式审视一个论点或概念。',
    },
    explain: {
      term: 'Explain', chinese: '解释',
      englishDefinition: 'Give a detailed account including reasons or causes.',
      chineseDefinition: '作出详细说明，包括理由或原因。',
    },
    explore: {
      term: 'Explore', chinese: '探索',
      englishDefinition: 'Undertake a systematic process of discovery.',
      chineseDefinition: '开展系统性的发现过程。',
    },
    find: {
      term: 'Find', chinese: '求出',
      englishDefinition: 'Obtain an answer showing relevant stages in the working.',
      chineseDefinition: '得出答案，并展示相关运算步骤。',
    },
    hence: {
      term: 'Hence', chinese: '由此',
      englishDefinition: 'Use the preceding work to obtain the required result.',
      chineseDefinition: '利用前面的结果得出所需结论。',
    },
    henceOtherwise: {
      term: 'Hence or otherwise', chinese: '由此或用其他方法',
      englishDefinition: 'It is suggested that the preceding work is used, but other methods could also receive credit.',
      chineseDefinition: '建议利用前面的结果，但使用其他方法也可以得分。',
    },
    identify: {
      term: 'Identify', chinese: '识别',
      englishDefinition: 'Provide an answer from a number of possibilities.',
      chineseDefinition: '从若干可能选项中给出答案。',
    },
    integrate: {
      term: 'Integrate', chinese: '积分',
      englishDefinition: 'Obtain the integral of a function.',
      chineseDefinition: '求一个函数的积分。',
    },
    interpret: {
      term: 'Interpret', chinese: '解读',
      englishDefinition: 'Use knowledge and understanding to recognize trends and draw conclusions from given information.',
      chineseDefinition: '运用知识和理解识别趋势，并从给定信息中得出结论。',
    },
    investigate: {
      term: 'Investigate', chinese: '调查',
      englishDefinition: 'Observe, study, or make a detailed and systematic examination in order to establish facts and reach new conclusions.',
      chineseDefinition: '通过观察、研究或详细而系统的考察来确认事实并得出新结论。',
    },
    justify: {
      term: 'Justify', chinese: '论证',
      englishDefinition: 'Give valid reasons or evidence to support an answer or conclusion.',
      chineseDefinition: '给出合理理由或证据来支持答案或结论。',
    },
    label: {
      term: 'Label', chinese: '标注',
      englishDefinition: 'Add labels to a diagram.',
      chineseDefinition: '给图示添加标签。',
    },
    list: {
      term: 'List', chinese: '列出',
      englishDefinition: 'Give a sequence of brief answers with no explanation.',
      chineseDefinition: '按顺序给出一系列简短答案，无需解释。',
    },
    measure: {
      term: 'Measure', chinese: '测量',
      englishDefinition: 'Obtain a value for a quantity.',
      chineseDefinition: '取得某个量的值。',
    },
    outline: {
      term: 'Outline', chinese: '概述',
      englishDefinition: 'Give a brief account or summary.',
      chineseDefinition: '给出简要说明或摘要。',
    },
    plot: {
      term: 'Plot', chinese: '标绘',
      englishDefinition: 'Mark the position of points on a diagram.',
      chineseDefinition: '在图中标出各点的位置。',
    },
    predict: {
      term: 'Predict', chinese: '预测',
      englishDefinition: 'Give an expected result.',
      chineseDefinition: '给出预期结果。',
    },
    prepare: {
      term: 'Prepare', chinese: '整理',
      englishDefinition: 'Put given data or information from a stimulus or source into a suitable format.',
      chineseDefinition: '将刺激材料或来源中的给定数据或信息整理为适当格式。',
    },
    present: {
      term: 'Present', chinese: '呈现',
      englishDefinition: 'Offer for display, observation, examination or consideration.',
      chineseDefinition: '提供内容以供展示、观察、检验或思考。',
    },
    prove: {
      term: 'Prove', chinese: '证明',
      englishDefinition: 'Use a sequence of logical steps to obtain the required result in a formal way.',
      chineseDefinition: '用一系列逻辑步骤，以正式方式得出所需结果。',
    },
    recommend: {
      term: 'Recommend', chinese: '建议',
      englishDefinition: 'Present an advisable course of action with appropriate supporting evidence or reason in relation to a given situation, problem or issue.',
      chineseDefinition: '针对给定情境、问题或议题提出可取的行动方案，并提供适当的支持证据或理由。',
    },
    show: {
      term: 'Show', chinese: '展示',
      englishDefinition: 'Give the steps in a calculation or derivation.',
      chineseDefinition: '给出计算或推导的步骤。',
    },
    showThat: {
      term: 'Show that', chinese: '证明结果',
      englishDefinition: 'Obtain the required result, possibly using information given, without the formality of proof. Show that questions do not generally require the use of a calculator.',
      chineseDefinition: '在不作正式证明的情况下得出所需结果，可以使用题目所给信息；这类题目通常不要求使用计算器。',
    },
    sketch: {
      term: 'Sketch', chinese: '草绘',
      englishDefinition: 'Represent by means of a diagram or graph, labelled as appropriate. The sketch should give a general idea of the required shape or relationship and should include relevant features.',
      chineseDefinition: '用图示或图表表示并按需标注；草图应大致呈现所需形状或关系，并包含相关特征。',
    },
    solve: {
      term: 'Solve', chinese: '求解',
      englishDefinition: 'Obtain the answer or answers using algebraic and/or numerical and/or graphical methods.',
      chineseDefinition: '使用代数、数值和／或图形方法得出一个或多个答案。',
    },
    state: {
      term: 'State', chinese: '陈述',
      englishDefinition: 'Give a specific name, value or other brief answer without explanation or calculation.',
      chineseDefinition: '给出具体名称、数值或其他简短答案，无需解释或计算。',
    },
    suggest: {
      term: 'Suggest', chinese: '提出',
      englishDefinition: 'Propose a solution, hypothesis or other possible answer.',
      chineseDefinition: '提出解决方案、假设或其他可能答案。',
    },
    toWhatExtent: {
      term: 'To what extent', chinese: '在何种程度上',
      englishDefinition: 'Consider the merits or otherwise of an argument or concept. Opinions and conclusions should be presented clearly and supported with appropriate evidence and sound argument.',
      chineseDefinition: '思考一个论点或概念的价值或不足；观点与结论应清晰呈现，并以适当证据和可靠论证支持。',
    },
    trace: {
      term: 'Trace', chinese: '追踪',
      englishDefinition: 'Follow and record the actions of an algorithm.',
      chineseDefinition: '跟随并记录一个算法的操作。',
    },
    verify: {
      term: 'Verify', chinese: '验证',
      englishDefinition: 'Provide evidence that validates the result.',
      chineseDefinition: '提供证据来确认结果有效。',
    },
    writeDown: {
      term: 'Write down', chinese: '写出',
      englishDefinition: 'Obtain the answer or answers, usually by extracting information. Little or no calculation is required. Working does not need to be shown.',
      chineseDefinition: '通常通过提取信息得出一个或多个答案；几乎不需要计算，也无需展示过程。',
    },
  };

  const languageATerms = [
    'analyse', 'comment', 'compare', 'compareContrast', 'contrast', 'describe', 'discuss', 'evaluate',
    'examine', 'explain', 'explore', 'interpret', 'investigate', 'justify', 'present', 'toWhatExtent',
  ];
  const essTerms = [
    'define', 'draw', 'label', 'list', 'measure', 'state', 'annotate', 'apply', 'calculate', 'describe',
    'distinguish', 'estimate', 'identify', 'interpret', 'outline', 'analyse', 'comment', 'discuss', 'evaluate',
    'examine', 'explain', 'justify', 'predict', 'sketch', 'suggest', 'toWhatExtent',
  ];
  const mathTerms = [
    'calculate', 'comment', 'compare', 'compareContrast', 'construct', 'contrast', 'deduce', 'demonstrate',
    'describe', 'determine', 'differentiate', 'distinguish', 'draw', 'estimate', 'explain', 'find', 'hence',
    'henceOtherwise', 'identify', 'integrate', 'interpret', 'investigate', 'justify', 'label', 'list', 'plot',
    'predict', 'prove', 'show', 'showThat', 'sketch', 'solve', 'state', 'suggest', 'verify', 'writeDown',
  ];

  const subjects = [
    { id: 'chinese-a', group: '1', label: 'Chinese A', terms: languageATerms },
    { id: 'english-a', group: '1', label: 'English A', terms: languageATerms },
    {
      id: 'english-b', group: '2', label: 'English B',
      terms: ['analyse', 'demonstrate', 'describe', 'discuss', 'evaluate', 'examine', 'explain', 'identify', 'outline', 'present', 'state'],
    },
    {
      id: 'business-management', group: '3', label: 'Business Management',
      terms: ['analyse', 'annotate', 'apply', 'calculate', 'comment', 'compare', 'compareContrast', 'complete', 'construct', 'contrast', 'define', 'demonstrate', 'describe', 'determine', 'discuss', 'distinguish', 'draw', 'evaluate', 'examine', 'explain', 'identify', 'justify', 'label', 'list', 'outline', 'plot', 'prepare', 'recommend', 'state', 'suggest', 'toWhatExtent'],
    },
    {
      id: 'economics', group: '3', label: 'Economics',
      terms: ['analyse', 'apply', 'calculate', 'comment', 'compare', 'compareContrast', 'construct', 'contrast', 'define', 'derive', 'describe', 'determine', 'discuss', 'distinguish', 'draw', 'evaluate', 'examine', 'explain', 'identify', 'justify', 'label', 'list', 'measure', 'outline', 'plot', 'recommend', 'show', 'showThat', 'sketch', 'solve', 'state', 'suggest', 'toWhatExtent'],
    },
    {
      id: 'geography', group: '3', label: 'Geography',
      terms: ['analyse', 'annotate', 'classify', 'compare', 'compareContrast', 'construct', 'contrast', 'define', 'describe', 'determine', 'discuss', 'distinguish', 'draw', 'estimate', 'evaluate', 'examine', 'explain', 'identify', 'justify', 'label', 'outline', 'state', 'suggest', 'toWhatExtent'],
      definitionOverrides: {
        toWhatExtent: {
          englishDefinition: 'Consider the merits or otherwise of an argument or concept. Opinions and conclusions should be presented clearly and supported with empirical evidence and sound argument.',
          chineseDefinition: '思考一个论点或概念的价值或不足；观点与结论应清晰呈现，并以实证证据和可靠论证支持。',
        },
      },
    },
    { id: 'history-2020', group: '3', label: 'History（2020 旧大纲）', syllabus: '旧大纲 · 2020', terms: ['analyse', 'compareContrast', 'discuss', 'evaluate', 'examine', 'toWhatExtent'] },
    { id: 'history-2028', group: '3', label: 'History（2028 新大纲）', syllabus: '新大纲 · 2028', terms: ['analyse', 'discuss', 'examine', 'explain', 'toWhatExtent'] },
    { id: 'philosophy', group: '3', label: 'Philosophy', terms: ['discuss', 'evaluate', 'examine', 'explain', 'explore', 'toWhatExtent'] },
    {
      id: 'psychology', group: '3', label: 'Psychology',
      terms: ['describe', 'state', 'analyse', 'apply', 'comment', 'design', 'explain', 'interpret', 'predict', 'suggest', 'compareContrast', 'discuss', 'evaluate', 'examine', 'toWhatExtent'],
    },
    { id: 'ess', group: '3 / 4', label: 'Environmental Systems and Societies (ESS)', terms: essTerms },
    {
      id: 'biology', group: '4', label: 'Biology',
      terms: ['define', 'draw', 'label', 'list', 'measure', 'state', 'annotate', 'calculate', 'describe', 'distinguish', 'estimate', 'identify', 'outline', 'analyse', 'comment', 'compare', 'compareContrast', 'construct', 'deduce', 'design', 'determine', 'discuss', 'evaluate', 'explain', 'justify', 'predict', 'sketch', 'suggest'],
    },
    {
      id: 'chemistry', group: '4', label: 'Chemistry',
      terms: ['draw', 'state', 'annotate', 'calculate', 'describe', 'estimate', 'outline', 'comment', 'compare', 'contrast', 'deduce', 'determine', 'discuss', 'evaluate', 'explain', 'predict', 'sketch', 'suggest'],
    },
    {
      id: 'computer-science', group: '4', label: 'Computer Science',
      terms: ['calculate', 'compare', 'construct', 'deduce', 'define', 'describe', 'discuss', 'distinguish', 'estimate', 'evaluate', 'explain', 'identify', 'justify', 'label', 'list', 'outline', 'sketch', 'state', 'suggest', 'toWhatExtent', 'trace'],
    },
    {
      id: 'physics', group: '4', label: 'Physics',
      terms: ['draw', 'state', 'annotate', 'calculate', 'describe', 'estimate', 'identify', 'outline', 'analyse', 'deduce', 'determine', 'discuss', 'explain', 'predict', 'show', 'sketch', 'suggest'],
    },
    { id: 'math-aa', group: '5', label: 'Mathematics: Analysis and Approaches (AA)', terms: mathTerms },
    { id: 'math-ai', group: '5', label: 'Mathematics: Applications and Interpretation (AI)', terms: mathTerms },
    { id: 'visual-arts', group: '6', label: 'Visual Arts（无对应指令词）', disabled: true, terms: [] },
    { id: 'music', group: '6', label: 'Music（无对应指令词）', disabled: true, terms: [] },
  ];

  const data = { definitions, subjects };
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.COMMAND_TERMS_DATA = data;
}(typeof globalThis !== 'undefined' ? globalThis : this));
