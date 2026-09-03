const crypto = require('node:crypto');
const { SUBJECTS, normalizeSubjectId } = require('./ib-command-terms.cjs');
const { normalizeCustomSites } = require('./custom-sites.cjs');

const SUBJECT_SELECTION_HELP = SUBJECTS
  .filter((subject) => !['common', 'all'].includes(subject.id))
  .map((subject) => `${subject.id}=${subject.label}`)
  .join('；');

const MAX_TASKS_PER_ACTION = 24;
const MAX_LESSONS_PER_ACTION = 100;
const MAX_NOTES_PER_ACTION = 8;
const PROPOSAL_TTL_MS = 10 * 60_000;

const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_launcher_overview',
      description: '读取 PH Launcher 的今日概览、任务数量、下一节课和本周专注统计。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: '读取启动器中的任务。只在确实需要任务上下文时调用。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'done', 'all'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_schedule',
      description: '读取 PH Launcher 的常规周课程表。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: '按关键词搜索本地笔记。只返回少量匹配笔记，正文会截断。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 80 },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dictionary_lookup',
      description: '使用 PH Launcher 离线英汉词典查词。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 80 } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ib_command_lookup',
      description: '按学科查询 IB 指令词的含义与答题动作。用户提到具体科目时应传入 subject。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 80, description: '可选；留空时返回该科目的完整词表。' },
          subject: {
            type: 'string',
            enum: SUBJECTS.map((subject) => subject.id),
            description: SUBJECT_SELECTION_HELP,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preview_edupage_timetable',
      description: '从用户已经打开并登录的 EduPage 常规课表页面读取课程名、星期、时间和教室。不会读取密码、Cookie 或网页存储。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_tasks',
      description: '提出添加一个或多个任务的方案。调用后不会立即写入，必须由用户确认。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_TASKS_PER_ACTION,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 120 },
                subject: { type: 'string', maxLength: 40 },
                dueAt: { type: 'string', description: 'ISO 8601 日期时间；不确定时留空。' },
                estimateMinutes: { type: 'integer', minimum: 5, maximum: 600 },
                priority: { type: 'string', enum: ['low', 'normal', 'high'] },
                notes: { type: 'string', maxLength: 500 },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_notes',
      description: '提出创建本地笔记的方案。调用后不会立即写入，必须由用户确认。',
      parameters: {
        type: 'object',
        properties: {
          notes: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_NOTES_PER_ACTION,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 120 },
                body: { type: 'string', maxLength: 20000 },
                subject: { type: 'string', maxLength: 40 },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['notes'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_schedule',
      description: '提出向常规周课程表合并课程的方案。不会删除原课程，也不会立即写入，必须由用户确认。',
      parameters: {
        type: 'object',
        properties: {
          lessons: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_LESSONS_PER_ACTION,
            items: {
              type: 'object',
              properties: {
                course: { type: 'string', minLength: 1, maxLength: 60 },
                dayOfWeek: { type: 'integer', minimum: 0, maximum: 6 },
                start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
                end: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
                room: { type: 'string', maxLength: 40 },
                remindMinutes: { type: 'integer', minimum: 0, maximum: 120 },
              },
              required: ['course', 'dayOfWeek', 'start', 'end'],
              additionalProperties: false,
            },
          },
        },
        required: ['lessons'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_task_status',
      description: '提出完成或恢复一个现有任务的方案。必须由用户确认。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', minLength: 1, maxLength: 80 },
          done: { type: 'boolean' },
        },
        required: ['taskId', 'done'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_launcher_page',
      description: '打开 PH Launcher 的指定页面或学校网站。导航可以立即执行，不会提交网页表单。',
      parameters: {
        type: 'object',
        properties: {
          page: {
            type: 'string',
            enum: ['today', 'plan', 'notes', 'dictionary', 'ib', 'ibdocs', 'ai', 'settings', 'mail', 'managebac', 'edupage'],
          },
        },
        required: ['page'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_custom_site',
      description: '按用户已经添加的显示名称打开“我的网页”。只能打开现有条目，不接受网址，也不会提交网页表单。',
      parameters: {
        type: 'object',
        properties: {
          siteName: { type: 'string', minLength: 1, maxLength: 32 },
        },
        required: ['siteName'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_focus_timer',
      description: '开始、暂停或重置 PH Launcher 专注计时器。此操作可以立即执行。',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['start', 'pause', 'reset'] } },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
];

const WRITE_TOOLS = new Set(['create_tasks', 'create_notes', 'upsert_schedule', 'set_task_status']);
const COMMAND_TOOLS = new Set(['open_launcher_page', 'open_custom_site', 'control_focus_timer']);

function cleanText(value, maxLength, fallback = '') {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return (text || fallback).slice(0, maxLength);
}

function cleanTime(value, fieldName) {
  const text = cleanText(value, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error(`${fieldName} 时间格式无效`);
  return text;
}

function cleanIsoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('截止时间无效');
  const year = date.getUTCFullYear();
  if (year < 2020 || year > 2100) throw new Error('截止时间超出支持范围');
  return date.toISOString();
}

function asInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function sanitizeTasks(rawTasks) {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0 || rawTasks.length > MAX_TASKS_PER_ACTION) {
    throw new Error(`每次只能添加 1–${MAX_TASKS_PER_ACTION} 个任务`);
  }
  return rawTasks.map((task) => {
    const title = cleanText(task?.title, 120);
    if (!title) throw new Error('任务名称不能为空');
    return {
      title,
      subject: cleanText(task?.subject, 40, '通用'),
      dueAt: cleanIsoDate(task?.dueAt),
      estimateMinutes: asInteger(task?.estimateMinutes, 30, 5, 600),
      priority: ['low', 'normal', 'high'].includes(task?.priority) ? task.priority : 'normal',
      notes: cleanText(task?.notes, 500),
    };
  });
}

function sanitizeNotes(rawNotes) {
  if (!Array.isArray(rawNotes) || rawNotes.length === 0 || rawNotes.length > MAX_NOTES_PER_ACTION) {
    throw new Error(`每次只能创建 1–${MAX_NOTES_PER_ACTION} 条笔记`);
  }
  return rawNotes.map((note) => {
    const title = cleanText(note?.title, 120);
    if (!title) throw new Error('笔记标题不能为空');
    return {
      title,
      body: cleanText(note?.body, 20_000),
      subject: cleanText(note?.subject, 40, '通用'),
    };
  });
}

function sanitizeLessons(rawLessons, source = 'ai') {
  if (!Array.isArray(rawLessons) || rawLessons.length === 0 || rawLessons.length > MAX_LESSONS_PER_ACTION) {
    throw new Error(`每次只能合并 1–${MAX_LESSONS_PER_ACTION} 节课`);
  }
  const seen = new Set();
  const lessons = [];
  for (const lesson of rawLessons) {
    const course = cleanText(lesson?.course, 60);
    if (!course) throw new Error('课程名称不能为空');
    const dayOfWeek = Number(lesson?.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new Error('课程星期无效');
    const start = cleanTime(lesson?.start, '开始');
    const end = cleanTime(lesson?.end, '结束');
    if (end <= start) throw new Error(`${course} 的结束时间必须晚于开始时间`);
    const clean = {
      course,
      dayOfWeek,
      start,
      end,
      room: cleanText(lesson?.room, 40),
      remindMinutes: asInteger(lesson?.remindMinutes, 10, 0, 120),
      source: source === 'edupage' ? 'edupage' : 'ai',
    };
    clean.sourceKey = source === 'edupage'
      ? `edupage:${clean.dayOfWeek}:${clean.start}:${clean.course.toLocaleLowerCase('zh-CN')}`.slice(0, 180)
      : '';
    const key = lessonKey(clean);
    if (!seen.has(key)) {
      seen.add(key);
      lessons.push(clean);
    }
  }
  return lessons;
}

function sanitizeToolArguments(name, input, data = {}) {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (name === 'create_tasks') return { tasks: sanitizeTasks(args.tasks) };
  if (name === 'create_notes') return { notes: sanitizeNotes(args.notes) };
  if (name === 'upsert_schedule') return { lessons: sanitizeLessons(args.lessons, args.source) };
  if (name === 'set_task_status') {
    const taskId = cleanText(args.taskId, 80);
    const task = (data.tasks || []).find((item) => item.id === taskId);
    if (!task) throw new Error('找不到要修改的任务');
    if (typeof args.done !== 'boolean') throw new Error('任务状态无效');
    return { taskId, done: args.done, title: cleanText(task.title, 120) };
  }
  if (name === 'list_tasks') {
    return {
      status: ['open', 'done', 'all'].includes(args.status) ? args.status : 'open',
      limit: asInteger(args.limit, 30, 1, 50),
    };
  }
  if (name === 'search_notes') return { query: cleanText(args.query, 80), limit: asInteger(args.limit, 6, 1, 10) };
  if (name === 'dictionary_lookup') {
    const query = cleanText(args.query, 80);
    if (!query) throw new Error('查询内容不能为空');
    return { query };
  }
  if (name === 'ib_command_lookup') {
    const query = cleanText(args.query, 80);
    if (!query && !args.subject) throw new Error('请提供指令词或科目');
    return { query, subject: normalizeSubjectId(args.subject || 'all') };
  }
  if (name === 'open_launcher_page') {
    const allowed = ['today', 'plan', 'notes', 'dictionary', 'ib', 'ibdocs', 'ai', 'settings', 'mail', 'managebac', 'edupage'];
    if (!allowed.includes(args.page)) throw new Error('不支持的页面');
    return { page: args.page };
  }
  if (name === 'open_custom_site') {
    const siteName = cleanText(args.siteName, 32);
    if (!siteName) throw new Error('请提供已添加的网页名称');
    const key = siteName.toLocaleLowerCase('zh-CN');
    const matches = normalizeCustomSites(data.settings?.customSites)
      .filter((site) => site.name.toLocaleLowerCase('zh-CN') === key);
    if (!matches.length) throw new Error('找不到这个已添加网页');
    if (matches.length > 1) throw new Error('有多个同名网页，请先在设置中改成不同名称');
    return { siteId: matches[0].id, siteName: matches[0].name };
  }
  if (name === 'control_focus_timer') {
    if (!['start', 'pause', 'reset'].includes(args.action)) throw new Error('不支持的计时器操作');
    return { action: args.action };
  }
  if (['get_launcher_overview', 'list_schedule', 'preview_edupage_timetable'].includes(name)) return {};
  throw new Error('AI 请求了未授权的操作');
}

function lessonKey(lesson) {
  return [
    cleanText(lesson?.course, 60).toLocaleLowerCase('zh-CN'),
    Number(lesson?.dayOfWeek),
    cleanText(lesson?.start, 5),
    cleanText(lesson?.end, 5),
    cleanText(lesson?.room, 40).toLocaleLowerCase('zh-CN'),
  ].join('|');
}

function relevantDataHash(data) {
  const payload = JSON.stringify({
    notes: data?.notes || [],
    tasks: data?.tasks || [],
    schedule: data?.schedule || [],
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function createAction(name, args, data) {
  const sanitized = sanitizeToolArguments(name, args, data);
  if (name === 'create_tasks') return { type: name, tasks: sanitized.tasks };
  if (name === 'create_notes') return { type: name, notes: sanitized.notes };
  if (name === 'upsert_schedule') return { type: name, lessons: sanitized.lessons };
  if (name === 'set_task_status') return { type: name, ...sanitized };
  throw new Error('该操作不能加入写入清单');
}

function actionPreview(action) {
  if (action.type === 'create_tasks') {
    return {
      type: 'tasks',
      title: `添加 ${action.tasks.length} 个任务`,
      items: action.tasks.map((task) => ({
        primary: task.title,
        secondary: [task.subject, task.dueAt ? new Date(task.dueAt).toLocaleString('zh-CN') : '未设截止时间'].filter(Boolean).join(' · '),
      })),
    };
  }
  if (action.type === 'create_notes') {
    return {
      type: 'notes',
      title: `创建 ${action.notes.length} 条笔记`,
      items: action.notes.map((note) => ({ primary: note.title, secondary: `${note.subject} · ${note.body ? `${note.body.length} 字` : '空白笔记'}` })),
    };
  }
  if (action.type === 'upsert_schedule') {
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return {
      type: 'schedule',
      title: `合并 ${action.lessons.length} 节常规课程`,
      items: action.lessons.map((lesson) => ({
        primary: lesson.course,
        secondary: `${dayNames[lesson.dayOfWeek]} ${lesson.start}–${lesson.end}${lesson.room ? ` · ${lesson.room}` : ''}`,
      })),
    };
  }
  if (action.type === 'set_task_status') {
    return {
      type: 'task-status',
      title: action.done ? '完成任务' : '恢复任务',
      items: [{ primary: action.title, secondary: action.done ? '标记为已完成' : '恢复为待处理' }],
    };
  }
  throw new Error('未知写入操作');
}

function applyActions(data, actions, now = new Date()) {
  const next = structuredClone(data);
  if (!Array.isArray(next.tasks)) next.tasks = [];
  if (!Array.isArray(next.notes)) next.notes = [];
  if (!Array.isArray(next.schedule)) next.schedule = [];
  const timestamp = now.toISOString();
  const counts = { tasksAdded: 0, notesAdded: 0, lessonsAdded: 0, lessonsUpdated: 0, unchanged: 0, tasksChanged: 0 };

  for (const action of actions) {
    if (action.type === 'create_tasks') {
      for (const task of action.tasks) {
        const duplicate = next.tasks.some((item) =>
          cleanText(item.title, 120).toLocaleLowerCase('zh-CN') === task.title.toLocaleLowerCase('zh-CN') &&
          String(item.dueAt || '') === task.dueAt,
        );
        if (duplicate) {
          counts.unchanged += 1;
          continue;
        }
        next.tasks.unshift({
          id: crypto.randomUUID(),
          ...task,
          done: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          source: 'ai',
        });
        counts.tasksAdded += 1;
      }
    } else if (action.type === 'create_notes') {
      for (const note of action.notes) {
        next.notes.unshift({
          id: crypto.randomUUID(),
          ...note,
          pinned: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          source: 'ai',
        });
        counts.notesAdded += 1;
      }
    } else if (action.type === 'upsert_schedule') {
      for (const lesson of action.lessons) {
        const exact = next.schedule.find((item) => lessonKey(item) === lessonKey(lesson));
        if (exact) {
          counts.unchanged += 1;
          continue;
        }
        const sourced = lesson.sourceKey
          ? next.schedule.find((item) => item.source === 'edupage' && item.sourceKey === lesson.sourceKey)
          : null;
        if (sourced) {
          Object.assign(sourced, lesson, { enabled: true, syncedAt: timestamp, updatedAt: timestamp });
          counts.lessonsUpdated += 1;
          continue;
        }
        next.schedule.push({
          id: crypto.randomUUID(),
          ...lesson,
          enabled: true,
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(lesson.source === 'edupage' ? { syncedAt: timestamp } : {}),
        });
        counts.lessonsAdded += 1;
      }
    } else if (action.type === 'set_task_status') {
      const task = next.tasks.find((item) => item.id === action.taskId);
      if (!task) throw new Error('任务已经不存在，请重新让 AI 读取任务');
      if (Boolean(task.done) === action.done) {
        counts.unchanged += 1;
        continue;
      }
      task.done = action.done;
      task.completedAt = action.done ? timestamp : '';
      task.updatedAt = timestamp;
      counts.tasksChanged += 1;
    }
  }
  return { data: next, counts };
}

class PendingActionStore {
  constructor({ ttlMs = PROPOSAL_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  cleanup() {
    const now = Date.now();
    for (const [id, proposal] of this.pending) {
      if (proposal.expiresAt <= now) this.pending.delete(id);
    }
  }

  create(actions, data, options = {}) {
    this.cleanup();
    if (!Array.isArray(actions) || actions.length === 0) throw new Error('没有可确认的更改');
    const groups = actions.map(actionPreview);
    const itemCount = groups.reduce((sum, group) => sum + group.items.length, 0);
    if (itemCount > 120) throw new Error('一次更改的项目过多，请分批处理');
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + this.ttlMs;
    const internal = {
      id,
      actions: structuredClone(actions),
      hash: relevantDataHash(data),
      expiresAt,
      title: cleanText(options.title, 80, 'AI 建议的更改'),
      warning: cleanText(options.warning, 240),
    };
    this.pending.set(id, internal);
    return this.preview(internal);
  }

  preview(proposal) {
    return {
      id: proposal.id,
      title: proposal.title,
      groups: proposal.actions.map(actionPreview),
      warning: proposal.warning,
      expiresAt: new Date(proposal.expiresAt).toISOString(),
      requiresConfirmation: true,
    };
  }

  commit(id, data) {
    this.cleanup();
    const proposal = this.pending.get(String(id || ''));
    if (!proposal) throw new Error('这份更改清单已过期或已经处理');
    if (proposal.hash !== relevantDataHash(data)) {
      this.pending.delete(proposal.id);
      throw new Error('数据已发生变化，请让 AI 重新生成更改清单');
    }
    const result = applyActions(data, proposal.actions);
    this.pending.delete(proposal.id);
    return result;
  }

  reject(id) {
    this.cleanup();
    return this.pending.delete(String(id || ''));
  }
}

function toolKind(name) {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (COMMAND_TOOLS.has(name)) return 'command';
  if (AI_TOOLS.some((tool) => tool.function.name === name)) return 'read';
  return 'unknown';
}

module.exports = {
  AI_TOOLS,
  PendingActionStore,
  applyActions,
  createAction,
  lessonKey,
  relevantDataHash,
  sanitizeLessons,
  sanitizeToolArguments,
  toolKind,
};
