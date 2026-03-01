import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_FILE,
  FIXED_YEAR,
  STANDARD_TIME_SLOTS,
  WEEKDAY_LABEL_MAP,
  buildIcs,
  buildPreciseLanguageEvents,
  extractGroupNumber,
  extractTeacherFromDescription,
  findLanguageSheetName,
  formatDisplayDate,
  formatMonthDay,
  formatWeekLabel,
  getEventSlotKey,
  getWeekKey,
  getWeekStart,
  getWeekdayOffset,
  parseClassSheet,
  parseClassSheetName,
  parseLanguageSheet,
  readWorkbookFromArrayBuffer,
  sortNumericStrings,
} from './lib/timetable.js';
import {
  hasSeenSetupPrompt,
  loadStoredSettings,
  markSetupPromptSeen,
  resetStoredSettings,
  saveStoredSettings,
} from './lib/storage.js';

const COURSE_TONES = [
  { bg: '#6b1f3a', border: '#f5a8bf', text: '#fff6f8' },
  { bg: '#1f4e7a', border: '#8cc8ff', text: '#edf6ff' },
  { bg: '#1f6b56', border: '#8ce0c1', text: '#edfff7' },
  { bg: '#5a3d1c', border: '#f8ca8c', text: '#fff7ed' },
  { bg: '#4c2d71', border: '#d5b4ff', text: '#f9f0ff' },
  { bg: '#6a2f2f', border: '#f5adad', text: '#fff2f2' },
];

