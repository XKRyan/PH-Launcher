const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SUBJECTS, normalizeSubjectId } = require('./ib-command-terms.cjs');
const { normalizeCustomSites } = require('./custom-sites.cjs');
const { isCalendarDate, isCalendarTime, upsertCalendarEvent } = require('./calendar.cjs');
const { filePreview, planDocxWrite, resolveInside } = require('./ai-workspace-tools.cjs');

const SUBJECT_SELECTION_HELP = SUBJECTS
  .filter((subject) => !['common', 'all'].includes(subject.id))
  .map((subject) => `${subject.id}=${subject.label}`)
  .join('；');

const MAX_TASKS_PER_ACTION = 24;
const MAX_LESSONS_PER_ACTION = 100;
const MAX_NOTES_PER_ACTION = 8;
const MAX_CALENDAR_EVENTS_PER_ACTION = 12;
const MAX_SUBMIT_BYTES = 24 * 1024 * 1024;
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
      name: 'create_calendar_events',
      description: '根据用户明确提供或已授权读取的内容，提出添加日程事件的待确认清单。不会立即写入；日期必须包含明确年份并使用 YYYY-MM-DD，时间按内容原文填写，不猜年份、日期或时区。',
      parameters: {
        type: 'object',
        properties: {
          events: {
            type: 'array', minItems: 1, maxItems: MAX_CALENDAR_EVENTS_PER_ACTION,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 120 },
                date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '内容中明确给出的完整日期；不确定年份或日期时不要创建事件。' },
                start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
                end: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
                notes: { type: 'string', maxLength: 4000 },
                repeatWeekdays: { type:'array', maxItems:7, uniqueItems:true, items:{type:'integer',minimum:1,maximum:7}, description:'Weekly recurrence from date; 1=Monday, ... 7=Sunday. Empty means once.' },
                reminderMinutes: { anyOf: [{ type: 'null' }, { type: 'integer', enum: [0, 5, 10, 15, 30, 60] }] },
              },
              required: ['title', 'date', 'start', 'end'], additionalProperties: false,
            },
          },
        },
        required: ['events'], additionalProperties: false,
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

// These are never added unless the user has separately enabled full mode and
// the current request explicitly concerns mail. They are read-only.
const AI_MAIL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_mail',
      description: '读取或按关键词检索学校邮箱 INBOX 中最多 20 封邮件的最小头部。查找旧邮件时先用简短关键词查询主题或正文并分页，再仅对相关结果调用 read_mail；不要检索全校或猜测联系人。',
      parameters: {
        type: 'object',
        properties: {
          unread: { type: 'boolean' },
          query: { type: 'string', maxLength: 80, description: '可选；用于检索邮件主题或正文的简短关键词。' },
          cursor: { type: 'integer', minimum: 0, maximum: 100000 },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_mail',
      description: '读取一封已列出的学校邮箱邮件。敏感账号通知不会返回正文、链接或附件。',
      parameters: {
        type: 'object',
        properties: { uid: { type: 'string', pattern: '^[1-9]\\d{0,9}$' } },
        required: ['uid'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_mail_contacts',
      description: '从当前邮箱已见联系人中搜索最多 10 个姓名和地址；不能发送邮件。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        additionalProperties: false,
      },
    },
  },
];

// Workspace file tools. They only ever touch the folder the user picked in the
// AI panel; reads run immediately, writes are proposed like every other write.
const AI_WORKSPACE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_workspace',
      description: '列出 AI 工作区内的文件（最多 200 个，含子目录）。工作区之外的路径不可访问。',
      parameters: {
        type: 'object',
        properties: { subdir: { type: 'string', maxLength: 200, description: '可选；工作区内的相对子目录。' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_text_file',
      description: '读取工作区内的文本文件（最多 12000 字符）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 300 } },
        required: ['path'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_docx',
      description: '读取工作区内 Word 文档（.docx）的段落文本。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 300 } },
        required: ['path'], additionalProperties: false,
      },
    },
  },
];

