(() => {
  'use strict';
  const resources = [
    { id: 'toefl', exam: 'TOEFL', name: ['ETS 托福官方备考', 'ETS official TOEFL preparation'], description: ['样题、备考建议与官方练习入口', 'Sample questions, preparation tips and official practice'], url: 'https://www.ets.org/toefl/test-takers/ibt/prepare.html' },
    { id: 'ielts', exam: 'IELTS', name: ['IELTS 官方备考资源', 'IELTS official preparation'], description: ['样题、写作评分讲解与官方备考资源', 'Sample tests, writing assessment guidance and preparation'], url: 'https://ielts.org/take-a-test/preparation-resources' },
    { id: 'ielts-samples', exam: 'IELTS', name: ['IELTS Academic 官方样题', 'IELTS Academic sample questions'], description: ['学术类听、说、读、写样题', 'Sample questions for Academic listening, speaking, reading and writing'], url: 'https://ielts.org/take-a-test/preparation-resources/sample-test-questions/academic-test' },
    { id: 'sat', exam: 'SAT', name: ['College Board 官方练习', 'College Board official practice'], description: ['数字 SAT 练习、题目与备考指引', 'Digital SAT practice, questions and preparation guidance'], url: 'https://satsuite.collegeboard.org/practice' },
    { id: 'bluebook', exam: 'SAT', name: ['Bluebook 模考与考试应用', 'Bluebook testing and practice app'], description: ['了解官方数字模考及 Bluebook 安装要求', 'Official digital practice and Bluebook installation requirements'], url: 'https://bluebook.collegeboard.org/students' },
    { id: 'khan', exam: 'SAT', name: ['Khan Academy SAT 课程', 'Khan Academy SAT courses'], description: ['数学与阅读写作的分项学习和练习', 'Math and reading/writing lessons and skill practice'], url: 'https://www.khanacademy.org/test-prep/digital-sat' },
    { id: 'act', exam: 'ACT', name: ['ACT 官方备考', 'ACT official test preparation'], description: ['官方练习与考试准备资源', 'Official practice and preparation resources'], url: 'https://www.act.org/content/act/en/products-and-services/the-act/test-preparation.html' },
  ];
  if (typeof module !== 'undefined' && module.exports) { module.exports = { resources }; return; }
  const root = () => document.getElementById('examResources');
  let filter = 'all';
  function render() {
    const host = root(); if (!host) return;
    const en = window.i18n?.locale() === 'en', language = en ? 1 : 0;
    host.setAttribute('translate', 'no');
    host.innerHTML = `<div class="tool-card-head"><div><span>TEST PREPARATION</span><h3>${en ? 'Standardized test resources' : '标化备考资料'}</h3></div></div><p class="tool-explainer">${en ? 'Start with official resources. Check the exam format and date; some resources need an account or payment.' : '优先使用官方资料，核对考试版本和日期。部分资源需要注册或付费。'}</p><div class="exam-filters" role="group" aria-label="${en ? 'Filter by exam' : '按考试筛选'}">${['all','TOEFL','IELTS','SAT','ACT'].map(exam => `<button type="button" class="${exam === filter ? 'active' : ''}" data-exam-filter="${exam}" aria-pressed="${exam === filter}">${exam === 'all' ? en ? 'All' : '全部' : exam}</button>`).join('')}</div><div class="exam-resource-grid">${resources.filter(item => filter === 'all' || item.exam === filter).map(item => `<button type="button" data-exam-resource="${item.id}" class="exam-resource-card"><span class="exam-tag">${item.exam}</span><strong>${item.name[language]}</strong><span>${item.description[language]}</span><small>${new URL(item.url).hostname} ↗</small></button>`).join('')}</div><p class="resource-warning">${en ? 'Links open in your system browser. Launcher does not share school logins or automatically download or purchase materials.' : '在系统浏览器打开，不共享学校登录状态，不自动下载或购买资料。'}</p>`;
  }
  function mount() {
    const host = root(); if (!host) return;
    host.addEventListener('click', async event => {
      const button = event.target.closest('button'); if (!button || !host.contains(button)) return;
      if (button.dataset.examFilter) { filter = button.dataset.examFilter; render(); return; }
      const resource = resources.find(item => item.id === button.dataset.examResource); if (!resource) return;
      try { await window.ph.system.openUrl(resource.url); }
      catch { window.toast?.(window.i18n?.locale() === 'en' ? 'Could not open this resource. Check your network or try later.' : '资源暂时无法打开，请检查网络或稍后重试。', 'error'); }
    });
    window.addEventListener('ph:language-changed', render);
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
