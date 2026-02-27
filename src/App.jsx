import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

const DEFAULT_FILE = '/Timetable_2026Spring.xlsx';
const FIXED_YEAR = 2026;
const SHEET_REGEX = /^(20\d{2})([A-Z]{2,}\d*)$/;
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

const formatNumber = (value) => String(value).padStart(2, '0');

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

const cleanCell = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const buildIcs = (events, calendarName) => {
  const now = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Timetable Calendar Export//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
  ];

  events.forEach((event) => {
    const uid =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${event.summary}-${event.start.getTime()}`;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcsText(uid)}`);
    lines.push(`DTSTAMP:${formatIcsDateUtc(now)}`);
    lines.push(`DTSTART:${formatIcsDate(event.start)}`);
    lines.push(`DTEND:${formatIcsDate(event.end)}`);
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

const parseClassSheet = (sheet, year, classLabel) => {
  if (!sheet) return { events: [], sessions: [] };
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  if (rows.length < 3) return { events: [], sessions: [] };

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
  if (headerRowIndex === -1) return { events: [], sessions: [] };

  const timeRowOffset = rows
    .slice(headerRowIndex + 1)
    .findIndex((row) => hasTimeCell(row));
  if (timeRowOffset === -1) return { events: [], sessions: [] };

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
      timeRange,
      times,
    };
  });

  const events = [];
  rows.slice(dataStartIndex).forEach((row) => {
    const dateValue = row?.[dateColIndex];
    const date = parseDateValue(dateValue, year);
    if (!date) return;

    sessions.forEach((session) => {
      if (!session.times) return;
      const course = cleanCell(row?.[session.col]);
      if (!course || /holiday/i.test(course)) return;
      const teacher = cleanCell(row?.[session.col + 1]);
      const room = cleanCell(row?.[session.col + 2]);

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

  return { events, sessions };
};

const formatPreviewDate = (date) =>
  date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  });

const formatPreviewTime = (date) =>
  date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const getWeekStart = (date) => {
  const base = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = base.getDay();
  const diff = (day + 6) % 7;
  base.setDate(base.getDate() - diff);
  base.setHours(0, 0, 0, 0);
  return base;
};

const getWeekKey = (date) => {
  const start = getWeekStart(date);
  return `${start.getFullYear()}-${formatNumber(start.getMonth() + 1)}-${formatNumber(
    start.getDate()
  )}`;
};

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const formatWeekLabel = (start) => {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${formatPreviewDate(start)} - ${formatPreviewDate(end)}`;
};

export default function App() {
  const [workbook, setWorkbook] = useState(null);
  const [fileName, setFileName] = useState('Timetable_2026Spring.xlsx');
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedClass, setSelectedClass] = useState('');
  const [events, setEvents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState('');
  const [selectedWeek, setSelectedWeek] = useState('');

  const classSheets = useMemo(() => {
    if (!workbook) return [];
    return workbook.SheetNames.map((name) => {
      const match = name.match(SHEET_REGEX);
      if (!match) return null;
      return { sheetName: name, grade: match[1], classCode: match[2] };
    })
      .filter(Boolean)
      .sort((a, b) =>
        a.grade === b.grade
          ? a.classCode.localeCompare(b.classCode)
          : a.grade.localeCompare(b.grade)
      );
  }, [workbook]);

  const gradeOptions = useMemo(() => {
    return [...new Set(classSheets.map((item) => item.grade))].sort();
  }, [classSheets]);

  const classOptions = useMemo(() => {
    if (!selectedGrade) return [];
    return classSheets
      .filter((item) => item.grade === selectedGrade)
      .map((item) => item.classCode);
  }, [classSheets, selectedGrade]);

  const selectedSheet = useMemo(() => {
    return classSheets.find(
      (item) => item.grade === selectedGrade && item.classCode === selectedClass
    );
  }, [classSheets, selectedGrade, selectedClass]);

  const dateRange = useMemo(() => {
    if (!events.length) return null;
    const sorted = [...events].sort((a, b) => a.start - b.start);
    return { start: sorted[0].start, end: sorted[sorted.length - 1].start };
  }, [events]);

  const weekOptions = useMemo(() => {
    if (!events.length) return [];
    const keys = new Map();
    events.forEach((event) => {
      const key = getWeekKey(event.start);
      if (!keys.has(key)) keys.set(key, getWeekStart(event.start));
    });
    return [...keys.values()].sort((a, b) => a - b);
  }, [events]);

  const weeklyEvents = useMemo(() => {
    if (!selectedWeek) return [];
    return events.filter((event) => getWeekKey(event.start) === selectedWeek);
  }, [events, selectedWeek]);

  const weekDays = useMemo(() => {
    if (!selectedWeek) return [];
    const [year, month, day] = selectedWeek.split('-').map(Number);
    const start = new Date(year, month - 1, day);
    return Array.from({ length: 7 }, (_, idx) => {
      const date = new Date(start);
      date.setDate(start.getDate() + idx);
      const dayEvents = weeklyEvents
        .filter((event) => isSameDay(event.start, date))
        .sort((a, b) => a.start - b.start);
      return { date, events: dayEvents };
    });
  }, [selectedWeek, weeklyEvents]);

  const loadWorkbook = async (arrayBuffer, name) => {
    try {
      const wb = XLSX.read(arrayBuffer, { cellDates: true });
      setWorkbook(wb);
      setFileName(name);
      setError('');
    } catch (err) {
      setError('文件解析失败，请确认是有效的 .xlsx 文件。');
      setWorkbook(null);
    }
  };

  const loadDefaultFile = async () => {
    try {
      const response = await fetch(DEFAULT_FILE);
      if (!response.ok) throw new Error('fetch failed');
      const buffer = await response.arrayBuffer();
      await loadWorkbook(buffer, 'Timetable_2026Spring.xlsx');
    } catch (err) {
      setError('示例课表加载失败，请手动选择文件。');
    }
  };

  useEffect(() => {
    loadDefaultFile();
  }, []);

  useEffect(() => {
    if (!gradeOptions.length) return;
    if (!selectedGrade) {
      setSelectedGrade(gradeOptions[0]);
    }
  }, [gradeOptions, selectedGrade]);

  useEffect(() => {
    if (!classOptions.length) return;
    if (!selectedClass || !classOptions.includes(selectedClass)) {
      setSelectedClass(classOptions[0]);
    }
  }, [classOptions, selectedClass]);

  useEffect(() => {
    if (!workbook || !selectedSheet) {
      setEvents([]);
      setSessions([]);
      return;
    }
    const parsed = parseClassSheet(
      workbook.Sheets[selectedSheet.sheetName],
      FIXED_YEAR,
      selectedSheet.sheetName
    );
    setEvents(parsed.events);
    setSessions(parsed.sessions);
  }, [workbook, selectedSheet]);

  useEffect(() => {
    if (!weekOptions.length) {
      setSelectedWeek('');
      return;
    }
    const key = getWeekKey(weekOptions[0]);
    if (!selectedWeek || !weekOptions.some((week) => getWeekKey(week) === selectedWeek)) {
      setSelectedWeek(key);
    }
  }, [weekOptions, selectedWeek]);

  const handleExport = () => {
    if (!events.length || !selectedSheet) return;
    const calendarName = `${selectedSheet.sheetName} 课表`;
    const icsContent = buildIcs(events, calendarName);
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selectedSheet.sheetName}.ics`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <div className="orb orb-1" aria-hidden="true" />
      <div className="orb orb-2" aria-hidden="true" />
      <div className="app">
        <header className="hero">
          <div>
            <h1>BiUH 日历导出</h1>
            <p className="subtitle">
              by MoeLeak
            </p>
          </div>
          <div className="hero-card">
            <div>
              <h3>当前课表</h3>
              <p className="hero-file">{fileName}</p>
            </div>
            <div className="hero-meta">
              <span>班级表数量</span>
              <strong>{classSheets.length}</strong>
            </div>
          </div>
        </header>

        {error ? <div className="alert">{error}</div> : null}

        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="badge">STEP 01</span>
              <h2>选择年级与班级</h2>
              <p>自动识别工作表，支持多学期文件。</p>
            </div>
            <div className="panel-stat">
              <span>可导出课程数</span>
              <strong>{events.length}</strong>
            </div>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>年级</span>
              <select
                value={selectedGrade}
                onChange={(event) => setSelectedGrade(event.target.value)}
              >
                {gradeOptions.map((grade) => (
                  <option key={grade} value={grade}>
                    {grade}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>班级</span>
              <select
                value={selectedClass}
                onChange={(event) => setSelectedClass(event.target.value)}
              >
                {classOptions.map((classCode) => (
                  <option key={classCode} value={classCode}>
                    {classCode}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="session-tags">
            {sessions.map((session) => (
              <span key={session.col}>
                {session.label} · {session.timeRange || '时间待定'}
              </span>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="badge">STEP 02</span>
              <h2>导出到日历</h2>
              <p>生成 .ics 文件，可导入 Apple / Google / Outlook 日历。</p>
            </div>
            <button
              className="primary"
              type="button"
              onClick={handleExport}
              disabled={!events.length}
            >
              导出 .ics
            </button>
          </div>
          <div className="export-meta">
            {dateRange ? (
              <>
                覆盖日期：{formatPreviewDate(dateRange.start)} 至{' '}
                {formatPreviewDate(dateRange.end)}
              </>
            ) : (
              '请选择有效班级以生成日历。'
            )}
          </div>
          <div className="preview">
            <h3>课程预览（按周）</h3>
            {events.length ? (
              <>
                <div className="week-tabs">
                  {weekOptions.map((week) => {
                    const key = getWeekKey(week);
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`week-tab ${key === selectedWeek ? 'active' : ''}`}
                        onClick={() => setSelectedWeek(key)}
                      >
                        {formatWeekLabel(week)}
                      </button>
                    );
                  })}
                </div>
                <div className="week-grid">
                  {weekDays.map((day) => (
                    <div className="week-day" key={day.date.toISOString()}>
                      <div className="week-day-head">
                        <span>{formatPreviewDate(day.date)}</span>
                        <span>{day.events.length} 节</span>
                      </div>
                      {day.events.length ? (
                        <div className="week-day-events">
                          {day.events.map((event, index) => (
                            <div
                              className="week-event"
                              key={`${event.summary}-${index}-${event.start.getTime()}`}
                            >
                              <div>
                                <strong>{event.summary}</strong>
                                <p>
                                  {formatPreviewTime(event.start)} -{' '}
                                  {formatPreviewTime(event.end)}
                                </p>
                              </div>
                              <span className="room">
                                {event.location || '教室待定'}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="preview-empty">当天无课程</p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="preview-empty">暂无课程数据，请确认年级班级选择。</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