// Writes that reach outside the launcher: files, mail, school submissions.
const AI_EXTERNAL_WRITE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_docx',
      description: '提出在工作区新建 Word 文档的方案。只有用户确认后才会写入文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 300, description: '工作区内的相对路径，可省略 .docx。' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          paragraphs: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', maxLength: 20000 } },
        },
        required: ['path', 'title', 'paragraphs'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_to_docx',
      description: '提出向工作区内已有 Word 文档追加段落的方案。只有用户确认后才会写入文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 300 },
          paragraphs: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', maxLength: 20000 } },
        },
        required: ['path', 'paragraphs'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: '提出用学校邮箱发送邮件的方案。收件人必须是完整邮箱地址；只知道姓名时先用 search_mail_contacts 查询。确认后仍会由系统再确认一次才真正发送。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', minLength: 3, maxLength: 500, description: '一个或多个完整邮箱地址，用逗号分隔（最多 5 个）。' },
          subject: { type: 'string', maxLength: 200 },
          body: { type: 'string', minLength: 1, maxLength: 20000 },
        },
        required: ['to', 'subject', 'body'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_managebac_task',
      description: '提出把工作区内的文件提交到 ManageBac 作业的方案。courseId、taskId 必须来自已同步的资料；确认后才能真正提交。',
      parameters: {
        type: 'object',
        properties: {
          courseId: { type: 'string', pattern: '^\\d{1,20}$' },
          taskId: { type: 'string', pattern: '^\\d{1,20}$' },
          filePath: { type: 'string', minLength: 1, maxLength: 300, description: '工作区内的相对路径。' },
        },
        required: ['courseId', 'taskId', 'filePath'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply_discussion',
      description: '提出以学生身份回复一篇 ManageBac 讨论的方案。courseId、discussionId 必须先通过读取讨论列表取得；确认后才会发布。',
      parameters: {
        type: 'object',
        properties: {
          courseId: { type: 'string', pattern: '^\\d{1,20}$' },
          discussionId: { type: 'string', pattern: '^\\d{1,20}$' },
          body: { type: 'string', minLength: 1, maxLength: 4000 },
          private: { type: 'boolean', description: '可选；true 表示发给老师的私密回复。' },
        },
        required: ['courseId', 'discussionId', 'body'], additionalProperties: false,
      },
    },
  },
];

const WRITE_TOOLS = new Set(['create_tasks', 'create_notes', 'create_calendar_events', 'upsert_schedule', 'set_task_status',
  'create_docx', 'append_to_docx', 'send_email', 'submit_managebac_task', 'reply_discussion']);
const COMMAND_TOOLS = new Set(['open_launcher_page', 'open_custom_site', 'control_focus_timer']);
// Effects change something outside the launcher's own data file, so they are
// executed after confirmation instead of being applied to the data snapshot.
const EFFECT_ACTIONS = new Set(['docx-create', 'docx-append', 'send-email', 'submit-task', 'reply-discussion']);

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

