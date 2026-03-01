import * as XLSX from 'xlsx';

export const DEFAULT_FILE = '/Timetable_2026Spring.xlsx';
export const FIXED_YEAR = 2026;
export const STANDARD_TIME_SLOTS = [
  { id: '1', label: '第1节', start: '08:30', end: '10:00' },
  { id: '2', label: '第2节', start: '10:15', end: '11:45' },
  { id: '3', label: '第3节', start: '14:30', end: '16:00' },
  { id: '4', label: '第4节', start: '16:15', end: '17:45' },
  { id: '5', label: '第5节', start: '18:35', end: '20:05' },
  { id: '6', label: '第6节', start: '20:15', end: '21:45' },
];
export const WEEKDAY_LABEL_MAP = {
  0: '周日',
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
};

const CLASS_SHEET_REGEX = /^20\d{2}[A-Z0-9]+$/;
const LANGUAGE_SHEET_REGEX = /(english|german)/i;
const WEEKDAY_NAME_MAP = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
};
const MONTH_MAP = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export const formatNumber = (value) => String(value).padStart(2, '0');
export const cleanCell = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};
const normalizeSessionKey = (value) => cleanCell(value).toLowerCase();

export const formatMonthDay = (date) =>
  date.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  });

export const getWeekdayOffset = (weekday) => (weekday === 0 ? 6 : weekday - 1);
const formatHm = (date) => `${formatNumber(date.getHours())}:${formatNumber(date.getMinutes())}`;
export const getEventSlotKey = (event) => `${formatHm(event.start)}-${formatHm(event.end)}`;

export const parseClassSheetName = (name) => {
  if (!CLASS_SHEET_REGEX.test(name)) return null;
  if (LANGUAGE_SHEET_REGEX.test(name)) return null;
  const grade = name.slice(0, 4);
  const classCode = name.slice(4);
  if (!classCode) return null;
  const majorMatch = classCode.match(/^([A-Z]+)(\d*)$/);
  const major = majorMatch ? majorMatch[1] : classCode;
  return { sheetName: name, grade, classCode, major };
};

export const readWorkbookFromArrayBuffer = (buffer) =>
  XLSX.read(buffer, { cellDates: true });

const formatIcsDate = (date) => {
  return (
    String(date.getFullYear()) +
    formatNumber(date.getMonth() + 1) +
    formatNumber(date.getDate()) +
    'T' +
    formatNumber(date.getHours()) +
    formatNumber(date.getMinutes()) +
    formatNumber(date.getSeconds())
  );
};

const formatIcsDateUtc = (date) => {
  return (
    String(date.getUTCFullYear()) +
    formatNumber(date.getUTCMonth() + 1) +
    formatNumber(date.getUTCDate()) +
    'T' +
    formatNumber(date.getUTCHours()) +
    formatNumber(date.getUTCMinutes()) +
    formatNumber(date.getUTCSeconds()) +
    'Z'
  );
};

const escapeIcsText = (value) => {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
};

const parseTimeRange = (value) => {
  if (!value) return null;
  const match = String(value).match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return {
    start: { h: Number(match[1]), m: Number(match[2]) },
    end: { h: Number(match[3]), m: Number(match[4]) },
  };
};

const parseDateValue = (value, yearOverride) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(
      yearOverride ?? value.getFullYear(),
      value.getMonth(),
      value.getDate()
    );
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    const year = yearOverride ?? parsed.y;
    return new Date(year, parsed.m - 1, parsed.d);
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const match = text.match(/(\d{1,2})\s*([A-Za-z]{3,})/);
  if (match) {
    const day = Number(match[1]);
    const monthKey = match[2].slice(0, 3).toLowerCase();
    const month = MONTH_MAP[monthKey];
    if (month) {
      const year = yearOverride ?? new Date().getFullYear();
      return new Date(year, month - 1, day);
    }
  }
  const fallback = new Date(text);
  if (!Number.isNaN(fallback.getTime())) {
    const year = yearOverride ?? fallback.getFullYear();
    return new Date(year, fallback.getMonth(), fallback.getDate());
  }
  return null;
};

