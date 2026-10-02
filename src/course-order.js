(() => {
  'use strict';
  // Pure ordering helpers for the ManageBac course list. Keeping them free of
  // DOM access lets the drag-and-drop behaviour be unit tested.
  function move(order, id, targetId, after) {
    if (!Array.isArray(order)) return [id];
    // Dropping a card onto itself must leave the order untouched.
    if (!targetId || targetId === id) return [...order];
    const list = order.filter((entry) => entry !== id);
    const index = list.indexOf(targetId);
    if (index === -1) return [...list, id];
    list.splice(after ? index + 1 : index, 0, id);
    return list;
  }
  function apply(courses, order, sort, nameOf = (course) => course.name || '') {
    const items = [...courses];
    const byName = (a, b) => String(nameOf(a)).localeCompare(String(nameOf(b)), 'zh-CN');
    if (sort === 'grade') return items.sort((a, b) => String(b.grade || '').localeCompare(String(a.grade || ''), 'zh-CN', { numeric: true }) || byName(a, b));
    if (sort === 'name' || !Array.isArray(order) || !order.length) return items.sort(byName);
    const rank = new Map(order.map((id, index) => [id, index]));
    return items.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ra - rb || byName(a, b);
    });
  }
  window.courseOrder = { move, apply };
})();
