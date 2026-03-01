const SETTINGS_STORAGE_KEY = 'moeleak-calendar-settings-v1';
const SETUP_SEEN_KEY = 'moeleak-calendar-setup-seen-v1';

export const loadStoredSettings = () => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (err) {
    return {};
  }
};

export const saveStoredSettings = (settings) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    // Ignore storage errors silently.
  }
};

export const hasSeenSetupPrompt = () => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SETUP_SEEN_KEY) === '1';
  } catch (err) {
    return false;
  }
};

export const markSetupPromptSeen = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETUP_SEEN_KEY, '1');
  } catch (err) {
    // Ignore storage errors silently.
  }
};

export const resetStoredSettings = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    window.localStorage.removeItem(SETUP_SEEN_KEY);
  } catch (err) {
    // Ignore storage errors silently.
  }
};