function sanitizeCalendarEvents(rawEvents) {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > MAX_CALENDAR_EVENTS_PER_ACTION) {
    throw new Error(`每次只能添加 1–${MAX_CALENDAR_EVENTS_PER_ACTION} 条日程`);
  }
  const seen = new Set();
  const events = [];
  for (const event of rawEvents) {
    const title = typeof event?.title === 'string' ? event.title.trim() : '';
    if (!title || title.length > 120 || /[\u0000\r\n]/.test(title)) throw new Error('日程标题无效');
    const date = event?.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isCalendarDate(date)) throw new Error('日程必须使用明确的 YYYY-MM-DD 日期');
    const start = event?.start; const end = event?.end;
    if (!isCalendarTime(start) || !isCalendarTime(end) || end <= start) throw new Error(`${title} 的起止时间无效`);
    const notes = event?.notes === undefined ? '' : event.notes;
    if (typeof notes !== 'string' || notes.length > 4000 || notes.includes('\u0000')) throw new Error('日程备注无效');
    const reminderMinutes = event?.reminderMinutes === undefined ? null : event.reminderMinutes;
    if (reminderMinutes !== null && ![0, 5, 10, 15, 30, 60].includes(reminderMinutes)) throw new Error('日程提醒时间无效');
    const clean = { title, date, start, end, notes: notes.replaceAll('\r\n', '\n'), reminderMinutes };
    if (event.repeatWeekdays !== undefined) {
      if (!Array.isArray(event.repeatWeekdays) || event.repeatWeekdays.length > 7 || event.repeatWeekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error('每周重复日期无效');
      if (event.repeatWeekdays.length) clean.repeatWeekdays = [...new Set(event.repeatWeekdays)].sort();
    }
    const key = calendarEventKey(clean);
    if (!seen.has(key)) { seen.add(key); events.push(clean); }
  }
  return events;
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

function sanitizeDocxParagraphs(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) throw new Error('每次只能写入 1–500 个段落');
  return raw.map((item) => {
    if (typeof item !== 'string') throw new Error('段落必须是文本');
    const text = item.replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
    if (text.length > 20_000) throw new Error('单个段落过长，请拆分后再写入');
    if (!text.trim()) throw new Error('段落不能为空');
    return text;
  });
}

function cleanWorkspaceArgument(value, name) {
  const text = cleanText(value, 300);
  if (!text) throw new Error('请提供工作区内的文件路径');
  if (/^[a-zA-Z]:/.test(text) || text.startsWith('/') || text.startsWith('\\') || text.startsWith('~')) throw new Error('只能使用工作区内的相对路径');
  if (text.split(/[\\/]+/).includes('..')) throw new Error('路径不能离开工作区');
  if (name === 'create_docx' && !/\.docx$/i.test(text)) return `${text}.docx`;
  return text;
}

function cleanDocumentTitle(value) {
  const title = cleanText(value, 200);
  if (!title) throw new Error('文档标题不能为空');
  return title;
}