const detectLanguageCourse = (value) => {
  const normalized = cleanCell(value).toLowerCase();
  if (!normalized) return null;
  if (normalized === 'english' || normalized === '英语') return 'english';
  if (normalized === 'german' || normalized === '德语') return 'german';
  return null;
};

export const buildIcs = (events, calendarName) => {
  const now = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Timetable Calendar Export//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'X-LIC-LOCATION:Asia/Shanghai',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'DTSTART:19700101T000000',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  events.forEach((event) => {
    const uid =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${event.summary}-${event.start.getTime()}`;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcsText(uid)}`);
    lines.push(`DTSTAMP:${formatIcsDateUtc(now)}`);
    lines.push(`DTSTART;TZID=Asia/Shanghai:${formatIcsDate(event.start)}`);
    lines.push(`DTEND;TZID=Asia/Shanghai:${formatIcsDate(event.end)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
    if (event.location) {
      lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    }
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    }
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
};

export const parseClassSheet = (sheet, year, classLabel) => {
  if (!sheet) return { events: [], sessions: [], languageSlots: [] };
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  if (rows.length < 3) return { events: [], sessions: [], languageSlots: [] };

  const isSessionHeader = (cell) =>
    typeof cell === 'string' && cell.toLowerCase().includes('session');
  const isDateHeader = (cell) =>
    typeof cell === 'string' && cell.toLowerCase().includes('date');
  const hasTimeCell = (row) => row?.some((cell) => parseTimeRange(cell));

  let headerRowIndex = rows.findIndex(
    (row) => row?.some(isSessionHeader) && row?.some(isDateHeader)
  );
  if (headerRowIndex === -1) {
    headerRowIndex = rows.findIndex(
      (row) => row?.filter(isSessionHeader).length >= 2
    );
  }
  if (headerRowIndex === -1) return { events: [], sessions: [], languageSlots: [] };

  const timeRowOffset = rows
    .slice(headerRowIndex + 1)
    .findIndex((row) => hasTimeCell(row));
  if (timeRowOffset === -1) return { events: [], sessions: [], languageSlots: [] };

  const timeRowIndex = headerRowIndex + 1 + timeRowOffset;
  const headerRow = rows[headerRowIndex] || [];
  const timeRow = rows[timeRowIndex] || [];
  const dataStartIndex = timeRowIndex + 1;

  const dateColIndex =
    headerRow.findIndex(isDateHeader) !== -1
      ? headerRow.findIndex(isDateHeader)
      : 1;

  const sessionCols = [];
  headerRow.forEach((cell, idx) => {
    if (isSessionHeader(cell)) sessionCols.push(idx);
  });

  const sessions = sessionCols.map((col, index) => {
    const timeRange = cleanCell(timeRow[col]);
    const times = parseTimeRange(timeRange);
    return {
      col,
      label: cleanCell(headerRow[col]) || `Session ${index + 1}`,
      sessionKey: normalizeSessionKey(cleanCell(headerRow[col]) || `Session ${index + 1}`),
      timeRange,
      times,
    };
  });

  const events = [];
  const languageSlots = [];
  rows.slice(dataStartIndex).forEach((row) => {
    const dateValue = row?.[dateColIndex];
    const date = parseDateValue(dateValue, year);
    if (!date) return;
    const weekday = date.getDay();

    sessions.forEach((session) => {
      if (!session.times) return;
      const course = cleanCell(row?.[session.col]);
      const start = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        session.times.start.h,
        session.times.start.m
      );
      const end = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        session.times.end.h,
        session.times.end.m
      );
      if (!course || /holiday/i.test(course)) return;

      const language = detectLanguageCourse(course);
      if (language && weekday >= 1 && weekday <= 5) {
        languageSlots.push({
          language,
          classLabel,
          sessionLabel: session.label,
          sessionKey: session.sessionKey,
          weekday,
          start,
          end,
        });
        return;
      }

      const teacher = cleanCell(row?.[session.col + 1]);
      const room = cleanCell(row?.[session.col + 2]);

      const descriptionParts = [`班级: ${classLabel}`, `节次: ${session.label}`];
      if (teacher) descriptionParts.push(`教师: ${teacher}`);
      if (room) descriptionParts.push(`教室: ${room}`);

      events.push({
        summary: course,
        location: room,
        description: descriptionParts.join('\n'),
        start,
        end,
      });
    });
  });

  return { events, sessions, languageSlots };
};

export const findLanguageSheetName = (workbook, grade, language) => {
  if (!workbook || !grade) return '';
  const candidates = workbook.SheetNames.filter((name) =>
    name.toLowerCase().includes(language.toLowerCase())
  );
  if (!candidates.length) return '';
  const exact = candidates.find((name) => name.startsWith(String(grade)));
  if (exact) return exact;
  const includesGrade = candidates.find((name) => name.includes(String(grade)));
  return includesGrade || candidates[0];
};

const parseLanguageEntries = (text, language) => {
  const content = String(text || '').replace(/\r/g, '\n');
  const lines = content
    .split('\n')
    .map((line) => cleanCell(line))
    .filter(Boolean);
  const header =
    lines.find((line) => /20\d{2}/.test(line) && line.includes('&')) || '';
  const entries = [];
  const regex =
    language === 'english'
      ? /([A-Z]{2,}_[0-9]+)\s+([^,\n]+?)\s*,\s*([A-Za-z0-9-]+)/g
      : /(G\d+)\s+([^,\n]+?)\s*,\s*([A-Za-z0-9-]+)/gi;
  let match = regex.exec(content);
  while (match) {
    entries.push({
      code: cleanCell(match[1]).toUpperCase(),
      teacher: cleanCell(match[2]),
      room: cleanCell(match[3]),
    });
    match = regex.exec(content);
  }
  return { header, entries };
};

export const parseLanguageSheet = (sheet, language) => {
  const result = new Map();
  if (!sheet) return result;
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  if (!rows.length) return result;

  const headerRow = rows[0] || [];
  const dayColumns = [];
  headerRow.forEach((cell, col) => {
    const key = cleanCell(cell).toLowerCase();
    if (WEEKDAY_NAME_MAP[key]) {
      dayColumns.push({ col, weekday: WEEKDAY_NAME_MAP[key] });
    }
  });
  if (!dayColumns.length) {
    [1, 2, 3, 4, 5].forEach((weekday, index) => {
      dayColumns.push({ col: index + 2, weekday });
    });
  }

  rows.slice(1).forEach((row) => {
    const sessionLabel = cleanCell(row?.[0]);
    const sessionKey = normalizeSessionKey(sessionLabel);
    const timeRange = cleanCell(row?.[1]);
    if (!sessionKey || !parseTimeRange(timeRange)) return;

    dayColumns.forEach(({ col, weekday }) => {
      const cellText = cleanCell(row?.[col]);
      if (!cellText) return;
      const parsed = parseLanguageEntries(cellText, language);
      if (!parsed.entries.length) return;
      result.set(`${sessionKey}|${weekday}`, parsed);
    });
  });

  return result;
};

export const extractGroupNumber = (code, language) => {
  const normalized = cleanCell(code).toUpperCase();
  if (!normalized) return '';
  if (language === 'german') {
    const match = normalized.match(/^G(\d+)$/);
    return match ? match[1] : '';
  }
  const match = normalized.match(/_(\d+)$/);
  return match ? match[1] : '';
};

export const sortNumericStrings = (values) =>
  [...values].sort((a, b) => Number(a) - Number(b));

const normalizeGermanGroup = (input) => {
  const raw = cleanCell(input).toUpperCase();
  if (!raw) return '';
  return raw.startsWith('G') ? raw : `G${raw}`;
};

const pickGermanEntry = (cell, groupInput, grade, major) => {
  if (!cell) return null;
  const groupCode = normalizeGermanGroup(groupInput);
  if (!groupCode) return null;
  if (cell.header && major) {
    const header = cell.header.replace(/\s+/g, '').toUpperCase();
    const majorToken = `${String(grade)}${cleanCell(major).toUpperCase()}`;
    if (majorToken && !header.includes(majorToken)) return null;
  }
  return cell.entries.find((entry) => entry.code === groupCode) || null;
};

const pickEnglishEntry = (cell, groupInput, major) => {
  if (!cell) return null;
  const raw = cleanCell(groupInput).toUpperCase();
  if (!raw) return null;

  if (raw.includes('_') || /[A-Z]/.test(raw)) {
    return cell.entries.find((entry) => entry.code === raw) || null;
  }

  let candidates = cell.entries.filter((entry) => entry.code.endsWith(`_${raw}`));
  if (!candidates.length) return null;
  const normalizedMajor = cleanCell(major).toUpperCase();
  if (normalizedMajor) {
    const narrowed = candidates.filter((entry) =>
      entry.code.includes(normalizedMajor)
    );
    if (narrowed.length) candidates = narrowed;
  }
  return candidates[0] || null;
};

export const buildPreciseLanguageEvents = ({
  workbook,
  grade,
  major,
  classLabel,
  languageSlots,
  englishGroup,
  germanGroup,
}) => {
  if (!workbook || !languageSlots.length) return { events: [], notes: [] };
  const notes = [];
  const events = [];
  const englishSlots = languageSlots.filter((slot) => slot.language === 'english');
  const germanSlots = languageSlots.filter((slot) => slot.language === 'german');

  if (englishSlots.length) {
    const englishSheetName = findLanguageSheetName(workbook, grade, 'english');
    if (!englishSheetName) {
      notes.push('未找到英语分组工作表，英语课程未加入。');
    } else if (!cleanCell(englishGroup)) {
      notes.push('未填写英语分组，英语课程未加入。');
    } else {
      const englishMap = parseLanguageSheet(workbook.Sheets[englishSheetName], 'english');
      let matchedCount = 0;
      englishSlots.forEach((slot) => {
        const cell = englishMap.get(`${slot.sessionKey}|${slot.weekday}`);
        const entry = pickEnglishEntry(cell, englishGroup, major);
        if (!entry) return;
        matchedCount += 1;
        events.push({
          summary: 'English',
          location: entry.room,
          description: [
            `班级: ${classLabel}`,
            `节次: ${slot.sessionLabel}`,
            `分组: ${entry.code}`,
            entry.teacher ? `教师: ${entry.teacher}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          start: slot.start,
          end: slot.end,
        });
      });
      if (!matchedCount) {
        notes.push('英语分组未匹配到课程，请检查专业和分组填写。');
      }
    }
  }

  if (germanSlots.length) {
    const germanSheetName = findLanguageSheetName(workbook, grade, 'german');
    if (!germanSheetName) {
      notes.push('未找到德语分组工作表，德语课程未加入。');
    } else if (!cleanCell(germanGroup)) {
      notes.push('未填写德语分组，德语课程未加入。');
    } else {
      const germanMap = parseLanguageSheet(workbook.Sheets[germanSheetName], 'german');
      let matchedCount = 0;
      germanSlots.forEach((slot) => {
        const cell = germanMap.get(`${slot.sessionKey}|${slot.weekday}`);
        const entry = pickGermanEntry(cell, germanGroup, grade, major);
        if (!entry) return;
        matchedCount += 1;
        events.push({
          summary: 'German',
          location: entry.room,
          description: [
            `班级: ${classLabel}`,
            `节次: ${slot.sessionLabel}`,
            `分组: ${entry.code}`,
            entry.teacher ? `教师: ${entry.teacher}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          start: slot.start,
          end: slot.end,
        });
      });
      if (!matchedCount) {
        notes.push('德语分组未匹配到课程，请检查专业和分组填写。');
      }
    }
  }

  return { events, notes };
};

export const formatPreviewDate = (date) =>
  date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  });

export const formatDisplayDate = (date) =>
  `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;

export const getWeekStart = (date) => {
  const base = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = base.getDay();
  const diff = (day + 6) % 7;
  base.setDate(base.getDate() - diff);
  base.setHours(0, 0, 0, 0);
  return base;
};

export const getWeekKey = (date) => {
  const start = getWeekStart(date);
  return `${start.getFullYear()}-${formatNumber(start.getMonth() + 1)}-${formatNumber(
    start.getDate()
  )}`;
};

export const formatWeekLabel = (start) => {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${formatPreviewDate(start)} - ${formatPreviewDate(end)}`;
};

export const extractTeacherFromDescription = (description) => {
  const text = String(description || '');
  const match = text.match(/教师:\s*([^\n]+)/);
  return match ? cleanCell(match[1]) : '';
};