const hashCourseName = (value) => {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const getCourseTone = (summary) => {
  const index = hashCourseName(summary) % COURSE_TONES.length;
  return COURSE_TONES[index];
};

const formatMetaDate = (value) => {
  if (!value) return '未知';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '未知';
  return parsed.toLocaleString('zh-CN', { hour12: false });
};

function Modal({ title, onClose, children, actions, panelClassName = '' }) {
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef(null);

  const requestClose = useCallback(() => {
    if (closeTimerRef.current) return;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 170);
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className={`modal-backdrop ${isClosing ? 'closing' : ''}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <section
        className={`modal-panel ${panelClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={requestClose} aria-label="关闭">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </section>
    </div>
  );
}

export default function App() {
  const storedSettings = useMemo(() => loadStoredSettings(), []);
  const firstRunPromptedRef = useRef(false);
  const weekInitRef = useRef(false);
  const swipeRef = useRef(null);
  const dragOffsetRef = useRef(0);

  const [workbook, setWorkbook] = useState(null);
  const [fileName, setFileName] = useState('Timetable_2026Spring.xlsx');
  const [sourceLabel, setSourceLabel] = useState(DEFAULT_FILE);
  const [buildDateText, setBuildDateText] = useState('未知');
  const [selectedGrade, setSelectedGrade] = useState(storedSettings.selectedGrade || '');
  const [selectedMajor, setSelectedMajor] = useState(storedSettings.selectedMajor || '');
  const [selectedClass, setSelectedClass] = useState(storedSettings.selectedClass || '');
  const [germanGroup, setGermanGroup] = useState(storedSettings.germanGroup || '');
  const [englishGroup, setEnglishGroup] = useState(storedSettings.englishGroup || '');
  const [selectedWeek, setSelectedWeek] = useState(storedSettings.selectedWeek || '');

  const [events, setEvents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [languageNotes, setLanguageNotes] = useState([]);
  const [error, setError] = useState('');

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isWeekPickerOpen, setIsWeekPickerOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const classSheets = useMemo(() => {
    if (!workbook) return [];
    return workbook.SheetNames.map((name) => parseClassSheetName(name))
      .filter(Boolean)
      .sort((a, b) =>
        a.grade === b.grade
          ? a.major === b.major
            ? a.classCode.localeCompare(b.classCode)
            : a.major.localeCompare(b.major)
          : a.grade.localeCompare(b.grade)
      );
  }, [workbook]);

  const gradeOptions = useMemo(
    () => [...new Set(classSheets.map((item) => item.grade))].sort(),
    [classSheets]
  );

  const majorOptions = useMemo(() => {
    if (!selectedGrade) return [];
    return [
      ...new Set(
        classSheets
          .filter((item) => item.grade === selectedGrade)
          .map((item) => item.major)
      ),
    ].sort();
  }, [classSheets, selectedGrade]);

  const classOptions = useMemo(() => {
    if (!selectedGrade || !selectedMajor) return [];
    return classSheets
      .filter(
        (item) => item.grade === selectedGrade && item.major === selectedMajor
      )
      .map((item) => item.classCode);
  }, [classSheets, selectedGrade, selectedMajor]);

  const selectedSheet = useMemo(() => {
    return classSheets.find(
      (item) =>
        item.grade === selectedGrade &&
        item.major === selectedMajor &&
        item.classCode === selectedClass
    );
  }, [classSheets, selectedGrade, selectedMajor, selectedClass]);

  const englishSheetName = useMemo(
    () => findLanguageSheetName(workbook, selectedGrade, 'english'),
    [workbook, selectedGrade]
  );
  const germanSheetName = useMemo(
    () => findLanguageSheetName(workbook, selectedGrade, 'german'),
    [workbook, selectedGrade]
  );

  const englishLanguageMap = useMemo(() => {
    if (!workbook || !englishSheetName) return new Map();
    return parseLanguageSheet(workbook.Sheets[englishSheetName], 'english');
  }, [workbook, englishSheetName]);

  const germanLanguageMap = useMemo(() => {
    if (!workbook || !germanSheetName) return new Map();
    return parseLanguageSheet(workbook.Sheets[germanSheetName], 'german');
  }, [workbook, germanSheetName]);

  const englishGroupOptions = useMemo(() => {
    const options = new Set();
    englishLanguageMap.forEach((cell) => {
      cell.entries.forEach((entry) => {
        if (selectedMajor && !entry.code.includes(selectedMajor)) return;
        const groupNo = extractGroupNumber(entry.code, 'english');
        if (groupNo) options.add(groupNo);
      });
    });
    return sortNumericStrings(options);
  }, [englishLanguageMap, selectedMajor]);

  const germanGroupOptions = useMemo(() => {
    const options = new Set();
    const majorToken = `${String(selectedGrade)}${String(selectedMajor || '').toUpperCase()}`;
    germanLanguageMap.forEach((cell) => {
      if (cell.header && majorToken) {
        const header = cell.header.replace(/\s+/g, '').toUpperCase();
        if (!header.includes(majorToken)) return;
      }
      cell.entries.forEach((entry) => {
        const groupNo = extractGroupNumber(entry.code, 'german');
        if (groupNo) options.add(groupNo);
      });
    });
    return sortNumericStrings(options);
  }, [germanLanguageMap, selectedGrade, selectedMajor]);

  const weekOptions = useMemo(() => {
    if (!events.length) return [];
    const keys = new Map();
    events.forEach((event) => {
      const key = getWeekKey(event.start);
      if (!keys.has(key)) keys.set(key, getWeekStart(event.start));
    });
    return [...keys.values()].sort((a, b) => a - b);
  }, [events]);

  const selectedWeekIndex = useMemo(() => {
    return weekOptions.findIndex((week) => getWeekKey(week) === selectedWeek);
  }, [weekOptions, selectedWeek]);

  const selectedWeekStart = useMemo(() => {
    if (selectedWeekIndex >= 0) return weekOptions[selectedWeekIndex];
    return weekOptions[0] || null;
  }, [selectedWeekIndex, weekOptions]);

  const weeklyEvents = useMemo(() => {
    if (!selectedWeekStart) return [];
    const key = getWeekKey(selectedWeekStart);
    return events.filter((event) => getWeekKey(event.start) === key);
  }, [events, selectedWeekStart]);

  const weekColumns = useMemo(() => {
    if (!selectedWeekStart) return [];
    const monday = new Date(selectedWeekStart);
    const includeSaturday = weeklyEvents.some((event) => event.start.getDay() === 6);
    const includeSunday = weeklyEvents.some((event) => event.start.getDay() === 0);
    const hasWeekendCourse = includeSaturday || includeSunday;
    const weekdays = [1, 2, 3, 4, 5];
    if (hasWeekendCourse) weekdays.push(6, 0);

    return weekdays.map((weekday) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + getWeekdayOffset(weekday));
      return { weekday, label: WEEKDAY_LABEL_MAP[weekday], date };
    });
  }, [selectedWeekStart, weeklyEvents]);

  const weeklyEventMap = useMemo(() => {
    const map = new Map();
    weeklyEvents.forEach((event) => {
      const key = `${event.start.getDay()}|${getEventSlotKey(event)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(event);
    });
    map.forEach((items) =>
      items.sort((a, b) =>
        a.start - b.start || a.summary.localeCompare(b.summary, 'zh-Hans-CN')
      )
    );
    return map;
  }, [weeklyEvents]);

  const displayDate = selectedWeekStart ? formatDisplayDate(selectedWeekStart) : formatDisplayDate(new Date());
  const displayWeekNo = selectedWeekIndex >= 0 ? selectedWeekIndex + 1 : 1;

  const applyDragOffset = (value) => {
    dragOffsetRef.current = value;
    setDragOffset(value);
  };

  const shiftWeek = (offset) => {
    if (!weekOptions.length || selectedWeekIndex < 0) return false;
    const target = Math.max(0, Math.min(weekOptions.length - 1, selectedWeekIndex + offset));
    if (target === selectedWeekIndex) return false;
    setSelectedWeek(getWeekKey(weekOptions[target]));
    return true;
  };

  const handleSwipeStart = (event) => {
    if (!event.touches?.length) return;
    const touch = event.touches[0];
    swipeRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      locked: false,
      horizontal: false,
    };
    setIsDragging(false);
    applyDragOffset(0);
  };

  const handleSwipeMove = (event) => {
    if (!swipeRef.current || !event.touches?.length) return;
    const touch = event.touches[0];
    const dx = touch.clientX - swipeRef.current.x;
    const dy = touch.clientY - swipeRef.current.y;

    if (!swipeRef.current.locked) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipeRef.current.locked = true;
      swipeRef.current.horizontal = Math.abs(dx) > Math.abs(dy);
    }

    if (!swipeRef.current.horizontal) return;

    const canShiftPrev = selectedWeekIndex > 0;
    const canShiftNext = selectedWeekIndex >= 0 && selectedWeekIndex < weekOptions.length - 1;
    let displayDx = dx;
    if ((dx > 0 && !canShiftPrev) || (dx < 0 && !canShiftNext)) {
      displayDx *= 0.35;
    }
    displayDx = Math.max(-140, Math.min(140, displayDx));

    if (!isDragging) setIsDragging(true);
    applyDragOffset(displayDx);
  };

  const handleSwipeCancel = () => {
    swipeRef.current = null;
    setIsDragging(false);
    applyDragOffset(0);
  };

  const handleSwipeEnd = (event) => {
    if (!swipeRef.current || !event.changedTouches?.length) {
      handleSwipeCancel();
      return;
    }
    const wasHorizontal = swipeRef.current.horizontal;
    swipeRef.current = null;

    if (!wasHorizontal) {
      handleSwipeCancel();
      return;
    }

    const finalOffset = dragOffsetRef.current;
    const threshold = 56;
    const direction = finalOffset <= -threshold ? 1 : finalOffset >= threshold ? -1 : 0;
    const shifted = direction ? shiftWeek(direction) : false;

    setIsDragging(false);
    if (shifted) {
      applyDragOffset(direction > 0 ? -84 : 84);
      requestAnimationFrame(() => applyDragOffset(0));
      return;
    }
    applyDragOffset(0);
  };

  useEffect(() => {
    const loadDefaultFile = async () => {
      try {
        const response = await fetch(DEFAULT_FILE);
        if (!response.ok) throw new Error('fetch failed');
        const buffer = await response.arrayBuffer();
        const wb = readWorkbookFromArrayBuffer(buffer);
        const headerBuildDate = response.headers.get('last-modified');
        const workbookBuildDate = wb?.Props?.ModifiedDate || wb?.Props?.CreatedDate;

        setWorkbook(wb);
        setFileName('Timetable_2026Spring.xlsx');
        // setSourceLabel(`Timetable_2026Spring.xlsx (${DEFAULT_FILE})`);
        setBuildDateText(formatMetaDate(workbookBuildDate || headerBuildDate));
        setError('');
      } catch (err) {
        setError('示例课表加载失败，请检查文件路径。');
      }
    };
    loadDefaultFile();
  }, []);

  useEffect(() => {
    if (!gradeOptions.length) return;
    if (!selectedGrade || !gradeOptions.includes(selectedGrade)) {
      setSelectedGrade(gradeOptions[0]);
    }
  }, [gradeOptions, selectedGrade]);

  useEffect(() => {
    if (!majorOptions.length) return;
    if (!selectedMajor || !majorOptions.includes(selectedMajor)) {
      setSelectedMajor(majorOptions[0]);
    }
  }, [majorOptions, selectedMajor]);

  useEffect(() => {
    if (!classOptions.length) return;
    if (!selectedClass || !classOptions.includes(selectedClass)) {
      setSelectedClass(classOptions[0]);
    }
  }, [classOptions, selectedClass]);

  useEffect(() => {
    if (!germanGroupOptions.length) {
      return;
    }
    if (!germanGroup || !germanGroupOptions.includes(germanGroup)) {
      setGermanGroup(germanGroupOptions[0]);
    }
  }, [germanGroupOptions, germanGroup]);

  useEffect(() => {
    if (!englishGroupOptions.length) {
      return;
    }
    if (!englishGroup || !englishGroupOptions.includes(englishGroup)) {
      setEnglishGroup(englishGroupOptions[0]);
    }
  }, [englishGroupOptions, englishGroup]);

  useEffect(() => {
    if (!workbook || !selectedSheet) {
      setEvents([]);
      setSessions([]);
      setLanguageNotes([]);
      return;
    }

    const parsed = parseClassSheet(
      workbook.Sheets[selectedSheet.sheetName],
      FIXED_YEAR,
      selectedSheet.sheetName
    );
    const precise = buildPreciseLanguageEvents({
      workbook,
      grade: selectedSheet.grade,
      major: selectedSheet.major,
      classLabel: selectedSheet.sheetName,
      languageSlots: parsed.languageSlots,
      englishGroup,
      germanGroup,
    });

    setEvents([...parsed.events, ...precise.events].sort((a, b) => a.start - b.start));
    setSessions(parsed.sessions);
    setLanguageNotes(precise.notes);
  }, [workbook, selectedSheet, englishGroup, germanGroup]);

  useEffect(() => {
    if (!weekOptions.length) {
      weekInitRef.current = false;
      return;
    }

    const isCurrentValid = weekOptions.some((week) => getWeekKey(week) === selectedWeek);
    if (!weekInitRef.current) {
      const todayWeekKey = getWeekKey(new Date());
      const hasTodayWeek = weekOptions.some((week) => getWeekKey(week) === todayWeekKey);
      if (hasTodayWeek) {
        setSelectedWeek(todayWeekKey);
      } else if (!isCurrentValid) {
        setSelectedWeek(getWeekKey(weekOptions[0]));
      }
      weekInitRef.current = true;
      return;
    }

    if (!isCurrentValid) {
      setSelectedWeek(getWeekKey(weekOptions[0]));
    }
  }, [weekOptions, selectedWeek]);

  useEffect(() => {
    const previous = loadStoredSettings();
    saveStoredSettings({
      selectedGrade,
      selectedMajor,
      selectedClass,
      germanGroup,
      englishGroup,
      selectedWeek: weekOptions.length ? selectedWeek : previous.selectedWeek || selectedWeek,
    });
  }, [
    selectedGrade,
    selectedMajor,
    selectedClass,
    germanGroup,
    englishGroup,
    selectedWeek,
    weekOptions.length,
  ]);

  useEffect(() => {
    if (!workbook || firstRunPromptedRef.current) return;
    const shouldForcePrompt = !hasSeenSetupPrompt();
    const hasStoredSelection = Boolean(
      storedSettings.selectedGrade || storedSettings.selectedMajor || storedSettings.selectedClass
    );
    if (shouldForcePrompt || !hasStoredSelection) {
      setIsSettingsOpen(true);
      markSetupPromptSeen();
      firstRunPromptedRef.current = true;
    }
  }, [workbook, storedSettings]);

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

  const handleResetConfirmed = () => {
    resetStoredSettings();
    firstRunPromptedRef.current = false;
    weekInitRef.current = false;
    setSelectedGrade('');
    setSelectedMajor('');
    setSelectedClass('');
    setGermanGroup('');
    setEnglishGroup('');
    setSelectedWeek('');
    setIsResetConfirmOpen(false);
    setIsWeekPickerOpen(false);
    setIsAboutOpen(false);
    setIsSettingsOpen(true);
  };

  return (
    <div className="app-shell">
      <header className="top-app-bar">
        <button type="button" className="week-trigger" onClick={() => setIsWeekPickerOpen(true)}>
          <strong>{displayDate}</strong>
          <span>第 {displayWeekNo} 周</span>
        </button>
        <div className="top-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setIsResetConfirmOpen(true)}
            aria-label="重置设置"
          >
            <span className="material-symbols-outlined">replay</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={handleExport}
            aria-label="导出课表"
            disabled={!events.length}
          >
            <span className="material-symbols-outlined">download</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setIsAboutOpen(true)}
            aria-label="关于"
          >
            <span className="material-symbols-outlined">info</span>
          </button>
        </div>
      </header>

      {error ? <div className="alert-banner">{error}</div> : null}

      <main
        className="timetable-main"
        onTouchStart={handleSwipeStart}
        onTouchMove={handleSwipeMove}
        onTouchEnd={handleSwipeEnd}
        onTouchCancel={handleSwipeCancel}
      >
        {events.length ? (
          <>
            <p className="swipe-tip">左右滑动可切换周</p>
            <div
              className={`table-scroll swipe-track ${isDragging ? 'dragging' : ''}`}
              style={{ transform: `translate3d(${dragOffset}px, 0, 0)` }}
            >
              <table className="schedule-table">
                <thead>
                  <tr>
                    <th className="session-head">节次</th>
                    {weekColumns.map((column) => (
                      <th key={`${column.weekday}-${column.date.toISOString()}`}>
                        <span>{column.label}</span>
                        <small>{formatMonthDay(column.date)}</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {STANDARD_TIME_SLOTS.map((slot) => (
                    <tr key={slot.id}>
                      <th className="session-cell">
                        <strong>{slot.id}</strong>
                        <span>{slot.start}</span>
                        <span>{slot.end}</span>
                      </th>
                      {weekColumns.map((column) => {
                        const key = `${column.weekday}|${slot.start}-${slot.end}`;
                        const cellEvents = weeklyEventMap.get(key) || [];
                        return (
                          <td key={`${slot.id}-${column.weekday}`}>
                            {cellEvents.length ? (
                              <div className="course-stack">
                                {cellEvents.map((event, index) => {
                                  const tone = getCourseTone(event.summary);
                                  const teacher = extractTeacherFromDescription(event.description);
                                  return (
                                    <article
                                      className="course-card"
                                      key={`${event.summary}-${index}-${event.start.getTime()}`}
                                      style={{
                                        backgroundColor: tone.bg,
                                        borderColor: tone.border,
                                        color: tone.text,
                                      }}
                                    >
                                      <strong>{event.summary}</strong>
                                      <p>@{event.location || '场地待定'}</p>
                                      {teacher ? <p>{teacher}</p> : null}
                                    </article>
                                  );
                                })}
                              </div>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <p>暂无课程数据，请先完成课程设置。</p>
          </div>
        )}
      </main>

      <button
        type="button"
        className="fab"
        onClick={() => setIsSettingsOpen(true)}
        aria-label="课程设置"
      >
        <span className="material-symbols-outlined">settings</span>
      </button>

      {isSettingsOpen ? (
        <Modal
          title="课程设置"
          onClose={() => setIsSettingsOpen(false)}
          actions={
            <button type="button" className="filled-btn" onClick={() => setIsSettingsOpen(false)}>
              完成
            </button>
          }
        >
          <p className="modal-note">设置会自动保存，下次打开会直接恢复</p>
          <div className="field-grid">
            <label>
              <span>年级</span>
              <select value={selectedGrade} onChange={(event) => setSelectedGrade(event.target.value)}>
                {gradeOptions.map((grade) => (
                  <option key={grade} value={grade}>
                    {grade}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>专业</span>
              <select value={selectedMajor} onChange={(event) => setSelectedMajor(event.target.value)}>
                {majorOptions.map((major) => (
                  <option key={major} value={major}>
                    {major}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>班级</span>
              <select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}>
                {classOptions.map((classCode) => (
                  <option key={classCode} value={classCode}>
                    {classCode}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>德语分组</span>
              <select value={germanGroup} onChange={(event) => setGermanGroup(event.target.value)}>
                <option value="">{germanGroupOptions.length ? '请选择' : '无可选分组'}</option>
                {germanGroupOptions.map((groupNo) => (
                  <option key={groupNo} value={groupNo}>
                    {groupNo}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>英语分组</span>
              <select value={englishGroup} onChange={(event) => setEnglishGroup(event.target.value)}>
                <option value="">{englishGroupOptions.length ? '请选择' : '无可选分组'}</option>
                {englishGroupOptions.map((groupNo) => (
                  <option key={groupNo} value={groupNo}>
                    {groupNo}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* sessions.length */ false ? (
            <div className="chips">
              {sessions.map((session) => (
                <span key={session.col}>
                  {session.label} {session.timeRange ? `· ${session.timeRange}` : ''}
                </span>
              ))}
            </div>
          ) : null}
          {languageNotes.length ? (
            <div className="note-list">
              {languageNotes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          ) : null}
        </Modal>
      ) : null}

      {isWeekPickerOpen ? (
        <Modal title="切换周次" onClose={() => setIsWeekPickerOpen(false)} panelClassName="week-modal">
          <div className="week-list">
            {weekOptions.map((week, index) => {
              const key = getWeekKey(week);
              const active = key === selectedWeek;
              return (
                <button
                  key={key}
                  type="button"
                  className={`week-item ${active ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedWeek(key);
                    setIsWeekPickerOpen(false);
                  }}
                >
                  <strong>第 {index + 1} 周</strong>
                  <span>{formatWeekLabel(week)}</span>
                </button>
              );
            })}
          </div>
        </Modal>
      ) : null}

      {isAboutOpen ? (
        <Modal
          title="关于"
          onClose={() => setIsAboutOpen(false)}
          actions={
            <button type="button" className="filled-btn" onClick={() => setIsAboutOpen(false)}>
              知道了
            </button>
          }
        >
          <div className="about-content">
            <h3>BiUH 超级云课表</h3>
            <p>作者：李幸值、陈俊豪</p>
            <p>当前课表源：{sourceLabel}</p>
            <p>课表文件构建日期：{buildDateText}</p>
          </div>
        </Modal>
      ) : null}

      {isResetConfirmOpen ? (
        <Modal
          title="重置设置"
          onClose={() => setIsResetConfirmOpen(false)}
          actions={
            <>
              <button
                type="button"
                className="text-btn"
                onClick={() => setIsResetConfirmOpen(false)}
              >
                取消
              </button>
              <button type="button" className="filled-btn" onClick={handleResetConfirmed}>
                重置
              </button>
            </>
          }
        >
          <p className="modal-note">将清空本地设置并重新打开课程设置。</p>
        </Modal>
      ) : null}
    </div>
  );
}
