import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const applySwipeResistance = (distance, limit, resistance = 0.18) => {
  const absolute = Math.abs(distance);
  if (absolute <= limit) return distance;
  return Math.sign(distance) * (limit + (absolute - limit) * resistance);
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
  const swipeSurfaceRef = useRef(null);
  const swipeAnimationRef = useRef({
    exitTimer: 0,
    settleTimer: 0,
    rafId: 0,
  });
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
  const [isSwipeAnimating, setIsSwipeAnimating] = useState(false);

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

  const shouldUseEnglishGroups = selectedGrade === '2025';
  const shouldUseGermanGroups = selectedGrade === '2025' || selectedGrade === '2024';

  const englishSheetName = useMemo(
    () =>
      shouldUseEnglishGroups ? findLanguageSheetName(workbook, selectedGrade, 'english') : '',
    [workbook, selectedGrade, shouldUseEnglishGroups]
  );
  const germanSheetName = useMemo(
    () =>
      shouldUseGermanGroups ? findLanguageSheetName(workbook, selectedGrade, 'german') : '',
    [workbook, selectedGrade, shouldUseGermanGroups]
  );

  const englishLanguageMap = useMemo(() => {
    if (!shouldUseEnglishGroups || !workbook || !englishSheetName) return new Map();
    return parseLanguageSheet(workbook.Sheets[englishSheetName], 'english');
  }, [workbook, englishSheetName, shouldUseEnglishGroups]);

  const germanLanguageMap = useMemo(() => {
    if (!shouldUseGermanGroups || !workbook || !germanSheetName) return new Map();
    return parseLanguageSheet(workbook.Sheets[germanSheetName], 'german');
  }, [workbook, germanSheetName, shouldUseGermanGroups]);

  const englishGroupOptions = useMemo(() => {
    if (!shouldUseEnglishGroups) return [];
    const options = new Set();
    englishLanguageMap.forEach((cell) => {
      cell.entries.forEach((entry) => {
        if (selectedMajor && !entry.code.includes(selectedMajor)) return;
        const groupNo = extractGroupNumber(entry.code, 'english');
        if (groupNo) options.add(groupNo);
      });
    });
    return sortNumericStrings(options);
  }, [englishLanguageMap, selectedMajor, shouldUseEnglishGroups]);

  const germanGroupOptions = useMemo(() => {
    if (!shouldUseGermanGroups) return [];
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
  }, [germanLanguageMap, selectedGrade, selectedMajor, shouldUseGermanGroups]);



  const weekOptions = useMemo(() => {
    if (!events.length) return [];
    const keys = new Map();
    events.forEach((event) => {
      const key = getWeekKey(event.start);
      if (!keys.has(key)) keys.set(key, getWeekStart(event.start));
    });
    return [...keys.values()].sort((a, b) => a - b);
  }, [events]);

  const today = new Date();
  const todayWeekKey = getWeekKey(today);

  const selectedWeekIndex = useMemo(() => {
    return weekOptions.findIndex((week) => getWeekKey(week) === selectedWeek);
  }, [weekOptions, selectedWeek]);

  const todayWeekIndex = useMemo(() => {
    return weekOptions.findIndex((week) => getWeekKey(week) === todayWeekKey);
  }, [weekOptions, todayWeekKey]);

  const resolvedWeekIndex = useMemo(() => {
    if (selectedWeekIndex >= 0) return selectedWeekIndex;
    if (todayWeekIndex >= 0) return todayWeekIndex;
    return weekOptions.length ? 0 : -1;
  }, [selectedWeekIndex, todayWeekIndex, weekOptions.length]);

  const selectedWeekStart = useMemo(() => {
    if (resolvedWeekIndex >= 0) return weekOptions[resolvedWeekIndex];
    return null;
  }, [resolvedWeekIndex, weekOptions]);

  const resolvedWeekKey = selectedWeekStart ? getWeekKey(selectedWeekStart) : '';
  const isViewingCurrentWeek = resolvedWeekKey === todayWeekKey;

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

  const displayDate = isViewingCurrentWeek
    ? formatDisplayDate(today)
    : selectedWeekStart
      ? formatDisplayDate(selectedWeekStart)
      : formatDisplayDate(today);
  const displayWeekNo = resolvedWeekIndex >= 0 ? resolvedWeekIndex + 1 : 1;

  const clearSwipeAnimation = useCallback(() => {
    const animation = swipeAnimationRef.current;
    if (animation.exitTimer) {
      window.clearTimeout(animation.exitTimer);
      animation.exitTimer = 0;
    }
    if (animation.settleTimer) {
      window.clearTimeout(animation.settleTimer);
      animation.settleTimer = 0;
    }
    if (animation.rafId) {
      window.cancelAnimationFrame(animation.rafId);
      animation.rafId = 0;
    }
  }, []);

  const getSwipeMetrics = useCallback(() => {
    const width =
      swipeSurfaceRef.current?.clientWidth ||
      (typeof window !== 'undefined' ? window.innerWidth : 360) ||
      360;
    const travel = clamp(width * 0.36, 132, 220);
    return {
      maxDrag: clamp(width * 0.24, 92, 164),
      edgeDrag: clamp(width * 0.14, 54, 92),
      triggerOffset: clamp(width * 0.18, 56, 104),
      exitOffset: travel,
      enterOffset: Math.round(travel * 0.68),
      velocityThreshold: 0.42,
    };
  }, []);

  const resolveShiftTargetIndex = useCallback(
    (offset) => {
      if (!weekOptions.length || resolvedWeekIndex < 0) return -1;
      const target = clamp(resolvedWeekIndex + offset, 0, weekOptions.length - 1);
      return target === resolvedWeekIndex ? -1 : target;
    },
    [resolvedWeekIndex, weekOptions.length]
  );

  const applyDragOffset = (value) => {
    dragOffsetRef.current = value;
    setDragOffset(value);
  };

  const queueSwipeWeekShift = useCallback(
    (direction) => {
      const targetIndex = resolveShiftTargetIndex(direction);
      if (targetIndex < 0) return false;

      const { enterOffset, exitOffset } = getSwipeMetrics();
      const nextWeekKey = getWeekKey(weekOptions[targetIndex]);

      clearSwipeAnimation();
      setIsDragging(false);
      setIsSwipeAnimating(true);
      applyDragOffset(direction > 0 ? -exitOffset : exitOffset);

      swipeAnimationRef.current.exitTimer = window.setTimeout(() => {
        startTransition(() => setSelectedWeek(nextWeekKey));
        applyDragOffset(direction > 0 ? enterOffset : -enterOffset);
        swipeAnimationRef.current.rafId = window.requestAnimationFrame(() => {
          swipeAnimationRef.current.rafId = window.requestAnimationFrame(() => {
            applyDragOffset(0);
            swipeAnimationRef.current.settleTimer = window.setTimeout(() => {
              setIsSwipeAnimating(false);
              swipeAnimationRef.current.settleTimer = 0;
            }, 220);
          });
        });
        swipeAnimationRef.current.exitTimer = 0;
      }, 150);

      return true;
    },
    [clearSwipeAnimation, getSwipeMetrics, resolveShiftTargetIndex, weekOptions]
  );

  const handleSwipeStart = (event) => {
    if (isSwipeAnimating || !event.touches?.length) return;
    clearSwipeAnimation();
    if (!event.touches?.length) return;
    const touch = event.touches[0];
    const now = performance.now();
    swipeRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      lastX: touch.clientX,
      lastTime: now,
      velocityX: 0,
      locked: false,
      horizontal: false,
    };
    setIsDragging(false);
    applyDragOffset(0);
  };

  const handleSwipeMove = (event) => {
    if (!swipeRef.current || isSwipeAnimating || !event.touches?.length) return;
    const touch = event.touches[0];
    const dx = touch.clientX - swipeRef.current.x;
    const dy = touch.clientY - swipeRef.current.y;
    const now = performance.now();
    const dt = Math.max(1, now - swipeRef.current.lastTime);
    swipeRef.current.velocityX = (touch.clientX - swipeRef.current.lastX) / dt;
    swipeRef.current.lastX = touch.clientX;
    swipeRef.current.lastTime = now;

    if (!swipeRef.current.locked) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      swipeRef.current.locked = true;
      if (Math.abs(dx) > Math.abs(dy) * 1.15) {
        swipeRef.current.horizontal = true;
      } else if (Math.abs(dy) > Math.abs(dx)) {
        swipeRef.current.horizontal = false;
      } else {
        return;
      }
    }

    if (!swipeRef.current.horizontal) return;

    if (event.cancelable) event.preventDefault();

    const { edgeDrag, maxDrag } = getSwipeMetrics();
    const canShiftPrev = resolvedWeekIndex > 0;
    const canShiftNext = resolvedWeekIndex >= 0 && resolvedWeekIndex < weekOptions.length - 1;
    let displayDx = dx;
    if ((dx > 0 && !canShiftPrev) || (dx < 0 && !canShiftNext)) {
      displayDx = Math.sign(dx) * Math.min(edgeDrag, Math.abs(dx) * 0.32);
    } else {
      displayDx = applySwipeResistance(dx, maxDrag);
    }

    if (!isDragging) setIsDragging(true);
    applyDragOffset(displayDx);
  };

  const handleSwipeCancel = () => {
    swipeRef.current = null;
    setIsDragging(false);
    applyDragOffset(0);
  };

  const handleSwipeEnd = (event) => {
    if (!swipeRef.current || isSwipeAnimating || !event.changedTouches?.length) {
      handleSwipeCancel();
      return;
    }
    const wasHorizontal = swipeRef.current.horizontal;
    const velocityX = swipeRef.current.velocityX;
    swipeRef.current = null;

    if (!wasHorizontal) {
      handleSwipeCancel();
      return;
    }

    const { triggerOffset, velocityThreshold } = getSwipeMetrics();
    const finalOffset = dragOffsetRef.current;
    const enoughDistance = Math.abs(finalOffset) >= triggerOffset;
    const enoughVelocity = Math.abs(velocityX) >= velocityThreshold;
    const direction = enoughDistance
      ? finalOffset < 0
        ? 1
        : -1
      : enoughVelocity
        ? velocityX < 0
          ? 1
          : -1
        : 0;
    const shifted = direction ? queueSwipeWeekShift(direction) : false;

    setIsDragging(false);
    if (!shifted) applyDragOffset(0);
  };

  useEffect(() => {
    return () => clearSwipeAnimation();
  }, [clearSwipeAnimation]);

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
    if (!shouldUseGermanGroups) return;
    if (!germanGroupOptions.length) return;
    if (!germanGroup || !germanGroupOptions.includes(germanGroup)) {
      setGermanGroup(germanGroupOptions[0]);
    }
  }, [germanGroupOptions, germanGroup, shouldUseGermanGroups]);

  useEffect(() => {
    if (!shouldUseEnglishGroups) return;
    if (!englishGroupOptions.length) return;
    if (!englishGroup || !englishGroupOptions.includes(englishGroup)) {
      setEnglishGroup(englishGroupOptions[0]);
    }
  }, [englishGroupOptions, englishGroup, shouldUseEnglishGroups]);

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
      englishGroup: shouldUseEnglishGroups ? englishGroup : '',
      germanGroup: shouldUseGermanGroups ? germanGroup : '',
    });

    setEvents([...parsed.events, ...precise.events].sort((a, b) => a.start - b.start));
    setSessions(parsed.sessions);
    setLanguageNotes(precise.notes);
  }, [
    workbook,
    selectedSheet,
    englishGroup,
    germanGroup,
    shouldUseEnglishGroups,
    shouldUseGermanGroups,
  ]);

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
      selectedWeek: weekOptions.length ? resolvedWeekKey : previous.selectedWeek || selectedWeek,
    });
  }, [
    selectedGrade,
    selectedMajor,
    selectedClass,
    germanGroup,
    englishGroup,
    selectedWeek,
    resolvedWeekKey,
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
              ref={swipeSurfaceRef}
              className={`table-scroll swipe-track ${isDragging ? 'dragging' : ''} ${isSwipeAnimating ? 'animating' : ''}`.trim()}
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
                                      {event.location ? <p>@{event.location}</p> : null}
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
            {shouldUseGermanGroups || shouldUseEnglishGroups ? (
              <>
                {shouldUseGermanGroups ? (
                  <label>
                    <span>德语分组</span>
                    <select
                      value={germanGroup}
                      onChange={(event) => setGermanGroup(event.target.value)}
                    >
                      <option value="">{germanGroupOptions.length ? '请选择' : '无可选分组'}</option>
                      {germanGroupOptions.map((groupNo) => (
                        <option key={groupNo} value={groupNo}>
                          {groupNo}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {shouldUseEnglishGroups ? (
                  <label>
                    <span>英语分组</span>
                    <select
                      value={englishGroup}
                      onChange={(event) => setEnglishGroup(event.target.value)}
                    >
                      <option value="">{englishGroupOptions.length ? '请选择' : '无可选分组'}</option>
                      {englishGroupOptions.map((groupNo) => (
                        <option key={groupNo} value={groupNo}>
                          {groupNo}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </>
            ) : null}
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
              const active = key === resolvedWeekKey;
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