const EMAIL_ADDRESS = /^[^\s@,;<>"]+@[^\s@.,;<>"]+\.[^\s@,;<>"]{2,}$/;
function sanitizeRecipients(value) {
  const parts = String(value ?? '').split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw new Error('请提供收件人邮箱地址');
  if (parts.length > 5) throw new Error('一次最多发送给 5 个收件人');
  for (const part of parts) {
    if (part.length > 200 || !EMAIL_ADDRESS.test(part)) throw new Error(`收件人地址无效：${part.slice(0, 60)}`);
  }
  return [...new Set(parts.map((item) => item.toLowerCase()))].join(', ');
}

function cleanSubject(value) {
  const subject = String(value ?? '').replace(/[\r\n\u0000]/g, ' ').trim();
  if (subject.length > 200) throw new Error('邮件主题过长');
  return subject;
}

function cleanMailBody(value) {
  const body = String(value ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new Error('邮件正文不能为空');
  if (body.length > 20_000) throw new Error('邮件正文过长');
  return body;
}

function cleanDiscussionBody(value) {
  const body = String(value ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new Error('回复内容不能为空');
  if (Buffer.byteLength(body, 'utf8') > 12_000) throw new Error('回复内容过长，请精简后再提交');
  return body;
}

function cleanNumericId(value, label) {
  const text = cleanText(value, 20);
  if (!/^\d{1,20}$/.test(text)) throw new Error(`${label}编号无效，请先读取最新资料再试`);
  return text;
}

function sanitizeToolArguments(name, input, data = {}) {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (name === 'create_tasks') return { tasks: sanitizeTasks(args.tasks) };
  if (name === 'create_notes') return { notes: sanitizeNotes(args.notes) };
  if (name === 'create_calendar_events') return { events: sanitizeCalendarEvents(args.events) };
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
  if (name === 'list_workspace') return { subdir: cleanText(args.subdir, 200) };
  if (name === 'read_text_file' || name === 'read_docx') return { path: cleanWorkspaceArgument(args.path, name) };
  if (name === 'create_docx') {
    return { path: cleanWorkspaceArgument(args.path, name), title: cleanDocumentTitle(args.title), paragraphs: sanitizeDocxParagraphs(args.paragraphs) };
  }
  if (name === 'append_to_docx') {
    return { path: cleanWorkspaceArgument(args.path, name), paragraphs: sanitizeDocxParagraphs(args.paragraphs) };
  }
  if (name === 'send_email') {
    return { to: sanitizeRecipients(args.to), subject: cleanSubject(args.subject), body: cleanMailBody(args.body) };
  }
  if (name === 'submit_managebac_task') {
    return { courseId: cleanNumericId(args.courseId, '课程'), taskId: cleanNumericId(args.taskId, '作业'), filePath: cleanWorkspaceArgument(args.filePath, name) };
  }
  if (name === 'reply_discussion') {
    if (args.private !== undefined && typeof args.private !== 'boolean') throw new Error('私密标记无效');
    return { courseId: cleanNumericId(args.courseId, '课程'), discussionId: cleanNumericId(args.discussionId, '讨论'), body: cleanDiscussionBody(args.body), private: args.private === true };
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

function calendarEventKey(event) {
  return [cleanText(event?.title, 120).toLocaleLowerCase('zh-CN'), String(event?.date || ''), String(event?.start || ''), [...(event?.repeatWeekdays || [])].sort().join(',')].join('|');
}

function relevantDataHash(data) {
  const payload = JSON.stringify({
    notes: data?.notes || [],
    tasks: data?.tasks || [],
    schedule: data?.schedule || [],
    calendarEvents: data?.calendarEvents || [],
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function workspaceRootOf(data) {
  const root = data?.settings?.ai?.workspace;
  return typeof root === 'string' ? root.trim() : '';
}

function pathRelative(root, target) {
  return path.relative(fs.realpathSync(root), target).split(path.sep).join('/');
}

function createAction(name, args, data) {
  const sanitized = sanitizeToolArguments(name, args, data);
  if (name === 'create_tasks') return { type: name, tasks: sanitized.tasks };
  if (name === 'create_notes') return { type: name, notes: sanitized.notes };
  if (name === 'create_calendar_events') return { type: name, events: sanitized.events };
  if (name === 'upsert_schedule') return { type: name, lessons: sanitized.lessons };
  if (name === 'set_task_status') return { type: name, ...sanitized };
  if (name === 'create_docx' || name === 'append_to_docx') {
    const plan = planDocxWrite(workspaceRootOf(data), name, sanitized);
    return { type: plan.kind, plan };
  }
  if (name === 'send_email') return { type: 'send-email', ...sanitized };
  if (name === 'submit_managebac_task') {
    const root = workspaceRootOf(data);
    if (!root) throw new Error('请先在 AI 助手页选择工作区文件夹');
    const target = resolveInside(root, sanitized.filePath);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error('工作区里找不到要提交的文件');
    if (!stat.size) throw new Error('要提交的文件是空的');
    if (stat.size > MAX_SUBMIT_BYTES) throw new Error('要提交的文件超过 24 MB 限制');
    return { type: 'submit-task', courseId: sanitized.courseId, taskId: sanitized.taskId, path: target, root: fs.realpathSync(root), relative: pathRelative(root, target), bytes: stat.size, filename: path.basename(target) };
  }
  if (name === 'reply_discussion') return { type: 'reply-discussion', ...sanitized };
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
  if (action.type === 'create_calendar_events') {
    return {
      type: 'calendar-events',
      title: `添加 ${action.events.length} 条日程`,
      items: action.events.map((event) => ({
        primary: event.title,
        secondary: `${event.date} ${event.start}–${event.end}${event.reminderMinutes === null ? '' : ` · 提前 ${event.reminderMinutes} 分钟提醒`}`,
        repeatWeekdays: event.repeatWeekdays || [],
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
  if (EFFECT_ACTIONS.has(action.type)) return effectPreview(action);
  throw new Error('未知写入操作');
}

function effectPreview(action) {
  if (action.type === 'docx-create' || action.type === 'docx-append') return filePreview(action.plan);
  if (action.type === 'send-email') {
    return {
      type: 'email',
      title: `发送邮件给 ${action.to}`,
      items: [{ primary: action.subject || '(无主题)', secondary: `${action.body.length} 字 · 确认后还会再弹出一次系统确认` }],
    };
  }
  if (action.type === 'submit-task') {
    return {
      type: 'managebac-submission',
      title: `提交作业到 ManageBac（课程 ${action.courseId} / 作业 ${action.taskId}）`,
      items: [{ primary: action.relative, secondary: `${Math.ceil(action.bytes / 1024)} KB · 提交后请到 ManageBac 网页确认` }],
    };
  }
  if (action.type === 'reply-discussion') {
    return {
      type: 'managebac-reply',
      title: `${action.private ? '私密回复' : '回复'}讨论（课程 ${action.courseId} / 讨论 ${action.discussionId}）`,
      items: [{ primary: trimText(action.body, 200), secondary: '以你的学生身份发布，发布后可能无法删除' }],
    };
  }
  throw new Error('未知写入操作');
}

function trimText(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Effects run after confirmation; they never touch the launcher data snapshot. */
function effectActions(actions) {
  return (Array.isArray(actions) ? actions : []).filter((action) => EFFECT_ACTIONS.has(action.type));
}

function applyActions(data, actions, now = new Date()) {
  const next = structuredClone(data);
  if (!Array.isArray(next.tasks)) next.tasks = [];
  if (!Array.isArray(next.notes)) next.notes = [];
  if (!Array.isArray(next.schedule)) next.schedule = [];
  if (!Array.isArray(next.calendarEvents)) next.calendarEvents = [];
  const timestamp = now.toISOString();
  const counts = { tasksAdded: 0, notesAdded: 0, calendarEvents: 0, lessonsAdded: 0, lessonsUpdated: 0, unchanged: 0, tasksChanged: 0 };

  for (const action of actions) {
    if (EFFECT_ACTIONS.has(action.type)) continue; // executed after confirmation
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
    } else if (action.type === 'create_calendar_events') {
      for (const event of action.events) {
        if (next.calendarEvents.some((item) => calendarEventKey(item) === calendarEventKey(event))) {
          counts.unchanged += 1;
          continue;
        }
        next.calendarEvents = upsertCalendarEvent(next.calendarEvents, event);
        counts.calendarEvents += 1;
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
    const effects = effectActions(proposal.actions);
    this.pending.delete(proposal.id);
    return { ...result, effects };
  }

  reject(id) {
    this.cleanup();
    return this.pending.delete(String(id || ''));
  }
}

function toolKind(name) {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (COMMAND_TOOLS.has(name)) return 'command';
  if ([...AI_TOOLS, ...AI_MAIL_TOOLS, ...AI_WORKSPACE_TOOLS].some((tool) => tool.function.name === name)) return 'read';
  return 'unknown';
}

module.exports = {
  AI_TOOLS,
  AI_MAIL_TOOLS,
  AI_WORKSPACE_TOOLS,
  AI_EXTERNAL_WRITE_TOOLS,
  EFFECT_ACTIONS,
  PendingActionStore,
  applyActions,
  createAction,
  effectActions,
  effectPreview,
  lessonKey,
  relevantDataHash,
  sanitizeLessons,
  sanitizeCalendarEvents,
  sanitizeToolArguments,
  toolKind,
};
