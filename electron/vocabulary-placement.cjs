'use strict';

// Original, deliberately short orientation questions. They are not a
// standardized test and are only used to suggest a starting catalog filter.
const QUESTIONS = Object.freeze([
  ['basic-1', 'choose', ['解释', '比较', '放弃', '选择'], 3],
  ['basic-2', 'improve', ['改进', '减少', '隐藏', '借用'], 0],
  ['basic-3', 'evidence', ['习惯', '证据', '顺序', '距离'], 1],
  ['basic-4', 'avoid', ['同意', '发现', '避免', '允许'], 2],
  ['academic-1', 'The results support the hypothesis.', ['结果改变了顺序。', '结果支持这个假设。', '结果缺少了样本。', '结果拒绝了方法。'], 1],
  ['academic-2', 'A reliable source can be checked.', ['可靠来源一定很长。', '可靠来源没有作者。', '可靠来源不需要引用。', '可靠来源可以被核查。'], 3],
  ['academic-3', 'The policy may reduce inequality.', ['政策可能减少不平等。', '政策可能增加温度。', '政策必须停止阅读。', '政策已经复制数据。'], 0],
  ['academic-4', 'The data are insufficient to prove causation.', ['数据能快速翻译。', '数据没有任何变量。', '数据不足以证明因果关系。', '数据只来自一篇小说。'], 2],
]);

const LEVELS = Object.freeze(['foundation', 'intermediate', 'advanced']);

function questions() {
  return QUESTIONS.map(([id, prompt, choices]) => ({ id, prompt, choices: [...choices] }));
}

function levelFromExam(exam, rawScore) {
  if (rawScore === null || rawScore === undefined) return null;
  if (typeof rawScore === 'string' && !rawScore.trim()) return null;
  const score = typeof rawScore === 'number' ? rawScore : Number(rawScore);
  if (!Number.isFinite(score)) return null;
  const halfStep = (value) => Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
  if (exam === 'toefl-legacy' && Number.isInteger(score) && score >= 0 && score <= 120) return score < 60 ? 'foundation' : score < 90 ? 'intermediate' : 'advanced';
  if (exam === 'toefl-current' && halfStep(score) && score >= 1 && score <= 6) return score < 3.5 ? 'foundation' : score < 5 ? 'intermediate' : 'advanced';
  if (exam === 'ielts' && halfStep(score) && score >= 0 && score <= 9) return score < 5.5 ? 'foundation' : score < 7 ? 'intermediate' : 'advanced';
  return null;
}

function grade(input = {}) {
  const answers = input.answers && typeof input.answers === 'object' ? input.answers : {};
  const hasQuiz = Object.keys(answers).length > 0;
  if (hasQuiz && !QUESTIONS.every(([id, , choices]) => Object.hasOwn(answers, id) && typeof answers[id] === 'number' && Number.isInteger(answers[id]) && answers[id] >= 0 && answers[id] < choices.length)) throw new Error('请完成全部 8 题后再查看建议');
  const score = hasQuiz ? QUESTIONS.reduce((total, [id,,, answer]) => total + (answers[id] === answer ? 1 : 0), 0) : null;
  const testLevel = score <= 2 ? 'foundation' : score <= 5 ? 'intermediate' : 'advanced';
  const examLevel = levelFromExam(input.exam, input.score);
  const selfLevel = LEVELS.includes(input.level) ? input.level : null;
  return { ...(hasQuiz ? { score, total: QUESTIONS.length } : {}), recommendedLevel: selfLevel || examLevel || (hasQuiz ? testLevel : 'intermediate'),
    source: selfLevel ? 'self' : examLevel ? input.exam : hasQuiz ? 'quiz' : 'default', note: '这是起点建议，不是标准化英语成绩或词汇量测量。' };
}

module.exports = { questions, levelFromExam, grade, LEVELS };
