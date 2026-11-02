// =====================================
// QUESTIFY - Entry Point
// =====================================
//
// Code style conventions used throughout this file:
// - State mutations always go through named functions, never inline
// - Every state mutation ends with saveState() (directly or via a
//   caller that batches multiple changes into one save)
// - Views are pure functions of `state` - they read, never mutate
// - UI-only state (not persisted) lives in top-level `let` variables,
//   reset in navigateTo() when leaving a view that used them
// - Shared logic (e.g. "completed challenges") lives in one helper,
//   never duplicated inline across views/badges
// - Magic numbers live in CONFIG, not scattered as raw literals
//
// -------------------------------------
// Questify - Entry Point
// -------------------------------------

const appRoot = document.getElementById("app");
const mainEl = document.querySelector(".app-main");
const navButtons = document.querySelectorAll(".app-nav__btn[data-view]");

if (!appRoot || !mainEl) {
  console.error("Fatal: required app containers not found in HTML.");
}

function syncAppFloatingWidgetNote() {
  const widget = getFloatingWidget("note");
  if (widget?.ownerId !== appWindowId || widget.mode !== "app") return;
  const pinnedNote = widget.kind === "saved"
    ? state.notes.find((item) => item.id === widget.id)
    : null;
  const label = document.querySelector(".app-floating-note .app-floating-widget__header label");
  if (label && pinnedNote) label.textContent = pinnedNote.title || "STICKY NOTE";
  const input = document.getElementById(
    widget.kind === "session" ? "floating-session-note-content" : "floating-saved-note-content"
  );
  if (!input || document.activeElement === input) return;
  if (widget.kind === "session") {
    input.value = getActiveLockIn()?.sessionNote || "";
    return;
  }
  const note = state.notes.find((item) => item.id === widget.id);
  if (note) input.value = note.content;
}

// -------------------------------------
// State: single source of truth
// -------------------------------------
const STORAGE_KEY = "questify_state";
const LEGAL_POLICY_VERSION = "1.0";
const initialUrlParams = new URLSearchParams(window.location.search);
const isLockInFocusWindow = initialUrlParams.get("focus") === "lockin";
const stickyNoteWindowId = initialUrlParams.get("note");
const isStickyNoteWindow = Boolean(stickyNoteWindowId);
const isLockInTimerWindow = initialUrlParams.get("timer") === "lockin";
const sessionNoteWindowId = initialUrlParams.get("session-note");
const isSessionNoteWindow = Boolean(sessionNoteWindowId);
const FLOATING_WIDGETS_STORAGE_KEY = "questify_floating_widgets";
const UPDATE_REMINDER_STORAGE_KEY = "questify_update_prompt_dismissed_at";
const UPDATE_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const appWindowId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const lockInStateChannel = "BroadcastChannel" in window
  ? new BroadcastChannel("questify-lockin-state")
  : null;
let floatingWidgetHeartbeatId = null;
let appUpdatePrompt = null;
let appUpdateRegistration = null;
let shouldReloadForAppUpdate = false;
let appUpdateActivationTimeoutId = null;
let appUpdateCheckIntervalId = null;
let appUpdateReminderIntervalId = null;
let lastBackgroundUpdateCheckAt = 0;

// -------------------------------------
// App-wide configuration constants
// (centralizing "magic numbers" so they're easy to find/tune)
// -------------------------------------
const CONFIG = {
  TOAST_DURATION_MS: 3000,
  SEARCH_DEBOUNCE_MS: 200,
  MAX_NOTIFICATIONS: 20,
  XP_PER_LEVEL_MULTIPLIER: 100,
  DEFAULT_DAILY_GOAL: 3,
  HABIT_XP_REWARDS: Object.freeze({ easy: 3, medium: 5, hard: 8 }),
};

const APP_THEMES = [
  { id: "sunset", name: "Sunset", description: "Rounded, warm and playful", color: "#fff1e6", swatches: ["#fff1e6", "#fb8b68", "#a94e37"] },
  { id: "ocean", name: "Ocean", description: "Crisp coastal glass", color: "#071b2c", swatches: ["#071b2c", "#38bdf8", "#0f6b8f"] },
  { id: "aurora", name: "Aurora", description: "Soft, airy sea glass", color: "#eaf5f2", swatches: ["#eaf5f2", "#62c7a6", "#176d65"] },
  { id: "forest", name: "Forest", description: "Quiet botanical editorial", color: "#edf4e9", swatches: ["#edf4e9", "#8dbb75", "#3f6b43"] },
  { id: "lavender", name: "Lavender", description: "Dreamy, elegant dusk", color: "#1d1830", swatches: ["#1d1830", "#c4a7ff", "#7251b5"] },
  { id: "midnight", name: "Midnight", description: "Sharp, focused terminal", color: "#111827", swatches: ["#111827", "#fbbf24", "#9a6f18"] },
];

function getDefaultState() {
  return {
    user: {
      name: "",
      xp: 0,
      level: 1,
      streak: 0,
      lastCompletedDate: null,
      isOnboarded: false,
      hasSeenTour: false,
      hasCompletedTour: false,
      hasSeenFirstStepWelcome: false,
      dailyGoal: CONFIG.DEFAULT_DAILY_GOAL,
    },
    challenges: [],
    habits: [],
    habitXpLedger: [],
    notes: [],
    legalAcceptance: null,
    unlockedBadgeIds: [],
    notifications: [],
    preferences: {
      theme: "sunset",
      soundEnabled: true,
      hapticsEnabled: true,
      remindersEnabled: false,
      lastReminderDate: null,
      blockNotificationsDuringLockIn: false,
      floatingWindowsTransparent: false,
      lastLockInDuration: 60,
      lockInNote: "",
      lockInNoteColor: "#fff1a8",
      sidebarCollapsed: false,
      navigationMode: "auto",
    },
  };
}

let state = getDefaultState();

// -------------------------------------
// Persistence: save/load from localStorage
// -------------------------------------
function getFloatingWidgets() {
  try {
    const stored = JSON.parse(localStorage.getItem(FLOATING_WIDGETS_STORAGE_KEY) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    console.error("Could not read floating widget state:", error);
    return {};
  }
}

function getFloatingWidget(kind) {
  const widget = getFloatingWidgets()[kind];
  if (!widget || typeof widget !== "object" ||
      !Number.isFinite(widget.expiresAt) || widget.expiresAt <= Date.now()) return null;
  return widget;
}

function isLockInTimerPinned() {
  const active = getActiveLockIn();
  const widget = getFloatingWidget("timer");
  return Boolean(active && widget && widget.id === active.id);
}

function ownsFloatingWidget(kind, mode = null) {
  const widget = getFloatingWidget(kind);
  return Boolean(widget && widget.ownerId === appWindowId && (!mode || widget.mode === mode));
}

function saveFloatingWidgets(widgets) {
  try {
    localStorage.setItem(FLOATING_WIDGETS_STORAGE_KEY, JSON.stringify(widgets));
    lockInStateChannel?.postMessage({ type: "floating-widgets-updated" });
  } catch (error) {
    console.error("Could not save floating widget state:", error);
    showToast("Questify could not save the floating window state.");
  }
}

function setFloatingWidget(kind, details) {
  const widgets = getFloatingWidgets();
  if (!details) {
    delete widgets[kind];
  } else {
    widgets[kind] = {
      ...details,
      ownerId: appWindowId,
      expiresAt: Date.now() + 120000,
    };
  }
  saveFloatingWidgets(widgets);

  if (details && !floatingWidgetHeartbeatId) {
    floatingWidgetHeartbeatId = setInterval(() => {
      const currentWidgets = getFloatingWidgets();
      let changed = false;
      Object.keys(currentWidgets).forEach((widgetKind) => {
        const widget = currentWidgets[widgetKind];
        if (widget?.ownerId === appWindowId && widget.expiresAt - Date.now() < 90000) {
          widget.expiresAt = Date.now() + 120000;
          changed = true;
        }
      });
      if (changed) saveFloatingWidgets(currentWidgets);
    }, 30000);
  } else if (!details && floatingWidgetHeartbeatId &&
      !Object.values(getFloatingWidgets()).some((widget) => widget?.ownerId === appWindowId)) {
    clearInterval(floatingWidgetHeartbeatId);
    floatingWidgetHeartbeatId = null;
  }
}

function clearOwnedFloatingWidgets() {
  if (floatingWidgetHeartbeatId) clearInterval(floatingWidgetHeartbeatId);
  floatingWidgetHeartbeatId = null;
  const widgets = getFloatingWidgets();
  let changed = false;
  Object.keys(widgets).forEach((kind) => {
    if (widgets[kind]?.ownerId === appWindowId) {
      delete widgets[kind];
      changed = true;
    }
  });
  if (changed) saveFloatingWidgets(widgets);
}

window.addEventListener("pagehide", clearOwnedFloatingWidgets);

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.__questifyState = state;
    lockInStateChannel?.postMessage({ type: "state-updated" });
  } catch (err) {
    console.error("Failed to save state:", err);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const savedState = JSON.parse(raw);
      const defaultState = getDefaultState();  // Call once for efficiency
      const savedTheme = savedState.preferences?.theme;
      const migratedTheme = savedTheme === "dark"
        ? "midnight"
        : savedTheme === "light"
        ? "aurora"
        : savedTheme;
      state = {
        ...defaultState,
        ...savedState,
        notes: Array.isArray(savedState.notes)
          ? savedState.notes
              .filter((note) => note && typeof note === "object")
              .map((note) => ({
                id: typeof note.id === "string" ? note.id : generateId(),
                title: (typeof note.title === "string" ? note.title : "Untitled note").slice(0, 80),
                content: (typeof note.content === "string" ? note.content : "").slice(0, 2000),
                color: /^#[0-9a-f]{6}$/i.test(note.color || "") ? note.color : "#fff1a8",
                createdAt: typeof note.createdAt === "string" ? note.createdAt : new Date().toISOString(),
                updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : new Date().toISOString(),
              }))
          : [],
        legalAcceptance: savedState.legalAcceptance && typeof savedState.legalAcceptance === "object"
          ? {
              policyVersion: typeof savedState.legalAcceptance.policyVersion === "string"
                ? savedState.legalAcceptance.policyVersion
                : "",
              acceptedAt: typeof savedState.legalAcceptance.acceptedAt === "string"
                ? savedState.legalAcceptance.acceptedAt
                : "",
            }
          : null,
        habits: Array.isArray(savedState.habits)
          ? savedState.habits
              .filter((habit) => habit && typeof habit === "object")
              .map((habit) => ({
                ...habit,
                id: typeof habit.id === "string" ? habit.id : generateId(),
                title: typeof habit.title === "string" ? habit.title : "",
                description: typeof habit.description === "string" ? habit.description : "",
                difficulty: ["easy", "medium", "hard"].includes(habit.difficulty) ? habit.difficulty : "medium",
                category: getHabitCategoryId(habit.category),
                createdDate: /^\d{4}-\d{2}-\d{2}$/.test(habit.createdDate || "")
                  ? habit.createdDate
                  : typeof habit.createdAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(habit.createdAt)
                  ? habit.createdAt.slice(0, 10)
                  : getTodayDateString(),
                completedDates: Array.isArray(habit.completedDates)
                  ? [...new Set(habit.completedDates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))]
                  : [],
                xpAwardedDates: Array.isArray(habit.xpAwardedDates)
                  ? [...new Set(habit.xpAwardedDates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))]
                  : [],
                archived: Boolean(habit.archived),
              }))
          : defaultState.habits,
        habitXpLedger: Array.isArray(savedState.habitXpLedger)
          ? savedState.habitXpLedger.filter((entry) =>
              entry && typeof entry.habitId === "string" &&
              /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
              Number.isFinite(entry.amount) && entry.amount > 0
            )
          : (Array.isArray(savedState.habits) ? savedState.habits : []).flatMap((habit) =>
              (Array.isArray(habit?.xpAwardedDates) ? habit.xpAwardedDates : [])
                .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
                .map((date) => ({
                  id: `${habit.id || "legacy"}:${date}`,
                  habitId: typeof habit.id === "string" ? habit.id : "legacy",
                  habitTitle: typeof habit.title === "string" ? habit.title : "Habit",
                  date,
                  amount: CONFIG.HABIT_XP_REWARDS.medium,
                }))
            ),
        user: {
          ...defaultState.user,
          ...savedState.user,
          hasCompletedTour: Boolean(savedState.user?.hasCompletedTour ?? savedState.user?.hasSeenTour),
          hasSeenFirstStepWelcome: Boolean(
            savedState.user?.hasSeenFirstStepWelcome || savedState.challenges?.length > 0
          ),
        },
        preferences: {
          ...defaultState.preferences,
          ...savedState.preferences,
          floatingWindowsTransparent: Boolean(savedState.preferences?.floatingWindowsTransparent),
          navigationMode: ["auto", "sidebar", "bottom"].includes(savedState.preferences?.navigationMode)
            ? savedState.preferences.navigationMode
            : "auto",
          lastLockInDuration: Math.min(240, Math.max(1, Number(savedState.preferences?.lastLockInDuration) || defaultState.preferences.lastLockInDuration)),
          lockInNote: typeof savedState.preferences?.lockInNote === "string"
            ? savedState.preferences.lockInNote.slice(0, 500)
            : defaultState.preferences.lockInNote,
          lockInNoteColor: /^#[0-9a-f]{6}$/i.test(savedState.preferences?.lockInNoteColor || "")
            ? savedState.preferences.lockInNoteColor
            : defaultState.preferences.lockInNoteColor,
          theme: APP_THEMES.some((theme) => theme.id === migratedTheme)
            ? migratedTheme
            : defaultState.preferences.theme,
        },
      };
      const legacyNote = state.preferences.lockInNote;
      if (legacyNote.trim() && !state.notes.some((note) => note.id === "legacy-lockin-note")) {
        state.notes.unshift({
          id: "legacy-lockin-note",
          title: "Lock In note",
          content: legacyNote,
          color: state.preferences.lockInNoteColor,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      state.preferences.lockInNote = "";
      console.log("Loaded existing state from localStorage.");
    } else {
      state = getDefaultState();
      console.log("No saved state found. Using default state.");
    }
  } catch (err) {
    console.error("Failed to load state, falling back to default:", err);
    state = getDefaultState();
  }
  window.__questifyState = state;
}

window.__questifyState = state;

// -------------------------------------
// UI-only state (not persisted)
// -------------------------------------
let currentView = "dashboard";
let isEditingName = false;
let searchQuery = "";
let statusFilter = "all"; // "all" | "active" | "completed" | "archived"
let dueFilter = "all"; // "all" | "today" | "week" - which challenges show by scheduled date
let isConfirmingReset = false;
let tourStep = 0; // current onboarding tour step
let tourTargetView = "dashboard";
let isTourActive = false;
let previouslyOnboarded = false;
let lockInIntervalId = null; // ticks the active Lock In session's live timer
let dayDetailDate = null; // "YYYY-MM-DD" of the weekly-view day whose detail modal is open, or null
let calendarSelectedDate = getTodayDateString();
let calendarViewMode = "month";
let habitAnalyticsPeriod = "week";
let editingHabitId = null;
let confirmingHabitDeleteId = null;
let isSidebarCollapsed = false;
let isMobileNavigationOpen = false;
let lockInPictureInPictureWindow = null;
let lockInPictureInPictureInterval = null;
let lockInTimerPopupWindow = null;
let sessionNotePictureInPictureWindow = null;
let savedNotePictureInPictureWindow = null;
let savedNotePictureInPictureNoteId = null;
let sessionNotePopupWindow = null;

function getLockInSyncSignature() {
  const active = getActiveLockIn();
  return JSON.stringify([
    active?.id || null,
    active?.isPaused || false,
    active?.targetMinutes || 0,
    active?.completed || false,
    active?.title || "",
  ]);
}

function getNotesSyncSignature() {
  const active = getActiveLockIn();
  return JSON.stringify([
    state.notes,
    active?.sessionNote || "",
    active?.sessionNoteColor || "",
    active?.savedNoteId || "",
  ]);
}

function getHabitSyncSignature() {
  return JSON.stringify([
    state.habits,
    state.habitXpLedger,
    state.user.xp,
    state.user.level,
    state.user.streak,
  ]);
}

function handleLockInStateSync() {
  const previousSignature = getLockInSyncSignature();
  const previousNotesSignature = getNotesSyncSignature();
  const previousHabitSignature = getHabitSyncSignature();
  const noteIsFocused = document.activeElement?.matches(
    "#lockin-note-input, [data-floating-note-content], [data-note-content], [data-note-title]"
  );
  const editorIsFocused = document.activeElement?.matches(
    "input:not([type='button']):not([type='submit']), textarea, select, [contenteditable='true']"
  );
  loadState();
  window.__questifyState = state;
  applyTheme();
  const sessionChanged = previousSignature !== getLockInSyncSignature();
  const notesChanged = previousNotesSignature !== getNotesSyncSignature();
  const habitsChanged = previousHabitSignature !== getHabitSyncSignature();
  syncSessionNotePictureInPicture();
  syncSavedNotePictureInPicture();
  if (habitsChanged && !editorIsFocused && ["dashboard", "calendar", "habits"].includes(currentView)) {
    renderView();
    return;
  }
  if (!noteIsFocused && (
    isLockInFocusWindow ||
    isStickyNoteWindow ||
    isLockInTimerWindow ||
    isSessionNoteWindow ||
    (sessionChanged && ["challenges", "dashboard", "lockin"].includes(currentView)) ||
    (notesChanged && currentView === "notes")
  )) {
    renderView();
  } else {
    syncSessionNoteInput();
  }
}

lockInStateChannel?.addEventListener("message", (event) => {
  if (event.data?.type === "floating-widgets-updated") {
    if (isLockInFocusWindow || isStickyNoteWindow || isLockInTimerWindow ||
        isSessionNoteWindow || ["challenges", "lockin"].includes(currentView)) {
      renderView();
    }
    return;
  }
  handleLockInStateSync();
});
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) handleLockInStateSync();
});

// Singleton debounced functions to prevent memory leaks
let debouncedSearchRerender = null;

// Track which handlers have been attached to prevent duplicate event listeners
const attachedHandlers = {
  dashboard: false,
  challenges: false,
  calendar: false,
  profile: false,
  settings: false,
  tour: false,
  login: false,
  notifBell: false,
};

// -------------------------------------
// PWA install state (not persisted - browser/session only)
// -------------------------------------
let deferredInstallPrompt = null; // captured "beforeinstallprompt" event, if supported
let isAppInstalled = false; // set true once "appinstalled" fires

// These browser events can fire at any point in the page's life, independent
// of our app's own init()/auth flow, so they're registered here at top level
// (same pattern as the nav button/popstate listeners further down) rather
// than inside init(). Both are pure additions - neither touches state,
// localStorage, or any existing app logic.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (currentView === "settings") renderView(); // reflect availability immediately if already on Settings
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  isAppInstalled = true;
  if (currentView === "settings") renderView();
});

// -------------------------------------
// Auth (mock/local)
// -------------------------------------
function isOnboarded() {
  return Boolean(state.user.isOnboarded && state.user.name.trim());
}

function completeOnboarding(name) {
  state.user.name = name.trim();
  state.user.isOnboarded = true;
  saveState();
}

function acceptCurrentPolicies() {
  state.legalAcceptance = {
    policyVersion: LEGAL_POLICY_VERSION,
    acceptedAt: new Date().toISOString(),
  };
  saveState();
  if (previouslyOnboarded) {
    navigateTo("dashboard");
  } else {
    navigateTo("login");
  }
}

function logout() {
  const legalAcceptance = state.legalAcceptance;
  state = getDefaultState();
  state.legalAcceptance = legalAcceptance;
  saveState();
  navigateTo("login");
}

function toggleHeaderVisibility() {
  const headerEl = document.getElementById("app-header");
  if (!headerEl) return;
  headerEl.classList.toggle("is-hidden", ["login", "consent"].includes(currentView));
}

// -------------------------------------
// Theme
// -------------------------------------
function applyTheme() {
  const activeTheme = APP_THEMES.some((theme) => theme.id === state.preferences.theme)
    ? state.preferences.theme
    : "sunset";
  document.documentElement.setAttribute("data-theme", activeTheme);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    themeColorMeta.content = APP_THEMES.find((theme) => theme.id === activeTheme).color;
  }
}

function setTheme(themeId) {
  if (!APP_THEMES.some((theme) => theme.id === themeId)) {
    console.error(`Cannot apply unknown theme: "${themeId}".`);
    return;
  }
  state.preferences.theme = themeId;
  saveState();
  applyTheme();
  renderView();
}

function getReminderPermissionMessage() {
  if (typeof Notification === "undefined") {
    return "Browser notifications are not supported here.";
  }
  if (Notification.permission === "denied") {
    return "Blocked by your browser. Change this site's notification permission in browser settings.";
  }
  if (Notification.permission === "granted") {
    return "Allowed by your browser. Questify can show one daily reminder while the app checks your challenges.";
  }
  return "Turning this on asks your browser for permission before any reminder is sent.";
}

// -------------------------------------
// Reset all data
// -------------------------------------
function resetAllData() {
  const nameBackup = state.user.name;
  const legalAcceptance = state.legalAcceptance;
  state = getDefaultState();
  state.user.name = nameBackup;
  state.user.isOnboarded = true;
  state.legalAcceptance = legalAcceptance;
  saveState();
  applyTheme();
  isConfirmingReset = false;
  renderView();
  showToast("All data has been reset.");
}

// -------------------------------------
// PWA install: detection helpers
// -------------------------------------
function isRunningStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true // iOS Safari's own flag
  );
}

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// -------------------------------------
// PWA install: Settings section markup
// -------------------------------------
// Renders one of three states:
// 1. Already installed/standalone -> confirmation text, no button
// 2. Install prompt available (Chromium-based) -> "Install" button
// 3. iOS Safari (no beforeinstallprompt support) -> manual instructions
// Anything else (installation genuinely unavailable) -> section is
// omitted entirely, per "hide the install button when unavailable".
function renderInstallSection() {
  if (isRunningStandalone() || isAppInstalled) {
    return `
      <div class="settings-section card">
        <div class="settings-row">
          <div>
            <div>Install Questify</div>
            <div class="text-muted">Questify is installed on this device.</div>
          </div>
        </div>
      </div>
    `;
  }

  if (deferredInstallPrompt) {
    return `
      <div class="settings-section card">
        <div class="settings-row">
          <div>
            <div>Install Questify</div>
            <div class="text-muted">Add Questify to your home screen for quick access.</div>
          </div>
          <button id="install-app-btn" class="btn btn-sm">Install</button>
        </div>
      </div>
    `;
  }

  if (isIOSDevice()) {
    return `
      <div class="settings-section card">
        <div class="settings-row">
          <div>
            <div>Install Questify</div>
            <div class="text-muted">On iPhone/iPad: tap the Share icon, then "Add to Home Screen".</div>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}

// -------------------------------------
// Performance: debounce utility
// Store debounced functions at module level to prevent memory leaks
// -------------------------------------
const debouncedFunctions = new Map();

function debounce(fn, delay) {
  // Create a unique key for this function/delay combination
  // In practice, we reuse the same debounced function for the same purpose
  let timeoutId;
  return function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

// -------------------------------------
// Security: HTML escaping
// -------------------------------------
// Converts special HTML characters to their safe text equivalents.
// MUST be used any time user-typed text (name, challenge title, search
// query) is inserted into an HTML template string - otherwise a user
// could type something like <img src=x onerror=...> and have it
// execute as real HTML instead of displaying as plain text.
function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function escapeAttribute(str) {
  return escapeHTML(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// -------------------------------------
// Validation: reusable utility
// -------------------------------------
const VALIDATION_RULES = {
  challengeTitle: { minLength: 1, maxLength: 50 },
  userName: { minLength: 1, maxLength: 30 },
};

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function validateText(rawValue, options) {
  const { minLength = 1, maxLength = 100, fieldName = "This field" } = options;
  const value = normalizeText(rawValue || "");

  if (value.length < minLength) {
    return { isValid: false, errorMessage: `${fieldName} cannot be empty.`, value };
  }

  if (value.length > maxLength) {
    return {
      isValid: false,
      errorMessage: `${fieldName} must be ${maxLength} characters or fewer.`,
      value,
    };
  }

  return { isValid: true, errorMessage: "", value };
}

// -------------------------------------
// Character counter UI helper
// -------------------------------------
function updateCharCounter(inputEl, counterEl, maxLength) {
  const length = inputEl.value.length;
  counterEl.textContent = `${length}/${maxLength}`;
  counterEl.classList.toggle("is-near-limit", length > maxLength * 0.8 && length <= maxLength);
  counterEl.classList.toggle("is-at-limit", length > maxLength);
}

// -------------------------------------
// Challenge difficulty config
// -------------------------------------
const DIFFICULTY_CONFIG = {
  easy: { label: "Easy", xpValue: 10 },
  medium: { label: "Medium", xpValue: 20 },
  hard: { label: "Hard", xpValue: 35 },
};

function getDifficultyConfig(difficulty) {
  return DIFFICULTY_CONFIG[difficulty] || DIFFICULTY_CONFIG.easy;
}

// -------------------------------------
// Challenge category config
// -------------------------------------
const CATEGORY_CONFIG = {
  general: { label: "General", icon: "📋" },
  health: { label: "Health", icon: "💪" },
  work: { label: "Work", icon: "💼" },
  learning: { label: "Learning", icon: "📚" },
  personal: { label: "Personal", icon: "🌟" },
  lockin: { label: "Lock In", icon: "🔒" },
};

const HABIT_CATEGORY_IDS = ["general", "health", "work", "learning", "personal"];

function getCategoryConfig(category) {
  return CATEGORY_CONFIG[category] || CATEGORY_CONFIG.general;
}

function getHabitCategoryId(category) {
  return HABIT_CATEGORY_IDS.includes(category) ? category : "general";
}

function renderHabitCategoryTag(category) {
  const categoryId = getHabitCategoryId(category);
  const config = getCategoryConfig(categoryId);
  return `<span class="category-tag habit-category-tag">${config.icon} ${escapeHTML(config.label)}</span>`;
}

// -------------------------------------
// Challenge recurrence config
// -------------------------------------
const RECURRENCE_CONFIG = {
  none: { label: "One-time" },
  daily: { label: "Daily", offsetDays: 1 },
  weekly: { label: "Weekly", offsetDays: 7 },
};

function getRecurrenceConfig(recurrence) {
  return RECURRENCE_CONFIG[recurrence] || RECURRENCE_CONFIG.none;
}

// -------------------------------------
// Challenges: scheduled date helpers
// -------------------------------------

// Old challenges created before this feature won't have a scheduledDate,
// so we fall back to their creation date - same migration-safety pattern
// used throughout (Module 6, Module 13).
function getChallengeScheduledDate(challenge) {
  const dateStr = challenge.scheduledDate || 
    (challenge.dateCreated ? challenge.dateCreated.slice(0, 10) : getTodayDateString());
  
  // Validate date string format (YYYY-MM-DD) and return today if invalid
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    try {
      const d = new Date(`${dateStr}T00:00:00`);
      if (!isNaN(d.getTime())) {
        return dateStr;
      }
    } catch (e) {
      // Invalid date
    }
  }
  return getTodayDateString();
}

// -------------------------------------
// Challenges: shared derived-data helpers
// -------------------------------------
function getCompletedChallenges(s = state) {
  return s.challenges.filter((c) => c.completed);
}

function getCompletionCountByDifficulty(s = state) {
  const counts = { easy: 0, medium: 0, hard: 0 };
  getCompletedChallenges(s).forEach((c) => {
    const d = c.difficulty || "easy";
    counts[d] = (counts[d] || 0) + 1;
  });
  return counts;
}

// -------------------------------------
// Badge helpers: aggregations for the new feature-specific badges
// -------------------------------------
function getCompletedLockIns(s = state) {
  return s.challenges.filter((c) => c.completed && c.isLockIn);
}

function getTotalLockInMinutes(s = state) {
  return getCompletedLockIns(s).reduce((sum, c) => sum + (c.actualMinutes || 0), 0);
}

function getMaxLockInOvertimeMinutes(s = state) {
  const overtimes = getCompletedLockIns(s).map((c) => (c.actualMinutes || 0) - (c.targetMinutes || 0));
  return overtimes.length ? Math.max(...overtimes) : 0;
}

// Highest number of completed occurrences of any single recurring
// challenge (grouped by title, case-insensitive) - each finished
// occurrence spawns the next one, so this tracks how long a habit chain
// has been kept up.
function getMaxRecurringCompletionStreak(s = state) {
  const counts = {};
  s.challenges
    .filter((c) => c.completed && c.recurrence && c.recurrence !== "none")
    .forEach((c) => {
      const key = c.title.trim().toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });
  const values = Object.values(counts);
  return values.length ? Math.max(...values) : 0;
}

function hasCompletedAnOverdueChallenge(s = state) {
  return s.challenges.some((c) => {
    if (!c.completed || !c.dateCompleted) return false;
    return c.dateCompleted.slice(0, 10) > getChallengeScheduledDate(c);
  });
}

function getCategoryCompletionCounts(s = state) {
  const counts = {};
  getCompletedChallenges(s).forEach((c) => {
    const cat = c.category || "general";
    counts[cat] = (counts[cat] || 0) + 1;
  });
  return counts;
}

function getHabitCompletionCountsByDifficulty(s = state) {
  const counts = { easy: 0, medium: 0, hard: 0 };
  (s.habits || []).forEach((habit) => {
    const hasDifficulty = Object.prototype.hasOwnProperty.call(
      CONFIG.HABIT_XP_REWARDS,
      habit.difficulty
    );
    const difficulty = hasDifficulty ? habit.difficulty : "medium";
    counts[difficulty] += Array.isArray(habit.completedDates) ? habit.completedDates.length : 0;
  });
  return counts;
}

function getHabitCategoryCompletionCounts(s = state) {
  const counts = {};
  (s.habits || []).forEach((habit) => {
    const category = getHabitCategoryId(habit.category);
    counts[category] = (counts[category] || 0) +
      (Array.isArray(habit.completedDates) ? habit.completedDates.length : 0);
  });
  return counts;
}

// -------------------------------------
// Challenges: state functions
// -------------------------------------
function generateId() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function addChallenge(title, difficulty = "easy", scheduledDate = "", category = "general", recurrence = "none") {
  const result = validateText(title, {
    ...VALIDATION_RULES.challengeTitle,
    fieldName: "Challenge title",
  });

  if (!result.isValid) {
    console.warn("addChallenge blocked by validation:", result.errorMessage);
    return false;
  }

  const config = getDifficultyConfig(difficulty);
  const finalScheduledDate = scheduledDate || getTodayDateString();

  const newChallenge = {
    id: generateId(),
    title: result.value,
    difficulty: DIFFICULTY_CONFIG[difficulty] ? difficulty : "easy",
    xpValue: config.xpValue,
    category: CATEGORY_CONFIG[category] ? category : "general",
    recurrence: RECURRENCE_CONFIG[recurrence] ? recurrence : "none",
    scheduledDate: finalScheduledDate,
    completed: false,
    archived: false,
    dateCreated: new Date().toISOString(),
  };
  state.challenges.push(newChallenge);
  state.user.hasSeenFirstStepWelcome = true;
  saveState();
  return true;
}

// Creates the next occurrence of a recurring challenge once its current
// instance is completed, scheduled `offsetDays` after the instance that
// was just finished. Keeps the same title/difficulty/category/recurrence
// so the series continues indefinitely until the user deletes/archives it.
function spawnNextRecurrence(sourceChallenge) {
  const recurrenceConfig = getRecurrenceConfig(sourceChallenge.recurrence);
  if (!recurrenceConfig.offsetDays) return;

  const nextDate = getDateStringWithOffset(recurrenceConfig.offsetDays);

  const nextChallenge = {
    id: generateId(),
    title: sourceChallenge.title,
    difficulty: sourceChallenge.difficulty,
    xpValue: sourceChallenge.xpValue,
    category: sourceChallenge.category || "general",
    recurrence: sourceChallenge.recurrence,
    scheduledDate: nextDate,
    completed: false,
    archived: false,
    dateCreated: new Date().toISOString(),
  };
  state.challenges.push(nextChallenge);
}

function deleteChallenge(id) {
  state.challenges = state.challenges.filter((c) => c.id !== id);
  saveState();
}

function addHabit(title, description = "", difficulty = "medium", category = "general") {
  const result = validateText(title, {
    ...VALIDATION_RULES.challengeTitle,
    fieldName: "Habit name",
  });
  if (!result.isValid) return { ok: false, error: result.errorMessage };
  const cleanDescription = typeof description === "string" ? description.trim() : "";
  if (cleanDescription.length > 180) {
    return { ok: false, error: "Habit descriptions must be 180 characters or fewer." };
  }

  state.habits.push({
    id: generateId(),
    title: result.value,
    createdAt: new Date().toISOString(),
    createdDate: getTodayDateString(),
    description: cleanDescription,
    difficulty: CONFIG.HABIT_XP_REWARDS[difficulty] ? difficulty : "medium",
    category: getHabitCategoryId(category),
    completedDates: [],
    xpAwardedDates: [],
    archived: false,
  });
  saveState();
  return { ok: true };
}

function editHabit(id, title, description, difficulty, category) {
  const habit = state.habits.find((item) => item.id === id);
  if (!habit) return { ok: false, error: "This habit could not be found." };
  const result = validateText(title, {
    ...VALIDATION_RULES.challengeTitle,
    fieldName: "Habit name",
  });
  if (!result.isValid) return { ok: false, error: result.errorMessage };
  const cleanDescription = typeof description === "string" ? description.trim() : "";
  if (cleanDescription.length > 180) {
    return { ok: false, error: "Habit descriptions must be 180 characters or fewer." };
  }

  habit.title = result.value;
  habit.description = cleanDescription;
  if (CONFIG.HABIT_XP_REWARDS[difficulty]) habit.difficulty = difficulty;
  habit.category = getHabitCategoryId(category);
  saveState();
  return { ok: true };
}

function deleteHabit(id) {
  const index = state.habits.findIndex((habit) => habit.id === id);
  if (index < 0) return false;
  state.habits.splice(index, 1);
  saveState();
  return true;
}

function getHabitCheckInCount(habit) {
  return Array.isArray(habit?.completedDates) ? habit.completedDates.length : 0;
}

function getHabitXpForDate(dateStr, s = state) {
  return (s.habitXpLedger || [])
    .filter((entry) => entry.date === dateStr)
    .reduce((total, entry) => total + entry.amount, 0);
}

function toggleHabitCompletion(id, dateStr = getTodayDateString()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || dateStr > getTodayDateString()) {
    return false;
  }

  const habit = state.habits.find((item) => item.id === id && !item.archived);
  if (!habit) return false;

  habit.completedDates = Array.isArray(habit.completedDates) ? habit.completedDates : [];
  habit.xpAwardedDates = Array.isArray(habit.xpAwardedDates) ? habit.xpAwardedDates : [];

  const completionIndex = habit.completedDates.indexOf(dateStr);
  if (completionIndex >= 0) {
    habit.completedDates.splice(completionIndex, 1);
    saveState();
    return true;
  }

  habit.completedDates.push(dateStr);
  if (!habit.xpAwardedDates.includes(dateStr)) {
    habit.xpAwardedDates.push(dateStr);
    const reward = CONFIG.HABIT_XP_REWARDS[habit.difficulty] || CONFIG.HABIT_XP_REWARDS.medium;
    state.habitXpLedger = Array.isArray(state.habitXpLedger) ? state.habitXpLedger : [];
    if (!state.habitXpLedger.some((entry) => entry.id === `${habit.id}:${dateStr}`)) {
      state.habitXpLedger.push({
        id: `${habit.id}:${dateStr}`,
        habitId: habit.id,
        habitTitle: habit.title,
        date: dateStr,
        amount: reward,
      });
      awardXp(reward, { skipSave: true });
    }
  }
  if (dateStr === getTodayDateString()) updateStreak();
  checkBadges({ skipSave: true });
  saveState();
  triggerCompletionFeedback();
  return true;
}

function archiveHabit(id) {
  const habit = state.habits.find((item) => item.id === id);
  if (!habit) return;
  habit.archived = !habit.archived;
  saveState();
}

function getActiveHabits(s = state) {
  return (s.habits || []).filter((habit) => !habit.archived);
}

function getHabitCompletionsForDate(dateStr, s = state, includeArchived = false) {
  const habits = includeArchived ? (s.habits || []) : getActiveHabits(s);
  return habits.filter(
    (habit) => Array.isArray(habit.completedDates) && habit.completedDates.includes(dateStr)
  );
}

function getHabitCompletionDates(s = state) {
  return [...new Set(
    (s.habits || []).flatMap((habit) => Array.isArray(habit.completedDates) ? habit.completedDates : [])
  )].sort();
}

function getLongestHabitStreak(s = state) {
  let longest = 0;
  let current = 0;
  let previousDate = null;
  getHabitCompletionDates(s).forEach((dateStr) => {
    current = previousDate && getDaysBetween(previousDate, dateStr) === 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previousDate = dateStr;
  });
  return longest;
}

function getOverallHabitStreakStats(s = state, today = getTodayDateString()) {
  const dates = new Set(getHabitCompletionDates(s));
  let current = 0;
  let cursor = dates.has(today) ? today : addDaysToDateString(today, -1);
  while (dates.has(cursor)) {
    current += 1;
    cursor = addDaysToDateString(cursor, -1);
  }
  return { current, longest: getLongestHabitStreak(s) };
}

function getTotalHabitCompletions(s = state) {
  return (s.habits || []).reduce(
    (total, habit) => total + (Array.isArray(habit.completedDates) ? habit.completedDates.length : 0),
    0
  );
}

function addDaysToDateString(dateStr, offset) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getHabitStreakStats(habit, today = getTodayDateString()) {
  const dates = new Set(Array.isArray(habit.completedDates) ? habit.completedDates : []);
  let longest = 0;
  let streak = 0;
  let previous = null;
  [...dates].sort().forEach((date) => {
    streak = previous && getDaysBetween(previous, date) === 1 ? streak + 1 : 1;
    longest = Math.max(longest, streak);
    previous = date;
  });

  let current = 0;
  let cursor = dates.has(today) ? today : addDaysToDateString(today, -1);
  while (dates.has(cursor)) {
    current += 1;
    cursor = addDaysToDateString(cursor, -1);
  }
  return { current, longest };
}

function getHabitCompletionRate(habits, startDate, endDate) {
  let expected = 0;
  let completed = 0;
  const today = getTodayDateString();
  const effectiveEnd = endDate > today ? today : endDate;
  if (effectiveEnd < startDate) return { expected, completed, percent: 0 };

  habits.forEach((habit) => {
    const firstEligibleDate = habit.createdDate || (habit.createdAt || "").slice(0, 10) || startDate;
    let cursor = firstEligibleDate > startDate ? firstEligibleDate : startDate;
    while (cursor <= effectiveEnd) {
      expected += 1;
      if (Array.isArray(habit.completedDates) && habit.completedDates.includes(cursor)) completed += 1;
      cursor = addDaysToDateString(cursor, 1);
    }
  });
  return { expected, completed, percent: expected ? Math.round((completed / expected) * 100) : 0 };
}

function getHabitOverallCompletionRate(habits = getActiveHabits()) {
  const today = getTodayDateString();
  const firstHabitDate = habits
    .map((habit) => habit.createdDate || (habit.createdAt || "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()[0];
  return firstHabitDate
    ? getHabitCompletionRate(habits, firstHabitDate, today).percent
    : 0;
}

function getHabitAnalytics(period = "week") {
  const today = getTodayDateString();
  const activeHabits = getActiveHabits();
  const todayDate = new Date(`${today}T00:00:00`);
  let startDate = today;
  let endDate = today;

  if (period === "week") {
    startDate = addDaysToDateString(today, -todayDate.getDay());
    endDate = addDaysToDateString(startDate, 6);
  } else if (period === "month") {
    startDate = `${today.slice(0, 8)}01`;
    endDate = `${today.slice(0, 7)}-${String(new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
  }

  const rate = getHabitCompletionRate(activeHabits, startDate, endDate);
  const completedHabits = activeHabits.filter((habit) =>
    (habit.completedDates || []).some((date) => date >= startDate && date <= today)
  );
  const missedHabits = activeHabits.filter((habit) => {
    const firstEligibleDate = habit.createdDate || (habit.createdAt || "").slice(0, 10) || startDate;
    const from = firstEligibleDate > startDate ? firstEligibleDate : startDate;
    for (let cursor = from; cursor <= today; cursor = addDaysToDateString(cursor, 1)) {
      if (!(habit.completedDates || []).includes(cursor)) return true;
    }
    return false;
  });
  const consistency = activeHabits.map((habit) => {
    const habitRate = getHabitCompletionRate([habit], startDate, endDate);
    return { habit, ...habitRate, ...getHabitStreakStats(habit, today) };
  }).sort((a, b) => b.percent - a.percent || b.current - a.current);

  let dailyPoints = [];
  if (period === "day") {
    const completedToday = getHabitCompletionsForDate(today);
    dailyPoints = [{ label: "Today", percent: activeHabits.length ? Math.round((completedToday.length / activeHabits.length) * 100) : 0 }];
  } else if (period === "week") {
    dailyPoints = Array.from({ length: 7 }, (_, index) => {
      const date = addDaysToDateString(startDate, index);
      const dayRate = getHabitCompletionRate(activeHabits, date, date);
      return {
        label: CALENDAR_WEEKDAY_LABELS[new Date(`${date}T00:00:00`).getDay()],
        date,
        percent: dayRate.percent,
      };
    }).filter((point) => point.date <= today);
  } else {
    const monthLength = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate();
    const buckets = Math.ceil(monthLength / 7);
    dailyPoints = Array.from({ length: buckets }, (_, index) => {
      const from = addDaysToDateString(startDate, index * 7);
      const to = addDaysToDateString(startDate, Math.min(index * 7 + 6, monthLength - 1));
      const bucketRate = getHabitCompletionRate(activeHabits, from, to);
      return { label: `Week ${index + 1}`, percent: bucketRate.percent };
    });
  }

  const todayCompleted = getHabitCompletionsForDate(today);
  const currentMonthRate = getHabitCompletionRate(activeHabits, startDate, today);
  const priorMonthStart = `${new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1).getFullYear()}-${String(new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1).getMonth() + 1).padStart(2, "0")}-01`;
  const priorMonthEndDay = Math.min(todayDate.getDate(), new Date(todayDate.getFullYear(), todayDate.getMonth(), 0).getDate());
  const priorMonthEnd = `${priorMonthStart.slice(0, 7)}-${String(priorMonthEndDay).padStart(2, "0")}`;
  const priorMonthRate = getHabitCompletionRate(activeHabits, priorMonthStart, priorMonthEnd);
  const overallStreak = getOverallHabitStreakStats(state, today);
  let bestPerformingDay = null;
  if (period === "month") {
    const weekdayTotals = Array.from({ length: 7 }, (_, weekday) => {
      let completed = 0;
      let expected = 0;
      for (let cursor = startDate; cursor <= today; cursor = addDaysToDateString(cursor, 1)) {
        if (new Date(`${cursor}T00:00:00`).getDay() !== weekday) continue;
        const dayRate = getHabitCompletionRate(activeHabits, cursor, cursor);
        completed += dayRate.completed;
        expected += dayRate.expected;
      }
      return { weekday, percent: expected ? Math.round((completed / expected) * 100) : -1 };
    }).filter((item) => item.percent >= 0);
    if (weekdayTotals.length) {
      const best = weekdayTotals.sort((a, b) => b.percent - a.percent)[0];
      bestPerformingDay = { label: CALENDAR_WEEKDAY_LABELS[best.weekday], percent: best.percent };
    }
  }

  return {
    period,
    startDate,
    endDate: endDate > today ? today : endDate,
    percent: rate.percent,
    completed: rate.completed,
    expected: rate.expected,
    activeCount: activeHabits.length,
    totalCount: (state.habits || []).length,
    overallPercent: getHabitOverallCompletionRate(activeHabits),
    completedHabitCount: completedHabits.length,
    todayCompleted: todayCompleted.length,
    todayRemaining: Math.max(0, activeHabits.length - todayCompleted.length),
    currentStreak: overallStreak.current,
    bestStreak: overallStreak.longest,
    dailyPoints,
    consistentHabits: consistency.slice(0, 3),
    missedHabits,
    monthlyDelta: priorMonthRate.expected
      ? currentMonthRate.percent - priorMonthRate.percent
      : null,
    bestPerformingDay,
  };
}

// -------------------------------------
// Challenges: archive system
// -------------------------------------
// Archiving hides a challenge from the normal Active/Completed lists
// without permanently deleting it (and its history/XP stay intact for
// stats and badges). Only completed challenges are meant to be archived.
function archiveChallenge(id) {
  const challenge = state.challenges.find((c) => c.id === id);
  if (!challenge) return;
  challenge.archived = true;
  saveState();
}

function unarchiveChallenge(id) {
  const challenge = state.challenges.find((c) => c.id === id);
  if (!challenge) return;
  challenge.archived = false;
  saveState();
}

// -------------------------------------
// Challenges: due-date urgency
// -------------------------------------
// Returns a comparable urgency rank for sorting: overdue challenges sort
// first (most negative = most overdue), then today, then soonest upcoming.
function getChallengeUrgencyDays(challenge) {
  return getDaysBetween(getTodayDateString(), getChallengeScheduledDate(challenge));
}

function getUrgencyStatus(challenge) {
  const days = getChallengeUrgencyDays(challenge);
  if (days < 0) return "overdue";
  if (days === 0) return "due-today";
  return "upcoming";
}

// Sorts active (incomplete) challenges by due-date urgency: overdue first
// (oldest overdue first), then due today, then soonest upcoming.
function sortByUrgency(challenges) {
  return [...challenges].sort(
    (a, b) => getChallengeUrgencyDays(a) - getChallengeUrgencyDays(b)
  );
}

function getOverdueChallenges(s = state) {
  return sortByUrgency(
    s.challenges.filter(
      (c) => !c.completed && !c.archived && !isRunningLockIn(c) && getChallengeUrgencyDays(c) < 0
    )
  );
}

function getDueTodayChallenges(s = state) {
  return s.challenges.filter(
    (c) => !c.completed && !c.archived && !isRunningLockIn(c) && getChallengeUrgencyDays(c) === 0
  );
}

// -------------------------------------
// Lock In: focused timed sessions
// -------------------------------------
// A Lock In session is a challenge with isLockIn=true and a live
// startedAt timestamp. It behaves like any other challenge once
// finished (counts for XP/streak/badges/stats) but while running it's
// surfaced through its own dedicated panel instead of the normal list,
// and it doesn't force-stop when the target time is reached - it just
// notifies and switches into an "overtime" state so the user can keep
// going or wrap up whenever they choose. Sessions can be paused (the
// clock stops accumulating) and the target time can be extended
// mid-session without losing progress.
const LOCKIN_DURATION_OPTIONS = [25, 45, 60, 90];

// XP per minute, by difficulty - mirrors the ~1:2:3.5 ratio regular
// challenges use (10/20/35 XP), scaled down to a per-minute rate.
const LOCKIN_XP_RATE = { easy: 1, medium: 1.5, hard: 2.5 };
// Minutes spent in overtime (past the original target) earn extra,
// rewarding pushing through rather than stopping right at the buzzer.
const LOCKIN_OVERTIME_MULTIPLIER = 1.5;

function isRunningLockIn(c) {
  return Boolean(c.isLockIn && c.startedAt && !c.completed);
}

function getActiveLockIn(s = state) {
  return s.challenges.find((c) => isRunningLockIn(c)) || null;
}

function formatLockInDuration(totalSeconds) {
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) return "<1m";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatLockInClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Base minutes (up to the target) earn the difficulty's flat rate;
// anything beyond the original target earns that rate boosted by the
// overtime multiplier. Difficulty affects the rate, not a fixed total,
// so extending or overshooting the session always earns proportionally.
function computeLockInXp(targetMinutes, actualMinutes, difficulty) {
  const rate = LOCKIN_XP_RATE[difficulty] || LOCKIN_XP_RATE.medium;
  const baseMinutes = Math.min(actualMinutes, targetMinutes);
  const overtimeMinutes = Math.max(0, actualMinutes - targetMinutes);
  const xp = baseMinutes * rate + overtimeMinutes * rate * LOCKIN_OVERTIME_MULTIPLIER;
  return Math.max(1, Math.round(xp));
}

// Elapsed time is pause-aware: accumulatedSeconds holds everything
// banked from prior running segments, and - only while not paused - we
// add the time since the current segment's startedAt.
function getLockInElapsedSeconds(challenge) {
  const accumulated = challenge.accumulatedSeconds || 0;
  if (challenge.isPaused) return accumulated;
  return accumulated + Math.floor((Date.now() - new Date(challenge.startedAt).getTime()) / 1000);
}

function startLockIn(title, targetMinutes, difficulty = "medium", quietFocusEnabled = state.preferences.blockNotificationsDuringLockIn) {
  const result = validateText(title, {
    ...VALIDATION_RULES.challengeTitle,
    fieldName: "Session title",
  });

  if (!result.isValid) {
    return { ok: false, error: result.errorMessage };
  }

  if (getActiveLockIn()) {
    return { ok: false, error: "Finish or cancel your current session first." };
  }

  const minutes = Math.min(240, Math.max(1, parseInt(targetMinutes, 10) || 0));
  if (!minutes) {
    return { ok: false, error: "Enter a valid number of minutes." };
  }

  const finalDifficulty = DIFFICULTY_CONFIG[difficulty] ? difficulty : "medium";
  state.preferences.lastLockInDuration = minutes;
  state.preferences.blockNotificationsDuringLockIn = Boolean(quietFocusEnabled);

  const newSession = {
    id: generateId(),
    title: result.value,
    difficulty: finalDifficulty,
    xpValue: computeLockInXp(minutes, minutes, finalDifficulty),
    category: "lockin",
    recurrence: "none",
    scheduledDate: getTodayDateString(),
    completed: false,
    archived: false,
    dateCreated: new Date().toISOString(),
    isLockIn: true,
    targetMinutes: minutes,
    startedAt: new Date().toISOString(),
    accumulatedSeconds: 0,
    isPaused: false,
    wasInterrupted: false,
    notifiedAtTarget: false,
    actualMinutes: null,
    sessionNote: "",
    sessionNoteColor: getRandomLockInNoteColor(),
  };

  state.challenges.push(newSession);
  saveState();
  return { ok: true };
}

function pauseLockIn(id) {
  const challenge = state.challenges.find((c) => c.id === id);
  if (!challenge || !isRunningLockIn(challenge) || challenge.isPaused) return;
  challenge.accumulatedSeconds = getLockInElapsedSeconds(challenge);
  challenge.isPaused = true;
  saveState();
}

function resumeLockIn(id) {
  const challenge = state.challenges.find((c) => c.id === id);
  if (!challenge || !isRunningLockIn(challenge) || !challenge.isPaused) return;
  challenge.startedAt = new Date().toISOString();
  challenge.isPaused = false;
  challenge.wasInterrupted = false;
  saveState();
}

function addLockInTime(id, extraMinutes) {
  const challenge = state.challenges.find((c) => c.id === id);
  if (!challenge || !isRunningLockIn(challenge)) return;
  challenge.targetMinutes = Math.min(480, challenge.targetMinutes + extraMinutes);
  // Allow a fresh "time's up" notification once the new, later target is reached.
  challenge.notifiedAtTarget = false;
  saveState();
}

function finishLockIn(id) {
  const challenge = state.challenges.find((c) => c.id === id);
  if (!challenge || challenge.completed) return;

  const elapsedSec = getLockInElapsedSeconds(challenge);
  challenge.actualMinutes = Math.max(1, Math.round(elapsedSec / 60));
  challenge.xpValue = computeLockInXp(challenge.targetMinutes, challenge.actualMinutes, challenge.difficulty);
  delete challenge.sessionNote;
  delete challenge.sessionNoteColor;
  delete challenge.savedNoteId;
  completeChallenge(id);
  stopLockInTicker();
  closeLockInPictureInPicture();
  if (getFloatingWidget("timer")?.id === id) setFloatingWidget("timer", null);
  closeSessionNotePictureInPicture();
  if (getFloatingWidget("note")?.kind === "session" && getFloatingWidget("note")?.id === id) {
    setFloatingWidget("note", null);
  }
}

function cancelLockIn(id) {
  const active = state.challenges.find((challenge) => challenge.id === id);
  deleteChallenge(id);
  stopLockInTicker();
  closeLockInPictureInPicture();
  if (getFloatingWidget("timer")?.id === id) setFloatingWidget("timer", null);
  closeSessionNotePictureInPicture();
  if (getFloatingWidget("note")?.kind === "session" && getFloatingWidget("note")?.id === id) {
    setFloatingWidget("note", null);
  }
}

function setBlockNotificationsDuringLockIn(enabled) {
  state.preferences.blockNotificationsDuringLockIn = Boolean(enabled);
  saveState();
}

// Updates the live timer DOM directly (rather than a full renderView())
// so the countdown can tick every second without disrupting focus/typing
// elsewhere on the page. Self-stops once there's no active session or
// its own elements are no longer on screen.
function updateLockInTimerDisplay() {
  const active = getActiveLockIn();
  const timeEl = document.getElementById("lockin-timer");
  const statusEl = document.getElementById("lockin-status");
  const progressEl = document.getElementById("lockin-progress-fill");
  const pauseBtn = document.getElementById("lockin-pause-btn");

  if (!active) {
    stopLockInTicker();
    return;
  }

  if (pauseBtn) pauseBtn.textContent = active.isPaused ? "Resume" : "Pause";

  const elapsedSec = getLockInElapsedSeconds(active);
  const targetSec = active.targetMinutes * 60;
  const overBy = elapsedSec - targetSec;
  const remainingSec = Math.max(0, targetSec - elapsedSec);
  const circumference = 2 * Math.PI * 48;
  const projectedXp = computeLockInXp(active.targetMinutes, Math.max(1, Math.round(elapsedSec / 60)), active.difficulty);
  const progressPercent = Math.min(100, (elapsedSec / targetSec) * 100);

  if (overBy >= 0) {
    if (timeEl) {
      timeEl.textContent = overBy === 0
        ? "Focus block complete"
        : `${formatLockInClock(overBy)} overtime`;
    }
    if (statusEl) {
      statusEl.textContent = active.isPaused ? "⏸️ Paused (in overtime)" : "🔥 Overtime - keep going or finish anytime";
      statusEl.classList.toggle("is-overtime", !active.isPaused);
      statusEl.classList.toggle("is-paused", active.isPaused);
    }
    if (progressEl) {
      if (progressEl.tagName.toLowerCase() === "circle") {
        progressEl.style.strokeDashoffset = "0";
      } else {
        progressEl.style.width = "100%";
      }
      progressEl.closest("svg")?.setAttribute("aria-valuenow", "100");
    }

    if (!active.notifiedAtTarget && !active.isPaused) {
      active.notifiedAtTarget = true;
      saveState();
      addNotification(`Lock In time's up for "${active.title}" - you can keep going!`, "⏰");
      if (!areQuestifyNotificationsMuted()) triggerCompletionFeedback();
    }
  } else {
    if (timeEl) timeEl.textContent = `${formatLockInClock(remainingSec)} remaining`;
    if (statusEl) {
      statusEl.textContent = active.isPaused ? "⏸️ Paused" : "Locked in...";
      statusEl.classList.remove("is-overtime");
      statusEl.classList.toggle("is-paused", active.isPaused);
    }
    if (progressEl) {
      if (progressEl.tagName.toLowerCase() === "circle") {
        progressEl.style.strokeDashoffset = String(circumference * (1 - progressPercent / 100));
      } else {
        progressEl.style.width = `${progressPercent}%`;
      }
      progressEl.closest("svg")?.setAttribute("aria-valuenow", String(Math.round(progressPercent)));
    }
  }

  const xpEl = document.getElementById("lockin-xp-preview");
  if (xpEl) xpEl.textContent = `~${projectedXp} XP so far`;
  updateLockInPictureInPicture(active, elapsedSec);
  updateLockInPictureInPictureButton();
  const floatingTimer = document.getElementById("floating-lockin-timer-value");
  if (floatingTimer) {
    floatingTimer.textContent = active.isPaused
      ? `Paused · ${formatLockInClock(remainingSec)}`
      : remainingSec > 0
      ? `${formatLockInClock(remainingSec)} remaining`
      : `${formatLockInClock(overBy)} overtime`;
  }
  const floatingPause = document.querySelector("[data-floating-timer-pause]");
  if (floatingPause) floatingPause.textContent = active.isPaused ? "Resume" : "Pause";
}

function startLockInTicker() {
  stopLockInTicker();
  lockInIntervalId = setInterval(updateLockInTimerDisplay, 1000);
  updateLockInTimerDisplay();
}

function stopLockInTicker() {
  if (lockInIntervalId) {
    clearInterval(lockInIntervalId);
    lockInIntervalId = null;
  }
}

function handleLockInPageHide() {
  const active = getActiveLockIn();
  if (!active || active.isPaused) return;

  active.accumulatedSeconds = getLockInElapsedSeconds(active);
  active.isPaused = true;
  active.wasInterrupted = true;
  saveState();
  stopLockInTicker();
}

function renderLockInExitDialog() {
  const active = getActiveLockIn();
  if (!active?.wasInterrupted) return "";

  return `
    <div class="modal-overlay lockin-exit-overlay">
      <section class="modal-card card lockin-exit-dialog" role="dialog" aria-modal="true" aria-labelledby="lockin-exit-title" aria-describedby="lockin-exit-description">
        <div class="lockin-exit-dialog__icon" aria-hidden="true">⏸️</div>
        <p class="dashboard-section__eyebrow">YOUR FOCUS SESSION</p>
        <h2 id="lockin-exit-title">Your Lock In was paused</h2>
        <p id="lockin-exit-description" class="text-muted">
          The timer stopped when you left. Cancel the timer, finish your session, or leave it paused.
        </p>
        <div class="lockin-exit-dialog__actions">
          <button type="button" class="btn-secondary" data-lockin-exit-action="cancel">Cancel timer &amp; exit</button>
          <button type="button" class="btn" data-lockin-exit-action="finish">Finish session</button>
          <button type="button" class="btn-secondary" data-lockin-exit-action="quit">Leave with timer paused</button>
          <button type="button" class="btn-secondary" data-lockin-exit-action="resume">Return and continue Lock In</button>
        </div>
      </section>
    </div>
  `;
}

function attachLockInExitDialogHandlers() {
  const dialog = document.querySelector(".lockin-exit-dialog");
  if (!dialog) return;

  dialog.querySelectorAll("[data-lockin-exit-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const active = getActiveLockIn();
      if (!active) return;

      switch (button.dataset.lockinExitAction) {
        case "cancel":
          cancelLockIn(active.id);
          navigateTo("dashboard");
          break;
        case "finish":
          finishLockIn(active.id);
          navigateTo("dashboard");
          break;
        case "quit":
          active.wasInterrupted = false;
          saveState();
          navigateTo("dashboard");
          break;
        case "resume":
          resumeLockIn(active.id);
          navigateTo("lockin");
          break;
        default:
          console.error(`Unknown Lock In exit action: "${button.dataset.lockinExitAction}"`);
      }
    });
  });

  dialog.querySelector("[data-lockin-exit-action='quit']")?.focus();
}

window.addEventListener("beforeunload", (event) => {
  if (isLockInFocusWindow || isStickyNoteWindow || isLockInTimerWindow || isSessionNoteWindow) return;
  const active = getActiveLockIn();
  if (!active || active.isPaused) return;

  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("pagehide", () => {
  if (isLockInFocusWindow || isStickyNoteWindow || isLockInTimerWindow || isSessionNoteWindow) return;
  handleLockInPageHide();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && getActiveLockIn()?.wasInterrupted) renderView();
});

// -------------------------------------
// Leveling: pure functions
// -------------------------------------
function xpRequiredForLevel(level) {
  return level * CONFIG.XP_PER_LEVEL_MULTIPLIER;
}

function calculateLevel(totalXp) {
  let level = 1;
  let xpRemaining = totalXp;

  while (xpRemaining >= xpRequiredForLevel(level)) {
    xpRemaining -= xpRequiredForLevel(level);
    level++;
  }

  return level;
}

function xpIntoCurrentLevel(totalXp) {
  let level = 1;
  let xpRemaining = totalXp;

  while (xpRemaining >= xpRequiredForLevel(level)) {
    xpRemaining -= xpRequiredForLevel(level);
    level++;
  }

  return xpRemaining;
}

function awardXp(amount, opts = {}) {
  const levelBefore = state.user.level;

  state.user.xp += amount;
  state.user.level = calculateLevel(state.user.xp);

  if (!opts.skipSave) saveState();

  if (state.user.level > levelBefore) {
    addNotification(`Level Up! You reached Level ${state.user.level}`, "🎉");
  }
}

// -------------------------------------
// Streaks: date helpers
// -------------------------------------
function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDaysBetween(dateStr1, dateStr2) {
  const d1 = new Date(`${dateStr1}T00:00:00`);
  const d2 = new Date(`${dateStr2}T00:00:00`);
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((d2 - d1) / msPerDay);
}

// Returns "YYYY-MM-DD" for today shifted by `offsetDays` (can be negative)
function getDateStringWithOffset(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Turns a "YYYY-MM-DD" into a friendly label: "Today", "Tomorrow",
// "Yesterday", or "Aug 15" for anything further out.
function formatScheduledDateLabel(dateStr) {
  // Validate and sanitize date string
  if (!dateStr || typeof dateStr !== "string") {
    return "Today";
  }
  
  if (dateStr === getTodayDateString()) return "Today";
  if (dateStr === getDateStringWithOffset(1)) return "Tomorrow";
  if (dateStr === getDateStringWithOffset(-1)) return "Yesterday";
  
  try {
    const d = new Date(`${dateStr}T00:00:00`);
    if (isNaN(d.getTime())) return "Today";
    return `${CALENDAR_MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  } catch (e) {
    return "Today";
  }
}

function updateStreak() {
  const today = getTodayDateString();
  const lastDate = state.user.lastCompletedDate;

  if (!lastDate) {
    state.user.streak = 1;
  } else {
    const daysGap = getDaysBetween(lastDate, today);

    if (daysGap === 0) {
      // already completed something today - streak unchanged
    } else if (daysGap === 1) {
      state.user.streak += 1;
    } else if (daysGap > 1) {
      state.user.streak = 1;
    }
  }

  state.user.lastCompletedDate = today;
}

// -------------------------------------
// Badges: definitions (rules as data)
// -------------------------------------
// Each badge carries a `tier`: "easy" ones are reachable within a user's
// first few sessions and double as a tour of every feature (Lock In,
// recurring challenges, archiving, categories, weekly goals...); "hard"
// ones are longer-run milestones and mastery goals.
const BADGES = [
  // ============= EASY (11) - quick wins that also introduce features =============
  {
    id: "first-challenge",
    tier: "easy",
    name: "First Step",
    description: "Complete your first challenge",
    icon: "🌱",
    condition: (s) => getCompletedChallenges(s).length >= 1,
  },
  {
    id: "first-lockin",
    tier: "easy",
    name: "Locked In",
    description: "Complete your first Lock In session",
    icon: "🔒",
    condition: (s) => getCompletedLockIns(s).length >= 1,
  },
  {
    id: "five-challenges",
    tier: "easy",
    name: "Getting Started",
    description: "Complete 5 challenges",
    icon: "⭐",
    condition: (s) => getCompletedChallenges(s).length >= 5,
  },
  {
    id: "streak-3",
    tier: "easy",
    name: "On a Roll",
    description: "Reach a 3-day streak",
    icon: "🔥",
    condition: (s) => s.user.streak >= 3,
  },
  {
    id: "first-recurring",
    tier: "easy",
    name: "Habit Loop",
    description: "Complete a recurring challenge",
    icon: "🔁",
    condition: (s) => s.challenges.some((c) => c.completed && c.recurrence && c.recurrence !== "none"),
  },
  {
    id: "first-archive",
    tier: "easy",
    name: "Tidy Up",
    description: "Archive a completed challenge",
    icon: "🗂️",
    condition: (s) => s.challenges.some((c) => c.archived),
  },
  {
    id: "first-planned",
    tier: "easy",
    name: "Planner",
    description: "Schedule a challenge for a future date",
    icon: "🗓️",
    condition: (s) =>
      s.challenges.some((c) => c.scheduledDate && c.dateCreated && c.scheduledDate > c.dateCreated.slice(0, 10)),
  },
  {
    id: "category-explorer",
    tier: "easy",
    name: "Explorer",
    description: "Complete challenges or habits in 3 different categories",
    icon: "🧭",
    condition: (s) => {
      const counts = { ...getCategoryCompletionCounts(s) };
      Object.entries(getHabitCategoryCompletionCounts(s)).forEach(([category, total]) => {
        counts[category] = (counts[category] || 0) + total;
      });
      return Object.keys(counts).filter((k) => k !== "lockin").length >= 3;
    },
  },
  {
    id: "level-2",
    tier: "easy",
    name: "Leveling Up",
    description: "Reach Level 2",
    icon: "🆙",
    condition: (s) => s.user.level >= 2,
  },
  {
    id: "goal-setter",
    tier: "easy",
    name: "Goal Setter",
    description: "Set a custom daily goal",
    icon: "🏁",
    condition: (s) => (s.user.dailyGoal || CONFIG.DEFAULT_DAILY_GOAL) !== CONFIG.DEFAULT_DAILY_GOAL,
  },
  {
    id: "first-daily-habit",
    tier: "easy",
    name: "Daily Ritual",
    description: "Complete your first daily habit",
    icon: "🌿",
    condition: (s) => getTotalHabitCompletions(s) >= 1,
  },

  // ============= HARD (53) - longer-run milestones and mastery goals =============

  // --- Challenge count milestones ---
  {
    id: "ten-challenges",
    tier: "hard",
    name: "Building Momentum",
    description: "Complete 10 challenges",
    icon: "🔟",
    condition: (s) => getCompletedChallenges(s).length >= 10,
  },
  {
    id: "twenty-challenges",
    tier: "hard",
    name: "Dedicated",
    description: "Complete 20 challenges",
    icon: "🏆",
    condition: (s) => getCompletedChallenges(s).length >= 20,
  },
  {
    id: "fifty-challenges",
    tier: "hard",
    name: "Unstoppable",
    description: "Complete 50 challenges",
    icon: "🚴",
    condition: (s) => getCompletedChallenges(s).length >= 50,
  },
  {
    id: "hundred-challenges",
    tier: "hard",
    name: "Centurion",
    description: "Complete 100 challenges",
    icon: "🛡️",
    condition: (s) => getCompletedChallenges(s).length >= 100,
  },
  {
    id: "two-fifty-challenges",
    tier: "hard",
    name: "Relentless",
    description: "Complete 250 challenges",
    icon: "🎖️",
    condition: (s) => getCompletedChallenges(s).length >= 250,
  },
  {
    id: "five-hundred-challenges",
    tier: "hard",
    name: "Titan",
    description: "Complete 500 challenges",
    icon: "🏅",
    condition: (s) => getCompletedChallenges(s).length >= 500,
  },

  // --- Level milestones ---
  {
    id: "level-5",
    tier: "hard",
    name: "Veteran",
    description: "Reach Level 5",
    icon: "👑",
    condition: (s) => s.user.level >= 5,
  },
  {
    id: "level-7",
    tier: "hard",
    name: "Seasoned",
    description: "Reach Level 7",
    icon: "🦅",
    condition: (s) => s.user.level >= 7,
  },
  {
    id: "level-10",
    tier: "hard",
    name: "Elite",
    description: "Reach Level 10",
    icon: "🔱",
    condition: (s) => s.user.level >= 10,
  },
  {
    id: "level-15",
    tier: "hard",
    name: "Master",
    description: "Reach Level 15",
    icon: "🌟",
    condition: (s) => s.user.level >= 15,
  },
  {
    id: "level-20",
    tier: "hard",
    name: "Legend",
    description: "Reach Level 20",
    icon: "🐉",
    condition: (s) => s.user.level >= 20,
  },
  {
    id: "level-25",
    tier: "hard",
    name: "Mythic",
    description: "Reach Level 25",
    icon: "🔮",
    condition: (s) => s.user.level >= 25,
  },
  {
    id: "level-30",
    tier: "hard",
    name: "Ascended",
    description: "Reach Level 30",
    icon: "🌌",
    condition: (s) => s.user.level >= 30,
  },
  {
    id: "level-40",
    tier: "hard",
    name: "Immortal",
    description: "Reach Level 40",
    icon: "⚔️",
    condition: (s) => s.user.level >= 40,
  },
  {
    id: "level-50",
    tier: "hard",
    name: "Godlike",
    description: "Reach Level 50",
    icon: "☀️",
    condition: (s) => s.user.level >= 50,
  },

  // --- Streak milestones ---
  {
    id: "streak-7",
    tier: "hard",
    name: "Week Warrior",
    description: "Reach a 7-day streak",
    icon: "🗓️",
    condition: (s) => s.user.streak >= 7,
  },
  {
    id: "streak-14",
    tier: "hard",
    name: "Fortnight Focus",
    description: "Reach a 14-day streak",
    icon: "📅",
    condition: (s) => s.user.streak >= 14,
  },
  {
    id: "streak-30",
    tier: "hard",
    name: "Monthly Master",
    description: "Reach a 30-day streak",
    icon: "🏔️",
    condition: (s) => s.user.streak >= 30,
  },
  {
    id: "streak-60",
    tier: "hard",
    name: "Iron Will",
    description: "Reach a 60-day streak",
    icon: "⛓️",
    condition: (s) => s.user.streak >= 60,
  },
  {
    id: "streak-100",
    tier: "hard",
    name: "Unbreakable",
    description: "Reach a 100-day streak",
    icon: "💠",
    condition: (s) => s.user.streak >= 100,
  },
  {
    id: "streak-365",
    tier: "hard",
    name: "Full Year",
    description: "Reach a 365-day streak",
    icon: "🎇",
    condition: (s) => s.user.streak >= 365,
  },

  // --- XP milestones ---
  {
    id: "xp-500",
    tier: "hard",
    name: "Century",
    description: "Earn 500 total XP",
    icon: "💯",
    condition: (s) => s.user.xp >= 500,
  },
  {
    id: "xp-1000",
    tier: "hard",
    name: "Grandmaster",
    description: "Earn 1000 total XP",
    icon: "💎",
    condition: (s) => s.user.xp >= 1000,
  },
  {
    id: "xp-2000",
    tier: "hard",
    name: "Overachiever",
    description: "Earn 2000 total XP",
    icon: "🧠",
    condition: (s) => s.user.xp >= 2000,
  },
  {
    id: "xp-5000",
    tier: "hard",
    name: "XP Hoarder",
    description: "Earn 5000 total XP",
    icon: "🪙",
    condition: (s) => s.user.xp >= 5000,
  },
  {
    id: "xp-10000",
    tier: "hard",
    name: "XP Legend",
    description: "Earn 10,000 total XP",
    icon: "✨",
    condition: (s) => s.user.xp >= 10000,
  },
  {
    id: "habit-week-streak",
    tier: "hard",
    name: "Ritual Keeper",
    description: "Complete at least one habit for 7 days in a row",
    icon: "🌱",
    condition: (s) => getLongestHabitStreak(s) >= 7,
  },
  {
    id: "habit-50-checkins",
    tier: "hard",
    name: "Habit Architect",
    description: "Log 50 daily habit completions",
    icon: "🧱",
    condition: (s) => getTotalHabitCompletions(s) >= 50,
  },

  // --- Difficulty & variety ---
  {
    id: "challenge-crusher",
    tier: "hard",
    name: "Challenge Crusher",
    description: "Complete a Hard difficulty challenge",
    icon: "💪",
    condition: (s) => s.challenges.some((c) => c.completed && c.difficulty === "hard"),
  },
  {
    id: "well-rounded",
    tier: "hard",
    name: "Well Rounded",
    description: "Complete one Easy, Medium, and Hard challenge or habit check-in",
    icon: "🎯",
    condition: (s) => {
      const challengeCounts = getCompletionCountByDifficulty(s);
      const habitCounts = getHabitCompletionCountsByDifficulty(s);
      return ["easy", "medium", "hard"].every(
        (difficulty) => challengeCounts[difficulty] + habitCounts[difficulty] >= 1
      );
    },
  },
  {
    id: "easy-specialist",
    tier: "hard",
    name: "Easy Specialist",
    description: "Complete 10 Easy challenges or habit check-ins",
    icon: "🍀",
    condition: (s) => getCompletionCountByDifficulty(s).easy + getHabitCompletionCountsByDifficulty(s).easy >= 10,
  },
  {
    id: "medium-specialist",
    tier: "hard",
    name: "Medium Specialist",
    description: "Complete 10 Medium challenges or habit check-ins",
    icon: "🎲",
    condition: (s) => getCompletionCountByDifficulty(s).medium + getHabitCompletionCountsByDifficulty(s).medium >= 10,
  },
  {
    id: "hard-specialist",
    tier: "hard",
    name: "Hard Specialist",
    description: "Complete 10 Hard challenges or habit check-ins",
    icon: "🥋",
    condition: (s) => getCompletionCountByDifficulty(s).hard + getHabitCompletionCountsByDifficulty(s).hard >= 10,
  },
  {
    id: "hard-master",
    tier: "hard",
    name: "Hard Master",
    description: "Complete 25 Hard challenges or habit check-ins",
    icon: "🐺",
    condition: (s) => getCompletionCountByDifficulty(s).hard + getHabitCompletionCountsByDifficulty(s).hard >= 25,
  },

  // --- Time-based ---
  {
    id: "early-bird",
    tier: "hard",
    name: "Early Bird",
    description: "Complete a challenge before 8 AM",
    icon: "🌅",
    condition: (s) =>
      s.challenges.some((c) => {
        if (!c.completed || !c.dateCompleted) return false;
        return new Date(c.dateCompleted).getHours() < 8;
      }),
  },
  {
    id: "night-owl",
    tier: "hard",
    name: "Night Owl",
    description: "Complete a challenge after 10 PM",
    icon: "🦉",
    condition: (s) =>
      s.challenges.some((c) => {
        if (!c.completed || !c.dateCompleted) return false;
        return new Date(c.dateCompleted).getHours() >= 22;
      }),
  },
  {
    id: "around-the-clock",
    tier: "hard",
    name: "Around the Clock",
    description: "Earn both Early Bird and Night Owl",
    icon: "🕰️",
    condition: (s) => {
      const hasEarly = s.challenges.some(
        (c) => c.completed && c.dateCompleted && new Date(c.dateCompleted).getHours() < 8
      );
      const hasNight = s.challenges.some(
        (c) => c.completed && c.dateCompleted && new Date(c.dateCompleted).getHours() >= 22
      );
      return hasEarly && hasNight;
    },
  },
  {
    id: "weekend-warrior",
    tier: "hard",
    name: "Weekend Warrior",
    description: "Complete a challenge on both a Saturday and a Sunday",
    icon: "🏖️",
    condition: (s) => {
      const days = new Set(
        s.challenges
          .filter((c) => c.completed && c.dateCompleted)
          .map((c) => new Date(c.dateCompleted).getDay())
      );
      return days.has(0) && days.has(6);
    },
  },
  {
    id: "triple-threat",
    tier: "hard",
    name: "Triple Threat",
    description: "Complete 3 challenges in a single day",
    icon: "⚡",
    condition: (s) => {
      const counts = {};
      s.challenges
        .filter((c) => c.completed && c.dateCompleted)
        .forEach((c) => {
          const d = c.dateCompleted.slice(0, 10);
          counts[d] = (counts[d] || 0) + 1;
        });
      return Object.values(counts).some((count) => count >= 3);
    },
  },

  // --- Lock In ---
  {
    id: "lockin-veteran",
    tier: "hard",
    name: "Deep Focus",
    description: "Complete 10 Lock In sessions",
    icon: "🧘",
    condition: (s) => getCompletedLockIns(s).length >= 10,
  },
  {
    id: "lockin-marathoner",
    tier: "hard",
    name: "Marathoner",
    description: "Complete a Lock In session with a 90+ minute target",
    icon: "🏋️",
    condition: (s) => getCompletedLockIns(s).some((c) => c.targetMinutes >= 90),
  },
  {
    id: "lockin-overtime",
    tier: "hard",
    name: "Beyond the Bell",
    description: "Finish a Lock In session at least 30 minutes into overtime",
    icon: "⏰",
    condition: (s) => getMaxLockInOvertimeMinutes(s) >= 30,
  },
  {
    id: "lockin-century",
    tier: "hard",
    name: "Century of Focus",
    description: "Accumulate 500 total Lock In minutes",
    icon: "⏳",
    condition: (s) => getTotalLockInMinutes(s) >= 500,
  },

  // --- Recurring challenges ---
  {
    id: "recurring-streak-5",
    tier: "hard",
    name: "Habit Builder",
    description: "Complete 5 occurrences of the same recurring challenge",
    icon: "🔗",
    condition: (s) => getMaxRecurringCompletionStreak(s) >= 5,
  },

  // --- Archive ---
  {
    id: "archive-organizer",
    tier: "hard",
    name: "Organizer",
    description: "Archive 10 completed challenges",
    icon: "🗄️",
    condition: (s) => s.challenges.filter((c) => c.archived).length >= 10,
  },

  // --- Due-date urgency ---
  {
    id: "comeback",
    tier: "hard",
    name: "Comeback",
    description: "Complete a challenge after its due date",
    icon: "🔄",
    condition: (s) => hasCompletedAnOverdueChallenge(s),
  },

  // --- Categories ---
  {
    id: "category-balanced3",
    tier: "hard",
    name: "Well Balanced",
    description: "Complete at least 3 challenges or habit check-ins in every category",
    icon: "🎨",
    condition: (s) => {
      const counts = { ...getCategoryCompletionCounts(s) };
      Object.entries(getHabitCategoryCompletionCounts(s)).forEach(([category, total]) => {
        counts[category] = (counts[category] || 0) + total;
      });
      const topicCategories = Object.keys(CATEGORY_CONFIG).filter((id) => id !== "lockin");
      return topicCategories.every((cat) => (counts[cat] || 0) >= 3);
    },
  },

  // --- Daily goal ---
  {
    id: "goal-crusher",
    tier: "hard",
    name: "Goal Crusher",
    description: "Hit your daily goal",
    icon: "🏹",
    condition: (s) => getTodayCompletedCount(s) >= (s.user.dailyGoal || CONFIG.DEFAULT_DAILY_GOAL),
  },

  // --- Personalization ---
  {
    id: "theme-switcher",
    tier: "hard",
    name: "Palette Explorer",
    description: "Choose a new color theme",
    icon: "🌗",
    condition: (s) => s.preferences.theme !== "ocean",
  },
  {
    id: "reminder-enabled",
    tier: "hard",
    name: "Stay Alert",
    description: "Turn on daily reminders",
    icon: "🔔",
    condition: (s) => s.preferences.remindersEnabled === true,
  },
  {
    id: "tour-complete",
    tier: "hard",
    name: "Orientation Complete",
    description: "Finish the onboarding tour",
    icon: "🎓",
    condition: (s) => s.user.hasCompletedTour === true,
  },

  // --- Meta badges (badges about badges) ---
  {
    id: "badge-collector",
    tier: "hard",
    name: "Collector",
    description: "Unlock 10 badges",
    icon: "🎒",
    condition: (s) => s.unlockedBadgeIds.length >= 10,
  },
  {
    id: "badge-completionist",
    tier: "hard",
    name: "Completionist",
    description: "Unlock 25 badges",
    icon: "🗝️",
    condition: (s) => s.unlockedBadgeIds.length >= 25,
  },
];

function checkBadges(opts = {}) {
  BADGES.forEach((badge) => {
    const alreadyUnlocked = state.unlockedBadgeIds.includes(badge.id);
    if (alreadyUnlocked) return;

    if (badge.condition(state)) {
      state.unlockedBadgeIds.push(badge.id);
      addNotification(`Badge unlocked: ${badge.name}`, badge.icon);
      triggerBadgeFeedback();
    }
  });

  if (!opts.skipSave) saveState();
}

function completeChallenge(id) {
  const challenge = state.challenges.find((c) => c.id === id);
  if (!challenge || challenge.completed) return;

  challenge.completed = true;
  challenge.dateCompleted = new Date().toISOString();
  awardXp(challenge.xpValue, { skipSave: true });
  updateStreak();
  checkBadges({ skipSave: true });

  if (challenge.recurrence && challenge.recurrence !== "none") {
    spawnNextRecurrence(challenge);
  }

  // Stop the Lock In ticker if this was an active Lock In session
  if (challenge.isLockIn && lockInIntervalId) {
    stopLockInTicker();
  }

  saveState();
  triggerCompletionFeedback();
}

// -------------------------------------
// Sound & haptics feedback
// -------------------------------------
// Lightweight WebAudio beeps - no external audio assets needed. Respects
// the user's Sound preference and is a total no-op if WebAudio is
// unavailable (older browsers) so it can never break core functionality.
let sharedAudioCtx = null;

function getAudioContext() {
  if (sharedAudioCtx) return sharedAudioCtx;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  sharedAudioCtx = new AudioCtor();
  return sharedAudioCtx;
}

function playTone(frequency, startDelaySec, durationSec, volume = 0.15) {
  if (!state.preferences.soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;

    const startTime = ctx.currentTime + startDelaySec;
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(volume, startTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + durationSec);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start(startTime);
    oscillator.stop(startTime + durationSec + 0.05);
  } catch (err) {
    console.warn("Sound playback failed:", err);
  }
}

function vibrateDevice(pattern) {
  if (!state.preferences.hapticsEnabled) return;
  if (typeof navigator.vibrate === "function") {
    navigator.vibrate(pattern);
  }
}

function triggerCompletionFeedback() {
  playTone(660, 0, 0.12);
  playTone(880, 0.09, 0.18);
  vibrateDevice(30);
}

function triggerBadgeFeedback() {
  playTone(523, 0, 0.12);
  playTone(659, 0.1, 0.12);
  playTone(784, 0.2, 0.25);
  vibrateDevice([30, 40, 30]);
}

// A single light tick - for small in-session actions (pause, resume,
// add time) that need to feel acknowledged without the full fanfare
// reserved for actually finishing something.
function triggerActionFeedback() {
  playTone(740, 0, 0.08, 0.12);
  vibrateDevice(15);
}

// -------------------------------------
// Notifications: persistent log
// -------------------------------------
function addNotification(message, icon) {
  if (areQuestifyNotificationsMuted()) return;

  const notification = {
    id: generateId(),
    message,
    icon,
    timestamp: new Date().toISOString(),
    isRead: false,
  };

  state.notifications.unshift(notification);
  state.notifications = state.notifications.slice(0, CONFIG.MAX_NOTIFICATIONS);
  saveState();

  showToast(`${escapeHTML(icon)} ${escapeHTML(message)}`);
  renderNotifBell();
}

function areQuestifyNotificationsMuted() {
  return Boolean(state.preferences.blockNotificationsDuringLockIn && getActiveLockIn());
}

function markNotificationRead(id) {
  const notif = state.notifications.find((n) => n.id === id);
  if (!notif) return;
  notif.isRead = true;
  saveState();
  renderNotifBell();
}

function clearAllNotifications() {
  state.notifications = [];
  saveState();
  renderNotifBell();
}

function formatRelativeTime(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function renderNotifBell() {
  const badgeEl = document.getElementById("notif-badge");
  const listEl = document.getElementById("notif-list");
  const bellBtn = document.getElementById("notif-bell-btn");
  if (!badgeEl || !listEl) return;

  const unreadCount = state.notifications.filter((n) => !n.isRead).length;

  badgeEl.textContent = unreadCount > 9 ? "9+" : unreadCount;
  badgeEl.classList.toggle("is-hidden", unreadCount === 0);

  if (bellBtn) {
    bellBtn.setAttribute(
      "aria-label",
      unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"
    );
  }

  if (state.notifications.length === 0) {
    listEl.innerHTML = `<p class="notif-empty">No notifications yet.</p>`;
    return;
  }

  listEl.innerHTML = state.notifications
    .map(
      (n) => `
        <div class="notif-item ${n.isRead ? "" : "is-unread"}" data-id="${n.id}">
          <div class="notif-item__icon">${escapeHTML(n.icon)}</div>
          <div>
            <div class="notif-item__message">${escapeHTML(n.message)}</div>
            <div class="notif-item__time">${formatRelativeTime(n.timestamp)}</div>
          </div>
        </div>
      `
    )
    .join("");
}

function initNotifBell() {
  // Only attach once to prevent memory leaks
  if (attachedHandlers.notifBell) return;

  const bellBtn = document.getElementById("notif-bell-btn");
  const panel = document.getElementById("notif-panel");
  const clearBtn = document.getElementById("notif-clear-btn");
  const listEl = document.getElementById("notif-list");

  if (!bellBtn || !panel || !clearBtn || !listEl) return;
  attachedHandlers.notifBell = true;

  bellBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isNowHidden = panel.classList.toggle("is-hidden");
    bellBtn.setAttribute("aria-expanded", String(!isNowHidden));
  });

  clearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearAllNotifications();
  });

  listEl.addEventListener("click", (e) => {
    const item = e.target.closest(".notif-item");
    if (!item) return;
    markNotificationRead(item.dataset.id);
  });

  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && !bellBtn.contains(e.target)) {
      panel.classList.add("is-hidden");
      bellBtn.setAttribute("aria-expanded", "false");
    }
  });

  renderNotifBell();
}

// -------------------------------------
// Challenges: filtering (view-only, never mutates state.challenges)
// -------------------------------------
function getFilteredChallenges() {
  const filtered = state.challenges
    .filter((c) => !c.isLockIn)
    .filter((c) => {
    const matchesSearch = c.title.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus =
      statusFilter === "archived"
        ? c.archived
        : statusFilter === "all"
        ? !c.archived
        : statusFilter === "active"
        ? !c.completed && !c.archived
        : statusFilter === "completed"
        ? c.completed && !c.archived
        : true;

    const matchesDue =
      dueFilter === "today"
        ? getChallengeScheduledDate(c) === getTodayDateString()
        : dueFilter === "week"
        ? isDateInCurrentWeek(getChallengeScheduledDate(c))
        : true;

    return matchesSearch && matchesStatus && matchesDue;
  });

  // Active challenges surface most-urgent (overdue, then due-today, then
  // soonest upcoming) first; other filters keep natural/creation order.
  if (statusFilter === "active" || statusFilter === "all") {
    const active = filtered.filter((c) => !c.completed);
    const rest = filtered.filter((c) => c.completed);
    return [...sortByUrgency(active), ...rest];
  }

  return filtered;
}

// -------------------------------------
// Toast notifications
// -------------------------------------
let toastTimeoutId = null;

function showToast(message) {
  if (areQuestifyNotificationsMuted()) return;

  const toastEl = document.getElementById("toast");
  if (!toastEl) return;

  toastEl.textContent = message;
  toastEl.classList.add("is-visible");

  if (toastTimeoutId) clearTimeout(toastTimeoutId);

  toastTimeoutId = setTimeout(() => {
    toastEl.classList.remove("is-visible");
  }, CONFIG.TOAST_DURATION_MS);
}

// -------------------------------------
// Habit Calendar: UI-only state (which month is being viewed)
// -------------------------------------
let calendarViewDate = new Date(); // defaults to current month on load
let weekViewDate = new Date(); // defaults to current week on load

// -------------------------------------
// Habit Calendar: data aggregation
// -------------------------------------

// Returns actual habit, challenge, and XP activity keyed by date for a month.
function getCalendarActivityForMonth(year, month) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const activityByDate = new Map();
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const eligibleHabits = getActiveHabits().filter((habit) =>
      (habit.createdDate || (habit.createdAt || "").slice(0, 10)) <= dateStr
    );
    const completedHabits = getHabitCompletionsForDate(dateStr);
    activityByDate.set(dateStr, {
      count: completedHabits.length,
      habitCount: completedHabits.length,
      habitTotal: eligibleHabits.length,
      challengeCount: 0,
      xp: getHabitXpForDate(dateStr),
    });
  }

  getCompletedChallenges().forEach((challenge) => {
    const dateStr = (challenge.dateCompleted || challenge.dateCreated || "").slice(0, 10);
    const activity = activityByDate.get(dateStr);
    if (!activity) return;
    activity.challengeCount += 1;
    activity.count += 1;
    activity.xp += Number(challenge.xpValue) || 0;
  });

  return activityByDate;
}

function getCalendarMonthSummary(year, month) {
  const activityByDate = getCalendarActivityForMonth(year, month);
  const today = getTodayDateString();
  let habitCheckIns = 0;
  let challengeWins = 0;
  let xpEarned = 0;
  let expectedHabitCheckIns = 0;
  let daysWithActivity = 0;
  let currentRun = 0;
  let bestRun = 0;
  let bestDay = null;
  const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const trackedDates = [...activityByDate.keys()].filter((dateStr) => dateStr <= today);

  trackedDates.forEach((dateStr) => {
    const activity = activityByDate.get(dateStr);
    habitCheckIns += activity.habitCount;
    challengeWins += activity.challengeCount;
    xpEarned += activity.xp;
    expectedHabitCheckIns += activity.habitTotal;

    if (activity.count > 0) {
      daysWithActivity += 1;
      currentRun += 1;
      bestRun = Math.max(bestRun, currentRun);
      if (!bestDay || activity.count > bestDay.count) {
        bestDay = { date: dateStr, count: activity.count };
      }
    } else {
      currentRun = 0;
    }
  });

  return {
    habitCheckIns,
    challengeWins,
    xpEarned,
    completionRate: expectedHabitCheckIns
      ? Math.round((habitCheckIns / expectedHabitCheckIns) * 100)
      : null,
    daysWithActivity,
    bestRun,
    bestDay,
    hasTrackedDates: trackedDates.length > 0 && trackedDates[trackedDates.length - 1] >= monthStart,
  };
}

// Builds the full grid of calendar cells for a given month, including
// the leading/trailing days from adjacent months needed to fill full weeks.
function getCalendarGridData(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const startDayOfWeek = firstOfMonth.getDay(); // 0 = Sunday

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const activityByDate = getCalendarActivityForMonth(year, month);
  const todayStr = getTodayDateString();

  const cells = [];

  // Leading days from the previous month (to fill the first week)
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i;
    cells.push({ day, inMonth: false, dateStr: null, count: 0, isToday: false });
  }

  // Actual days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const activity = activityByDate.get(dateStr);
    const habitStatus = dateStr > todayStr
      ? "upcoming"
      : activity.habitTotal === 0
      ? "empty"
      : activity.habitCount >= activity.habitTotal
      ? "complete"
      : activity.habitCount > 0
      ? "partial"
      : "missed";
    cells.push({
      day,
      inMonth: true,
      dateStr,
      count: activity.count,
      habitCount: activity.habitCount,
      habitTotal: activity.habitTotal,
      challengeCount: activity.challengeCount,
      xp: activity.xp,
      isToday: dateStr === todayStr,
      isFuture: dateStr > todayStr,
      habitStatus,
    });
  }

  // Trailing days from the next month (to fill the last week)
  while (cells.length % 7 !== 0) {
    const day = cells.length - (startDayOfWeek + daysInMonth) + 1;
    cells.push({ day, inMonth: false, dateStr: null, count: 0, isToday: false });
  }

  return cells;
}

// Converts a raw completion count into a 0-4 intensity bucket for coloring
function getIntensityLevel(count) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4; // 4+
}

// -------------------------------------
// Weekly Wins: current week (Sun-Sat) summary
// -------------------------------------
function getWeeklyWins() {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay()); // back up to Sunday
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const thisWeekCompletions = getCompletedChallenges().filter((c) => {
    const referenceDate = c.dateCompleted || c.dateCreated;
    const d = new Date(referenceDate);
    return d >= startOfWeek && d <= endOfWeek;
  });

  const thisWeekHabitCompletions = (state.habits || []).flatMap((habit) =>
    (Array.isArray(habit.completedDates) ? habit.completedDates : [])
      .filter((dateStr) => {
        const d = new Date(`${dateStr}T00:00:00`);
        return d >= startOfWeek && d <= endOfWeek;
      })
      .map((dateStr) => ({ habit, dateStr }))
  );
  const weekStartDate = addDaysToDateString(getTodayDateString(), -now.getDay());
  const weekEndDate = addDaysToDateString(weekStartDate, 6);
  const xpEarned = thisWeekCompletions.reduce((sum, c) => sum + c.xpValue, 0) +
    (state.habitXpLedger || [])
      .filter((entry) => entry.date >= weekStartDate && entry.date <= weekEndDate)
      .reduce((sum, entry) => sum + entry.amount, 0);

  // Find the day with the most completions this week
  const dayCounts = {};
  thisWeekCompletions.forEach((c) => {
    const referenceDate = c.dateCompleted || c.dateCreated;
    const key = referenceDate.slice(0, 10);
    dayCounts[key] = (dayCounts[key] || 0) + 1;
  });
  thisWeekHabitCompletions.forEach(({ dateStr }) => {
    dayCounts[dateStr] = (dayCounts[dateStr] || 0) + 1;
  });

  let bestDay = null;
  let bestDayCount = 0;
  Object.entries(dayCounts).forEach(([dateStr, count]) => {
    if (count > bestDayCount) {
      bestDay = dateStr;
      bestDayCount = count;
    }
  });

  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const bestDayLabel = bestDay
    ? weekdayNames[new Date(`${bestDay}T00:00:00`).getDay()]
    : null;

  return {
    completedCount: thisWeekCompletions.length + thisWeekHabitCompletions.length,
    xpEarned,
    bestDayLabel,
    bestDayCount,
  };
}

// -------------------------------------
// Daily goal: progress toward user.dailyGoal
// -------------------------------------
function getTodayCompletedCount(s = state) {
  const today = getTodayDateString();
  const challengeCount = getCompletedChallenges(s).filter(
    (c) => (c.dateCompleted || c.dateCreated).slice(0, 10) === today
  ).length;
  return challengeCount + getHabitCompletionsForDate(today, s, true).length;
}

function getDailyGoalProgress() {
  const completed = getTodayCompletedCount();
  const goal = Math.max(1, state.user.dailyGoal || CONFIG.DEFAULT_DAILY_GOAL);
  const percent = Math.min(100, Math.round((completed / goal) * 100));
  return { completed, goal, percent };
}

function setDailyGoal(goal) {
  const parsed = parseInt(goal, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return;
  state.user.dailyGoal = Math.min(20, parsed);
  saveState();
}

// -------------------------------------
// This week vs last week: completed-challenge comparison
// -------------------------------------
function getWeekComparison(s = state) {
  const { startOfWeek: thisWeekStart, endOfWeek: thisWeekEnd } = getCurrentWeekBounds();
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(thisWeekEnd);
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 7);

  let thisWeekCount = 0;
  let lastWeekCount = 0;

  getCompletedChallenges(s).forEach((c) => {
    const d = new Date(c.dateCompleted || c.dateCreated);
    if (d >= thisWeekStart && d <= thisWeekEnd) thisWeekCount += 1;
    else if (d >= lastWeekStart && d <= lastWeekEnd) lastWeekCount += 1;
  });
  (s.habits || []).forEach((habit) => {
    (Array.isArray(habit.completedDates) ? habit.completedDates : []).forEach((dateStr) => {
      const d = new Date(`${dateStr}T00:00:00`);
      if (d >= thisWeekStart && d <= thisWeekEnd) thisWeekCount += 1;
      else if (d >= lastWeekStart && d <= lastWeekEnd) lastWeekCount += 1;
    });
  });

  return { thisWeekCount, lastWeekCount, delta: thisWeekCount - lastWeekCount };
}

// -------------------------------------
// Shared week-bounds helper (Sun-Sat), reused by weekly stats, category
// balance, and the Challenges "This Week" due filter.
// -------------------------------------
function getCurrentWeekBounds() {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);
  return { startOfWeek, endOfWeek };
}

function isDateInCurrentWeek(dateStr) {
  const { startOfWeek, endOfWeek } = getCurrentWeekBounds();
  const d = new Date(`${dateStr}T00:00:00`);
  return d >= startOfWeek && d <= endOfWeek;
}

// -------------------------------------
// Category balance: completions this week, grouped by category
// -------------------------------------
function getCategoryBalanceThisWeek() {
  const { startOfWeek, endOfWeek } = getCurrentWeekBounds();

  const thisWeekCompletions = getCompletedChallenges().filter((c) => {
    const referenceDate = c.dateCompleted || c.dateCreated;
    const d = new Date(referenceDate);
    return d >= startOfWeek && d <= endOfWeek;
  });

  return Object.keys(CATEGORY_CONFIG).map((categoryId) => ({
    id: categoryId,
    ...getCategoryConfig(categoryId),
    count: thisWeekCompletions.filter((c) => (c.category || "general") === categoryId).length,
  }));
}

// -------------------------------------
// Daily reminder: one browser notification per day summarizing
// due-today/overdue challenges, if the user opted in and granted
// permission. Never fires more than once per calendar day.
// -------------------------------------
function checkDailyReminder() {
  if (!state.preferences.remindersEnabled) return;
  if (areQuestifyNotificationsMuted()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

  const today = getTodayDateString();
  if (state.preferences.lastReminderDate === today) return;

  const overdueCount = getOverdueChallenges().length;
  const dueTodayCount = getDueTodayChallenges().length;
  const total = overdueCount + dueTodayCount;
  if (total === 0) return;

  try {
    new Notification("Questify", {
      body: `You have ${total} challenge${total === 1 ? "" : "s"} waiting today. Keep your streak going!`,
      icon: "favicon.png",
    });
  } catch (err) {
    console.warn("Notification failed:", err);
    return;
  }

  state.preferences.lastReminderDate = today;
  saveState();
}

async function enableReminders() {
  if (typeof Notification === "undefined") return false;

  let permission;
  try {
    permission = await Notification.requestPermission();
  } catch (error) {
    console.error("Could not request notification permission:", error);
    return false;
  }
  if (permission !== "granted") return false;

  state.preferences.remindersEnabled = true;
  saveState();
  checkDailyReminder();
  return true;
}

function disableReminders() {
  state.preferences.remindersEnabled = false;
  saveState();
}

// -------------------------------------
// Stats: data aggregation
// -------------------------------------
function getLast7DaysCompletionCounts() {
  const days = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    days.push(`${year}-${month}-${day}`);
  }

  const counts = days.map((dateStr) => {
    const challengeCount = getCompletedChallenges().filter((c) => {
      const referenceDate = c.dateCompleted || c.dateCreated;
      return referenceDate.slice(0, 10) === dateStr;
    }).length;
    const count = challengeCount + getHabitCompletionsForDate(dateStr, state, true).length;

    return { date: dateStr, count };
  });

  return counts;
}

// -------------------------------------
// Stats: draw bar chart on canvas
// -------------------------------------
function drawActivityChart(canvasId = "activity-chart") {
  requestAnimationFrame(() => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    drawActivityChartInner(canvas, ctx);
  });
}

function drawActivityChartInner(canvas, ctx) {
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;
  canvas.width = displayWidth;
  canvas.height = displayHeight;

  const data = getLast7DaysCompletionCounts();
  const maxCount = Math.max(1, ...data.map((d) => d.count));
  const todayStr = getTodayDateString();

  const paddingTop = 22;
  const paddingBottom = 20;
  const paddingSide = 8;
  const chartWidth = displayWidth - paddingSide * 2;
  const chartHeight = displayHeight - paddingTop - paddingBottom;
  const barGap = 10;
  const barWidth = chartWidth / data.length - barGap;
  const barRadius = Math.min(6, barWidth / 2);

  ctx.clearRect(0, 0, displayWidth, displayHeight);

  // Baseline
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(paddingSide, paddingTop + chartHeight + 0.5);
  ctx.lineTo(displayWidth - paddingSide, paddingTop + chartHeight + 0.5);
  ctx.stroke();

  data.forEach((point, i) => {
    const isToday = point.date === todayStr;
    const minBarHeight = 4;
    const barHeight = point.count > 0 ? Math.max(minBarHeight, (point.count / maxCount) * chartHeight) : minBarHeight;
    const x = paddingSide + i * (barWidth + barGap);
    const y = paddingTop + (chartHeight - barHeight);

    // Bar - gradient fill on today, muted flat fill on other days so
    // "today" pops out at a glance instead of every bar looking the same.
    if (point.count === 0) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    } else if (isToday) {
      const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
      gradient.addColorStop(0, "#f59e0b");
      gradient.addColorStop(1, "#d97706");
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = "rgba(217, 119, 6, 0.45)";
    }

    drawRoundedTopRect(ctx, x, y, barWidth, barHeight, barRadius);
    ctx.fill();

    // Value label (only when there's something to show)
    if (point.count > 0) {
      ctx.fillStyle = isToday ? "#f59e0b" : "#a1a1aa";
      ctx.font = isToday ? "bold 11px system-ui, sans-serif" : "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(point.count, x + barWidth / 2, y - 7);
    }

    // Weekday label
    const dayLabel = CALENDAR_WEEKDAY_LABELS[new Date(`${point.date}T00:00:00`).getDay()].slice(0, 1);
    ctx.fillStyle = isToday ? "#f59e0b" : "#71717a";
    ctx.font = isToday ? "bold 11px system-ui, sans-serif" : "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(dayLabel, x + barWidth / 2, displayHeight - 4);
  });
}

function drawRoundedTopRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height);
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height);
  ctx.closePath();
}

// -------------------------------------
// Dashboard activity strip: a heatmap-style row of the last 7 days,
// replacing the old bar chart. Uses the same intensity color language as
// the Habit Calendar's month grid, so the two views read consistently.
// -------------------------------------
function renderActivityStrip() {
  const data = getLast7DaysCompletionCounts();
  const maxCount = Math.max(1, ...data.map((d) => d.count));
  const todayStr = getTodayDateString();

  const cells = data
    .map((point) => {
      const isToday = point.date === todayStr;
      const intensity = point.count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((point.count / maxCount) * 4)));
      const dayLabel = CALENDAR_WEEKDAY_LABELS[new Date(`${point.date}T00:00:00`).getDay()].slice(0, 1);
      const dateLabel = formatScheduledDateLabel(point.date);
      const activityLabel = point.count === 1 ? "activity" : "activities";

      return `
        <div class="activity-strip__day ${isToday ? "is-today" : ""}" role="img" aria-label="${dateLabel}: ${point.count} ${activityLabel}">
          <span class="activity-strip__weekday">${dayLabel}</span>
          <span class="activity-strip__date">${new Date(`${point.date}T00:00:00`).getDate()}</span>
          <div class="activity-strip__cell intensity-${intensity}">${point.count}</div>
        </div>
      `;
    })
    .join("");

  return `<div class="activity-strip">${cells}</div>`;
}

// -------------------------------------
// Dashboard: combined streak + daily goal card, one container in a row
// -------------------------------------
function renderTodaySummaryCard() {
  const progress = getDailyGoalProgress();
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - progress.percent / 100);

  return `
    <div class="card today-summary-card">
      <div class="today-summary__half">
        <div class="streak-flame">🔥</div>
        <div class="stat-value">${state.user.streak}</div>
        <div class="text-muted">day${state.user.streak === 1 ? "" : "s"} streak</div>
      </div>
      <div class="today-summary__divider"></div>
      <div class="today-summary__half">
        <div class="today-summary__ring-wrapper">
          <svg viewBox="0 0 80 80" class="today-summary__ring-svg">
            <circle cx="40" cy="40" r="${radius}" class="goal-ring-track" />
            <circle
              cx="40" cy="40" r="${radius}"
              class="goal-ring-fill"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${offset}"
            />
          </svg>
          <div class="goal-ring-label">
            <span class="today-summary__ring-value">${progress.completed}/${progress.goal}</span>
          </div>
        </div>
        <div class="text-muted">daily goal</div>
      </div>
    </div>
  `;
}

// -------------------------------------
// Dashboard: Welcome card for first-time users
// -------------------------------------
function dismissFirstStepWelcome() {
  if (state.user.hasSeenFirstStepWelcome) return;
  state.user.hasSeenFirstStepWelcome = true;
  saveState();
}

function renderFirstTimeWelcomeCard() {
  if (state.user.hasSeenFirstStepWelcome || state.challenges.length > 0) return "";

  return `
    <section class="card welcome-card first-time-welcome" aria-labelledby="first-step-title">
      <div class="welcome-card__copy">
        <span class="welcome-card__eyebrow">YOUR FIRST SMALL WIN</span>
        <h3 id="first-step-title">Start with five minutes.</h3>
        <p class="text-muted">A tiny, doable step is enough to get your momentum going.</p>
        <div class="welcome-card__suggestion">
          <span class="welcome-card__suggestion-icon" aria-hidden="true">📖</span>
          <span><strong>Read for 5 minutes</strong><small>Easy · Learning · +10 XP</small></span>
        </div>
      </div>
      <div class="welcome-card__actions">
        <button class="btn" id="first-challenge-btn">Add this first step</button>
        <button class="btn-secondary" id="custom-first-challenge-btn">Make my own</button>
      </div>
    </section>
  `;
}

// -------------------------------------
// Dashboard: "resume what you were doing" banner for an in-progress
// Lock In session - surfaces the most obvious next action rather than
// making the user go hunting for it on the Challenges page.
// -------------------------------------
function renderResumeLockInBanner() {
  const active = getActiveLockIn();
  if (!active) return "";

  const elapsedLabel = formatLockInDuration(getLockInElapsedSeconds(active));

  return `
    <div class="card resume-lockin-banner">
      <div class="resume-lockin-banner__icon">🔒</div>
      <div class="resume-lockin-banner__info">
        <div class="resume-lockin-banner__title">${escapeHTML(active.title)}</div>
        <div class="text-muted">${active.isPaused ? "⏸️ Paused" : "In progress"} · ${elapsedLabel} logged</div>
      </div>
      <button class="btn btn-sm" id="dashboard-resume-lockin-btn">Resume</button>
    </div>
  `;
}

function renderDashboardLockInCta() {
  if (getActiveLockIn()) return "";

  return `
    <section class="dashboard-lockin-cta card" aria-label="Start a focus session">
      <div class="dashboard-lockin-cta__icon" aria-hidden="true">🔒</div>
      <div class="dashboard-lockin-cta__copy">
        <p class="dashboard-section__eyebrow">MAKE SPACE FOR FOCUS</p>
        <h3>Ready to lock in?</h3>
        <p class="text-muted">Set a focus timer, choose your session, and give your next task your full attention.</p>
      </div>
      <button type="button" class="btn dashboard-lockin-cta__button" id="dashboard-lockin-btn">
        <span>Start Lock In</span><span aria-hidden="true">↗</span>
      </button>
    </section>
  `;
}

// -------------------------------------
// Daily Goal: progress ring render helper (inline SVG)
// -------------------------------------
function renderGoalRing() {
  const progress = getDailyGoalProgress();
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - progress.percent / 100);

  return `
    <div class="card goal-ring-card">
      <div class="goal-ring-wrapper">
        <svg viewBox="0 0 100 100" class="goal-ring-svg">
          <circle cx="50" cy="50" r="${radius}" class="goal-ring-track" />
          <circle
            cx="50" cy="50" r="${radius}"
            class="goal-ring-fill"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${offset}"
          />
        </svg>
        <div class="goal-ring-label">
          <span class="goal-ring-value">${progress.completed}</span>
          <span class="goal-ring-of text-muted">of ${progress.goal}</span>
        </div>
      </div>
      <div class="goal-ring-info">
        <h3 style="margin: 0 0 4px;">Daily Goal</h3>
        <p class="text-muted" style="margin: 0;">
          ${
            progress.percent >= 100
              ? "Goal reached! 🎉 Nice work today."
              : `${progress.goal - progress.completed} more to hit today's goal.`
          }
        </p>
      </div>
    </div>
  `;
}

// -------------------------------------
// Category balance: mini-cards render helper
// -------------------------------------
function renderCategoryBalanceCards() {
  const balance = getCategoryBalanceThisWeek();
  const hasAny = balance.some((c) => c.count > 0);

  if (!hasAny) {
    return `<p class="text-muted">Complete a challenge to see your category balance for the week.</p>`;
  }

  return `
    <div class="category-balance-grid">
      ${balance
        .map(
          (c) => `
            <div class="category-mini-card">
              <div class="category-mini-card__icon">${c.icon}</div>
              <div class="category-mini-card__count">${c.count}</div>
              <div class="category-mini-card__label text-muted">${c.label}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

// -------------------------------------
// XP Bar: reusable render helper
// -------------------------------------
function renderXpBar() {
  const currentXp = state.user.xp;
  const currentLevel = state.user.level;
  const xpNeededForThisLevel = xpRequiredForLevel(currentLevel);
  const xpIntoLevel = xpIntoCurrentLevel(currentXp);
  const percent = Math.min(100, Math.max(0, (xpIntoLevel / xpNeededForThisLevel) * 100));

  return `
    <div class="xp-bar-wrapper">
      <div class="xp-bar-track">
        <div class="xp-bar-fill" style="width: ${percent}%;"></div>
      </div>
      <div class="xp-bar-label text-muted">
        <span>${xpIntoLevel} / ${xpNeededForThisLevel} XP</span>
        <span>${currentXp} total</span>
      </div>
    </div>
  `;
}

// -------------------------------------
// Weekly View: data aggregation
// -------------------------------------

// Builds 7 day objects (Sun-Sat) for the week containing `refDate`.
// Each day includes challenges completed that day, plus - for today
// only - the still-active (incomplete) challenges, so today's column
// doubles as an actionable task list.
function getWeekGridData(refDate) {
  const start = new Date(refDate);
  start.setDate(refDate.getDate() - refDate.getDay()); // back up to Sunday
  start.setHours(0, 0, 0, 0);

  const todayStr = getTodayDateString();
  const days = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const isToday = dateStr === todayStr;

    const completedThatDay = getCompletedChallenges().filter((c) => {
      const referenceDate = c.dateCompleted || c.dateCreated;
      return referenceDate.slice(0, 10) === dateStr;
    });

    // A challenge is "active" on whichever day it's scheduled for -
    // not just today - so planning ahead (or catching up on a past
    // day) both work the same way. Any active chip is clickable.
    const activeThatDay = state.challenges.filter(
      (c) => !c.completed && getChallengeScheduledDate(c) === dateStr
    );
    const completedHabitsThatDay = getHabitCompletionsForDate(dateStr);
    const eligibleHabits = getActiveHabits().filter((habit) =>
      (habit.createdDate || (habit.createdAt || "").slice(0, 10)) <= dateStr
    );
    const challengeXp = completedThatDay.reduce((total, challenge) => total + (Number(challenge.xpValue) || 0), 0);

    days.push({
      dateStr,
      dayLabel: CALENDAR_WEEKDAY_LABELS[d.getDay()],
      dayNumber: d.getDate(),
      monthLabel: CALENDAR_MONTH_NAMES[d.getMonth()].slice(0, 3),
      isToday,
      isFuture: dateStr > todayStr,
      completed: completedThatDay,
      active: activeThatDay,
      habits: completedHabitsThatDay,
      habitTotal: eligibleHabits.length,
      xp: getHabitXpForDate(dateStr) + challengeXp,
    });
  }

  return days;
}

// -------------------------------------
// Habit Calendar: render helpers
// -------------------------------------
const CALENDAR_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const CALENDAR_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderCalendarDayDetails(dateStr, variant = "calendar") {
  const isDashboardReview = variant === "dashboard";
  const date = new Date(`${dateStr}T00:00:00`);
  const label = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
  const eligibleHabits = (state.habits || []).filter((habit) =>
    (habit.createdDate || (habit.createdAt || "").slice(0, 10)) <= dateStr
  );
  const completedHabits = getHabitCompletionsForDate(dateStr, state, true)
    .filter((habit) => eligibleHabits.some((eligible) => eligible.id === habit.id));
  const completedIds = new Set(completedHabits.map((habit) => habit.id));
  const activeHabits = eligibleHabits.filter((habit) => !habit.archived);
  const completedCount = activeHabits.filter((habit) => completedIds.has(habit.id)).length;
  const completionPercent = activeHabits.length ? Math.round((completedCount / activeHabits.length) * 100) : 0;
  const challenges = getDayDetail(dateStr);
  const challengeXp = challenges.completed.reduce((total, challenge) => total + challenge.xpValue, 0);
  const habitXp = getHabitXpForDate(dateStr);
  const recentDates = Array.from({ length: 7 }, (_, index) => addDaysToDateString(dateStr, index - 6));
  const bestStreak = getOverallHabitStreakStats(state, dateStr);
  const canCheckIn = dateStr <= getTodayDateString();
  const status = !activeHabits.length
    ? "No active habits"
    : completedCount === activeHabits.length
    ? "All habits complete"
    : completedCount > 0
    ? "Partially complete"
    : dateStr < getTodayDateString()
    ? "No habits completed"
    : "Habits still open";

  return `
    <section class="card calendar-day-details ${isDashboardReview ? "dashboard-daily-review" : ""}" aria-labelledby="calendar-day-title">
      <div class="calendar-day-details__header">
        <div>
          <p class="dashboard-section__eyebrow">${isDashboardReview ? "YOUR DAILY REVIEW" : "DAILY REVIEW"}</p>
          <h3 id="calendar-day-title">${escapeHTML(label)}</h3>
          <p class="text-muted">${escapeHTML(status)}</p>
        </div>
        ${isDashboardReview
          ? `<button type="button" class="btn-secondary btn-sm" data-navigate="habits">Manage habits</button>`
          : calendarViewMode === "day" ? `
          <div class="calendar-day-details__controls">
            <button type="button" class="calendar-nav-btn" data-calendar-day-offset="-1" aria-label="Previous day">‹</button>
            <button type="button" class="btn-secondary btn-sm" id="calendar-today-btn">Today</button>
            <button type="button" class="calendar-nav-btn" data-calendar-day-offset="1" aria-label="Next day" ${dateStr >= getTodayDateString() ? "disabled" : ""}>›</button>
          </div>
        ` : ""}
      </div>
      <div class="calendar-day-details__stats">
        <div><strong>${completedCount}/${activeHabits.length}</strong><span>habits</span></div>
        <div><strong>${completionPercent}%</strong><span>completion</span></div>
        <div><strong>${habitXp + challengeXp}</strong><span>XP earned</span></div>
        <div><strong>${bestStreak.current}</strong><span>day streak</span></div>
      </div>
      <div class="calendar-streak-strip" aria-label="Seven-day habit activity">
        ${recentDates.map((recentDate) => {
          const hasActivity = getHabitCompletionsForDate(recentDate, state, true).length > 0;
          const day = new Date(`${recentDate}T00:00:00`);
          return `<span class="${hasActivity ? "is-complete" : recentDate < getTodayDateString() ? "is-missed" : ""}" title="${escapeHTML(recentDate)}">${CALENDAR_WEEKDAY_LABELS[day.getDay()].slice(0, 1)}</span>`;
        }).join("")}
        <small>7-day rhythm</small>
      </div>
      <div class="calendar-day-details__habits">
        <h4>Habits</h4>
        ${eligibleHabits.length ? eligibleHabits.map((habit) => `
          <div class="calendar-day-habit ${completedIds.has(habit.id) ? "is-complete" : ""}">
            ${!habit.archived && canCheckIn ? renderHabitCheckButton(habit, dateStr) : `<span class="calendar-day-habit__mark">${completedIds.has(habit.id) ? "✓" : "·"}</span>`}
            <span class="calendar-day-habit__info">
              <span class="calendar-day-habit__title">${escapeHTML(habit.title)}</span>
              ${habit.description ? `<small>${escapeHTML(habit.description)}</small>` : ""}
              ${renderHabitCategoryTag(habit.category)}
              <span class="difficulty-tag difficulty-${escapeHTML(habit.difficulty || "medium")}">${escapeHTML(getDifficultyConfig(habit.difficulty || "medium").label)}</span>
            </span>
            <strong>${completedIds.has(habit.id)
              ? `+${(state.habitXpLedger || []).find((entry) => entry.habitId === habit.id && entry.date === dateStr)?.amount || 0} XP`
              : `+${CONFIG.HABIT_XP_REWARDS[habit.difficulty] || CONFIG.HABIT_XP_REWARDS.medium} XP`}</strong>
          </div>
        `).join("") : `<p class="text-muted">No habits were set up by this date.</p>`}
      </div>
      ${challenges.completed.length ? `
        <div class="calendar-day-details__challenges">
          <h4>Challenges completed (${challenges.completed.length})</h4>
          ${challenges.completed.map((challenge) => renderDayDetailRow(challenge, true)).join("")}
        </div>
      ` : ""}
      ${challenges.active.length ? `
        <div class="calendar-day-details__challenges">
          <h4>Scheduled challenges (${challenges.active.length})</h4>
          ${challenges.active.map((challenge) => renderDayDetailRow(challenge, false)).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderCalendarGrid() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const cells = getCalendarGridData(year, month);

  const weekdayRow = CALENDAR_WEEKDAY_LABELS.map(
    (label) => `<div class="calendar-weekday-label">${label}</div>`
  ).join("");

  const dayCells = cells
    .map((cell) => {
      const intensity = getIntensityLevel(cell.count);
      const classes = [
        "calendar-day",
        !cell.inMonth ? "is-outside-month" : "",
        cell.isToday ? "is-today" : "",
        cell.isFuture ? "is-future" : "",
        cell.dateStr === calendarSelectedDate ? "is-selected" : "",
        cell.habitStatus ? `habit-status-${cell.habitStatus}` : "",
        intensity > 0 ? `intensity-${intensity}` : "",
      ]
        .filter(Boolean)
        .join(" ");

      const habitSummary = cell.habitStatus === "upcoming"
        ? "—"
        : `${cell.habitCount}/${cell.habitTotal}`;
      const habitLabel = cell.habitStatus === "upcoming"
        ? "future date"
        : `${cell.habitCount} of ${cell.habitTotal} habits completed`;
      const label = `${CALENDAR_MONTH_NAMES[month]} ${cell.day}, ${year}: ${habitLabel}, ${cell.challengeCount} challenges completed, ${cell.xp} XP earned`;
      const title = `${habitLabel} · ${cell.challengeCount} challenges · ${cell.xp} XP`;

      return cell.inMonth
        ? `<button type="button" class="${classes}" data-calendar-date="${cell.dateStr}" aria-pressed="${cell.dateStr === calendarSelectedDate}" aria-label="${escapeHTML(label)}" title="${escapeHTML(title)}"><span class="calendar-day__number">${cell.day}</span><span class="calendar-day__summary">${habitSummary}${cell.habitStatus === "upcoming" ? "" : `<span class="calendar-day__summary-label"> habits</span>`}</span>${cell.challengeCount > 0 ? `<span class="calendar-day__challenges">${cell.challengeCount} win${cell.challengeCount === 1 ? "" : "s"}</span>` : ""}${cell.xp > 0 ? `<span class="calendar-day__xp">+${cell.xp} XP</span>` : ""}${cell.count ? `<i aria-hidden="true"></i>` : ""}</button>`
        : `<div class="${classes}" aria-hidden="true">${cell.day}</div>`;
    })
    .join("");

  return `
    <div class="calendar-header">
      <button class="calendar-nav-btn" id="calendar-prev-btn" aria-label="Previous month">‹</button>
      <span class="calendar-month-label">${CALENDAR_MONTH_NAMES[month]} ${year}</span>
      <button class="calendar-nav-btn" id="calendar-next-btn" aria-label="Next month">›</button>
      <button class="btn-secondary btn-sm" type="button" id="calendar-today-btn">Today</button>
    </div>
    <div class="calendar-weekday-row">${weekdayRow}</div>
    <div class="calendar-grid">${dayCells}</div>
    <div class="calendar-legend">
      <span><i class="calendar-legend-dot is-complete"></i> All habits</span>
      <span><i class="calendar-legend-dot is-partial"></i> Some habits</span>
      <span><i class="calendar-legend-dot is-missed"></i> No check-ins</span>
    </div>
  `;
}

function renderCalendarMonthInsights() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const summary = getCalendarMonthSummary(year, month);
  const bestDayLabel = summary.bestDay
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
      .format(new Date(`${summary.bestDay.date}T00:00:00`))
    : "No activity yet";

  return `
    <section class="card calendar-month-insights" aria-label="${CALENDAR_MONTH_NAMES[month]} activity summary">
      <div class="calendar-month-insights__heading">
        <div>
          <p class="dashboard-section__eyebrow">MONTH AT A GLANCE</p>
          <h3>${CALENDAR_MONTH_NAMES[month]} ${year}</h3>
        </div>
        <p class="text-muted">${summary.hasTrackedDates ? `${summary.daysWithActivity} active day${summary.daysWithActivity === 1 ? "" : "s"}` : "No tracked days yet"}</p>
      </div>
      <div class="calendar-month-insights__stats">
        <div><strong>${summary.habitCheckIns}</strong><span>habit check-ins</span></div>
        <div><strong>${summary.challengeWins}</strong><span>challenges completed</span></div>
        <div><strong>${summary.xpEarned}</strong><span>XP earned</span></div>
        <div><strong>${summary.completionRate === null ? "—" : `${summary.completionRate}%`}</strong><span>habit completion</span></div>
      </div>
      <p class="calendar-month-insights__best text-muted">
        ${summary.bestDay
          ? `Most active day: <strong>${bestDayLabel}</strong> with ${summary.bestDay.count} completed item${summary.bestDay.count === 1 ? "" : "s"}. Longest activity run: ${summary.bestRun} consecutive day${summary.bestRun === 1 ? "" : "s"}.`
          : "Complete a habit or challenge to start building your monthly activity history."}
      </p>
    </section>
  `;
}

// -------------------------------------
// Weekly View: render helpers
// -------------------------------------
function truncateText(str, maxLength) {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + "…";
}

function renderWeekDayCard(day) {
  const activeChips = day.active
    .map(
      (c) => `
        <div class="week-chip is-active" data-id="${c.id}" title="Tap to mark complete">
          ${escapeHTML(truncateText(c.title, 16))}
        </div>
      `
    )
    .join("");

  const completedChips = day.completed
    .map(
      (c) => `
        <div class="week-chip is-completed" title="${escapeHTML(c.title)}">
          ✓ ${escapeHTML(truncateText(c.title, 14))}
        </div>
      `
    )
    .join("");

  const isEmpty = day.active.length === 0 && day.completed.length === 0;

  return `
    <div class="week-day-card ${day.isToday ? "is-today" : ""} ${day.isFuture ? "is-future" : ""} ${day.dateStr === calendarSelectedDate ? "is-selected" : ""}" data-date="${day.dateStr}" role="button" tabindex="0" aria-pressed="${day.dateStr === calendarSelectedDate}" aria-label="${day.dayLabel}, ${day.monthLabel} ${day.dayNumber}: ${day.habits.length} of ${day.habitTotal} habits, ${day.completed.length} challenges, ${day.xp} XP">
      <div class="week-day-header">
        <span class="week-day-label">${day.dayLabel}</span>
        <span class="week-day-number">${day.dayNumber}</span>
      </div>
      <div class="week-day-summary">
        <span>${day.habits.length}/${day.habitTotal} habits</span>
        <span>${day.completed.length} wins</span>
        <strong>${day.xp} XP</strong>
      </div>
      <div class="week-day-chips">
        ${day.habits.length ? `<span class="week-habit-count" aria-label="${day.habits.length} habits completed">${day.habits.length} habit${day.habits.length === 1 ? "" : "s"}</span>` : ""}
        ${activeChips}
        ${completedChips}
        ${isEmpty && day.habits.length === 0 ? `<div class="week-day-empty text-muted">-</div>` : ""}
      </div>
    </div>
  `;
}

function renderWeeklyView() {
  const days = getWeekGridData(weekViewDate);
  const first = days[0];
  const last = days[6];

  return `
    <div class="card weekly-view-card">
      <div class="calendar-header">
        <button class="calendar-nav-btn" id="week-prev-btn" aria-label="Previous week">‹</button>
        <span class="calendar-month-label">${first.monthLabel} ${first.dayNumber} – ${last.monthLabel} ${last.dayNumber}</span>
        <button class="calendar-nav-btn" id="week-next-btn" aria-label="Next week">›</button>
        <button class="btn-secondary btn-sm" type="button" id="calendar-today-btn">Today</button>
      </div>
      <div class="week-grid" id="week-grid">
        ${days.map(renderWeekDayCard).join("")}
      </div>
      <p class="week-view-hint text-muted">Select a day to review its habits, XP, streak, and completed challenges.</p>
    </div>
  `;
}

// -------------------------------------
// Habit Calendar: "Today's Habits" - a bigger, always-visible daily
// breakdown sitting right under the weekly strip, so today's status is
// visible without needing to click into the day-detail modal.
// -------------------------------------
function renderHabitCheckButton(habit, dateStr) {
  const isComplete = Array.isArray(habit.completedDates) && habit.completedDates.includes(dateStr);
  const isFuture = dateStr > getTodayDateString();
  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
    .format(new Date(`${dateStr}T00:00:00`));

  return `
    <button
      type="button"
      class="habit-check ${isComplete ? "is-complete" : ""}"
      data-habit-toggle
      data-habit-id="${escapeHTML(habit.id)}"
      data-habit-date="${dateStr}"
      aria-pressed="${isComplete}"
      aria-label="${isComplete ? "Uncheck" : "Complete"} ${escapeHTML(habit.title)} for ${dateLabel}"
      ${isFuture ? "disabled" : ""}
    ><span aria-hidden="true">${isComplete ? "✓" : ""}</span></button>
  `;
}

function renderHabitDailyRow(habit, dateStr) {
  const isComplete = Array.isArray(habit.completedDates) && habit.completedDates.includes(dateStr);
  const xpEntry = (state.habitXpLedger || []).find((entry) => entry.habitId === habit.id && entry.date === dateStr);
  const reward = CONFIG.HABIT_XP_REWARDS[habit.difficulty] || CONFIG.HABIT_XP_REWARDS.medium;
  return `
    <div class="habit-daily-row ${isComplete ? "is-complete" : ""}">
      ${renderHabitCheckButton(habit, dateStr)}
      <span class="habit-daily-row__identity">
        <span class="habit-daily-row__title">${escapeHTML(habit.title)}</span>
        ${renderHabitCategoryTag(habit.category)}
      </span>
      <span class="habit-daily-row__xp">${xpEntry ? `+${xpEntry.amount} XP earned` : `+${reward} XP`}</span>
    </div>
  `;
}

function renderTodayHabitsCard() {
  const todayStr = getTodayDateString();
  const { completed, active } = getDayDetail(todayStr);
  const habits = getActiveHabits();
  const completedHabits = getHabitCompletionsForDate(todayStr);
  const totalXp = completed.reduce((sum, c) => sum + c.xpValue, 0) + getHabitXpForDate(todayStr);
  const goalProgress = getDailyGoalProgress();

  const taskListHTML =
    completed.length === 0 && active.length === 0
      ? `<p class="text-muted" style="margin-top: var(--space-md);">Nothing scheduled for today yet.</p>`
      : `
        ${
          active.length > 0
            ? `
              <div class="day-detail-section" style="margin-top: var(--space-md);">
                <h4>To Do (${active.length})</h4>
                ${active.map((c) => renderDayDetailRow(c, false)).join("")}
              </div>
            `
            : ""
        }
        ${
          completed.length > 0
            ? `
              <div class="day-detail-section" style="margin-top: var(--space-md);">
                <h4>Completed (${completed.length})</h4>
                ${completed.map((c) => renderDayDetailRow(c, true)).join("")}
              </div>
            `
            : ""
        }
      `;

  return `
    <div class="card today-habits-card">
      <div class="habit-card-heading">
        <div>
          <p class="dashboard-section__eyebrow">YOUR DAILY RHYTHM</p>
          <h3>Today's habits</h3>
        </div>
        <button class="btn-secondary btn-sm" type="button" data-navigate="habits">Manage habits</button>
      </div>
      <div class="profile-stats today-habits-card__stats" style="grid-template-columns: repeat(3, 1fr); margin-top: 0;">
        <div class="stat-card">
          <div class="stat-value">${state.user.streak}</div>
          <div class="stat-label text-muted">Streak</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${completedHabits.length}/${habits.length}</div>
          <div class="stat-label text-muted">Habits</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${totalXp}</div>
          <div class="stat-label text-muted">XP Today</div>
        </div>
      </div>
      ${habits.length ? `
        <div class="habit-daily-list">
          ${habits.map((habit) => renderHabitDailyRow(habit, todayStr)).join("")}
        </div>
      ` : `
        <p class="text-muted habit-empty-note">No daily habits yet. Add a few small rituals to start tracking your consistency.</p>
      `}
      <div class="habit-calendar-challenges">
        <div class="habit-card-heading">
          <h4>Challenges</h4>
          <span class="text-muted">${goalProgress.completed}/${goalProgress.goal} daily goal</span>
        </div>
      ${taskListHTML}
      </div>
    </div>
  `;
}

// -------------------------------------
// Habit Calendar: day-detail modal (weekly view)
// -------------------------------------
// Gathers everything relevant to one specific date: challenges completed
// that day, plus anything still active/scheduled for that day.
function getDayDetail(dateStr) {
  const completed = getCompletedChallenges().filter(
    (c) => (c.dateCompleted || c.dateCreated).slice(0, 10) === dateStr
  );
  const active = state.challenges.filter(
    (c) => !c.completed && !c.archived && getChallengeScheduledDate(c) === dateStr
  );
  const habits = getHabitCompletionsForDate(dateStr, state, true);
  return { completed, active, habits };
}

function renderDayDetailRow(challenge, isCompleted) {
  const difficulty = challenge.difficulty || "easy";
  const category = getCategoryConfig(challenge.category || "general");

  return `
    <div class="day-detail-row">
      <span class="day-detail-row__title">${isCompleted ? "✓ " : ""}${escapeHTML(challenge.title)}</span>
      <div class="day-detail-row__tags">
        <span class="difficulty-tag difficulty-${difficulty}">${getDifficultyConfig(difficulty).label}</span>
        <span class="category-tag">${category.icon} ${category.label}</span>
      </div>
      <span class="day-detail-row__xp">${isCompleted ? "+" : ""}${challenge.xpValue} XP</span>
    </div>
  `;
}

function renderDayDetailModal() {
  if (!dayDetailDate) return "";

  const { completed, active, habits } = getDayDetail(dayDetailDate);
  const habitXp = getHabitXpForDate(dayDetailDate);
  const challengeXp = completed.reduce((sum, c) => sum + c.xpValue, 0);
  const totalXp = challengeXp + habitXp;
  const d = new Date(`${dayDetailDate}T00:00:00`);
  const label = `${CALENDAR_MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  return `
    <div class="modal-overlay" id="day-detail-overlay">
      <div class="modal-card card" id="day-detail-card" role="dialog" aria-modal="true" aria-label="${label} activity details">
        <div class="modal-header">
          <h3>${label}</h3>
          <button class="modal-close-btn" id="day-detail-close-btn" aria-label="Close">✕</button>
        </div>
        <p class="day-detail-total-xp text-muted">${totalXp} XP earned</p>
        ${
          completed.length === 0 && active.length === 0 && habits.length === 0
            ? `<p class="text-muted">No activity for this day.</p>`
            : `
              ${
                habits.length > 0
                  ? `
                    <div class="day-detail-section">
                      <h4>Habits completed (${habits.length}) · ${habitXp} XP</h4>
                      ${habits.map((habit) => {
                        const entry = (state.habitXpLedger || []).find((item) => item.habitId === habit.id && item.date === dayDetailDate);
                        return `
                          <div class="day-detail-row">
                            <span class="day-detail-row__title">✓ ${escapeHTML(habit.title)}</span>
                            <span class="day-detail-row__xp">${entry ? `+${entry.amount} XP` : "XP already awarded"}</span>
                          </div>
                        `;
                      }).join("")}
                    </div>
                  `
                  : ""
              }
              ${
                completed.length > 0
                  ? `
                    <div class="day-detail-section">
                      <h4>Challenges completed (${completed.length}) · ${challengeXp} XP</h4>
                      ${completed.map((c) => renderDayDetailRow(c, true)).join("")}
                    </div>
                  `
                  : ""
              }
              ${
                active.length > 0
                  ? `
                    <div class="day-detail-section">
                      <h4>Scheduled (${active.length})</h4>
                      ${active.map((c) => renderDayDetailRow(c, false)).join("")}
                    </div>
                  `
                  : ""
              }
            `
        }
      </div>
    </div>
  `;
}

function renderHabitTracker() {
  const habits = getActiveHabits();
  const archivedHabits = (state.habits || []).filter((habit) => habit.archived);
  const habitPendingDeletion = state.habits.find((habit) => habit.id === confirmingHabitDeleteId);
  const pendingCheckInCount = getHabitCheckInCount(habitPendingDeletion);
  const days = getWeekGridData(weekViewDate);
  const daysToDate = days.filter((day) => day.dateStr <= getTodayDateString()).length;
  const checkedThisWeek = habits.reduce(
    (total, habit) => total + days.filter((day) =>
      Array.isArray(habit.completedDates) && habit.completedDates.includes(day.dateStr)
    ).length,
    0
  );
  const possibleCheckIns = habits.length * daysToDate;
  const progress = possibleCheckIns ? Math.round((checkedThisWeek / possibleCheckIns) * 100) : 0;
  const firstDay = days[0];
  const lastDay = days[6];
  const analytics = getHabitAnalytics(habitAnalyticsPeriod);
  const difficultyOptions = (selected) => Object.entries(CONFIG.HABIT_XP_REWARDS)
    .map(([difficulty, reward]) => `<option value="${difficulty}" ${selected === difficulty ? "selected" : ""}>${difficulty[0].toUpperCase()}${difficulty.slice(1)} · ${reward} XP</option>`)
    .join("");
  const categoryOptions = (selected = "general") => HABIT_CATEGORY_IDS
    .map((categoryId) => `<option value="${categoryId}" ${getHabitCategoryId(selected) === categoryId ? "selected" : ""}>${getCategoryConfig(categoryId).icon} ${getCategoryConfig(categoryId).label}</option>`)
    .join("");
  const renderHabitManagerRow = (habit) => {
    const stats = getHabitCompletionRate([habit], habit.createdDate || (habit.createdAt || "").slice(0, 10), getTodayDateString());
    const streak = getHabitStreakStats(habit);
    const isEditing = editingHabitId === habit.id;
    return `
      <article class="habit-manager-row ${habit.archived ? "is-archived" : ""}" data-habit-card="${escapeHTML(habit.id)}">
        <div class="habit-manager-row__details">
          <div class="habit-manager-row__heading">
            <span class="habit-manager-row__icon" aria-hidden="true">✦</span>
            <strong class="habit-manager-row__title">${escapeHTML(habit.title)}</strong>
            ${renderHabitCategoryTag(habit.category)}
            <span class="difficulty-tag difficulty-${habit.difficulty || "medium"}">${(habit.difficulty || "medium")[0].toUpperCase()}${(habit.difficulty || "medium").slice(1)}</span>
          </div>
          ${habit.description ? `<p class="habit-manager-row__description text-muted">${escapeHTML(habit.description)}</p>` : ""}
          <div class="habit-manager-row__meta">${CONFIG.HABIT_XP_REWARDS[habit.difficulty] || CONFIG.HABIT_XP_REWARDS.medium} XP per first check-in · ${stats.completed} successful check-ins · ${stats.percent}% overall · ${streak.current} day streak · ${streak.longest} best</div>
        </div>
        <div class="habit-manager-row__actions">
          <button type="button" class="btn-secondary btn-sm" data-habit-edit="${escapeHTML(habit.id)}">${isEditing ? "Close" : "Edit"}</button>
          ${habit.archived
            ? `<button type="button" class="btn-secondary btn-sm" data-habit-archive="${escapeHTML(habit.id)}" aria-label="Restore ${escapeHTML(habit.title)}">Restore</button>`
            : `<button type="button" class="btn-secondary btn-sm" data-habit-archive="${escapeHTML(habit.id)}" aria-label="Archive ${escapeHTML(habit.title)}">Archive</button>`}
          <button type="button" class="btn-danger btn-sm" data-habit-delete="${escapeHTML(habit.id)}">Delete</button>
        </div>
        ${isEditing ? `
          <form class="habit-edit-form" data-habit-edit-form="${escapeHTML(habit.id)}">
            <label>Habit name<input name="title" value="${escapeHTML(habit.title)}" maxlength="50" required></label>
            <label>Description<input name="description" value="${escapeHTML(habit.description || "")}" maxlength="180" placeholder="What does this habit mean to you?"></label>
            <label>Difficulty<select name="difficulty">${difficultyOptions(habit.difficulty || "medium")}</select></label>
            <label>Category<select name="category">${categoryOptions(habit.category)}</select></label>
            <p class="error-text" data-habit-edit-error></p>
            <button type="submit" class="btn btn-sm">Save changes</button>
          </form>
        ` : ""}
      </article>
    `;
  };
  const analyticsTitle = { day: "Daily performance", week: "Weekly performance", month: "Monthly performance" }[habitAnalyticsPeriod];

  return `
    <section class="view-heading">
      <div>
        <p class="dashboard-section__eyebrow">SMALL ACTIONS, STRONG ROUTINES</p>
        <h2>Habit tracker</h2>
        <p class="text-muted">Build the daily rituals you want to keep. Every check-in is saved to your calendar.</p>
      </div>
    </section>

    <section class="habit-overview-grid" aria-label="Habit progress">
      <div class="card habit-overview-card">
        <span class="habit-overview-card__icon" aria-hidden="true">🌿</span>
        <div><strong>${analytics.totalCount}</strong><span>total habits · ${habits.length} active</span></div>
      </div>
      <div class="card habit-overview-card">
        <span class="habit-overview-card__icon" aria-hidden="true">✅</span>
        <div><strong>${analytics.completedHabitCount}</strong><span>habits completed this ${habitAnalyticsPeriod === "day" ? "day" : habitAnalyticsPeriod}</span></div>
      </div>
      <div class="card habit-overview-card">
        <span class="habit-overview-card__icon" aria-hidden="true">🔥</span>
        <div><strong>${analytics.currentStreak} / ${analytics.bestStreak}</strong><span>current / best streak</span></div>
      </div>
      <div class="card habit-overview-card">
        <span class="habit-overview-card__icon" aria-hidden="true">◷</span>
        <div><strong>${analytics.overallPercent}%</strong><span>overall completion</span></div>
      </div>
    </section>

    <section class="card habit-analytics-card" aria-labelledby="habit-analytics-title">
      <div class="habit-analytics-heading">
        <div>
          <p class="dashboard-section__eyebrow">YOUR CONSISTENCY, MEASURED</p>
          <h3 id="habit-analytics-title">${analyticsTitle}</h3>
        </div>
        <div class="habit-analytics-tabs" role="group" aria-label="Habit analytics period">
          ${[["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"]].map(([period, label]) => `
            <button type="button" data-habit-period="${period}" class="${habitAnalyticsPeriod === period ? "is-active" : ""}" aria-pressed="${habitAnalyticsPeriod === period}">${label}</button>
          `).join("")}
        </div>
      </div>
      <div class="habit-analytics-summary">
        <div><strong>${analytics.percent}%</strong><span>${analytics.completed} / ${analytics.expected} check-ins</span></div>
        ${habitAnalyticsPeriod === "day" ? `
          <p>${analytics.todayCompleted} completed · ${analytics.todayRemaining} remaining today</p>
          <div class="habit-progress-track" role="progressbar" aria-label="Today's habit completion" aria-valuenow="${analytics.percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${analytics.percent}%"></span></div>
        ` : ""}
        ${habitAnalyticsPeriod === "month" ? `
          <p>${analytics.bestPerformingDay ? `Best day: ${analytics.bestPerformingDay.label} (${analytics.bestPerformingDay.percent}%)` : "No habit activity yet this month."} · ${analytics.monthlyDelta === null ? "No comparable activity last month." : `${analytics.monthlyDelta >= 0 ? "+" : ""}${analytics.monthlyDelta}% vs last month to date`}</p>
        ` : ""}
      </div>
      ${analytics.dailyPoints.length ? `
        <div class="habit-analytics-chart" role="img" aria-label="${analyticsTitle} completion chart">
          ${analytics.dailyPoints.map((point) => `
            <div class="habit-analytics-chart__column" title="${point.label}: ${point.percent}%">
              <span class="habit-analytics-chart__value">${point.percent}%</span>
              <div class="habit-analytics-chart__track"><span style="height:${point.percent}%"></span></div>
              <span class="habit-analytics-chart__label">${escapeHTML(point.label)}</span>
            </div>
          `).join("")}
        </div>
      ` : `<p class="text-muted">Add a habit to start building an analytics history.</p>`}
      <div class="habit-analytics-lists">
        <div>
          <h4>Most consistent</h4>
          ${analytics.consistentHabits.length ? analytics.consistentHabits.map(({ habit, percent }) => `<p>${escapeHTML(habit.title)} <strong>${percent}%</strong></p>`).join("") : `<p class="text-muted">No check-ins yet.</p>`}
        </div>
        <div>
          <h4>Missed habits</h4>
          ${analytics.missedHabits.length ? analytics.missedHabits.slice(0, 4).map((habit) => `<p>${escapeHTML(habit.title)}</p>`).join("") : `<p class="text-muted">No missed habits in this period.</p>`}
        </div>
      </div>
    </section>

    <section class="card habit-manager-card" aria-labelledby="habit-manager-title">
      <div class="habit-card-heading">
        <div>
          <h3 id="habit-manager-title">Your daily habits</h3>
          <p class="text-muted">Edit names, descriptions, difficulty, and category without losing check-in history. A check-in earns XP once per habit per date.</p>
        </div>
      </div>
      <form id="add-habit-form" class="add-habit-form" novalidate>
        <label class="sr-only" for="add-habit-input">New daily habit</label>
        <input id="add-habit-input" name="title" type="text" maxlength="50" placeholder="e.g. Read for 10 minutes" autocomplete="off" required>
        <label class="sr-only" for="add-habit-description">Habit description</label>
        <input id="add-habit-description" name="description" type="text" maxlength="180" placeholder="Description (optional)">
        <label class="sr-only" for="add-habit-difficulty">Habit difficulty</label>
        <select id="add-habit-difficulty" name="difficulty">${difficultyOptions("medium")}</select>
        <label class="sr-only" for="add-habit-category">Habit category</label>
        <select id="add-habit-category" name="category">${categoryOptions()}</select>
        <button class="btn" type="submit">Add habit</button>
      </form>
      <p class="error-text" id="add-habit-error" role="status"></p>
      <div class="habit-manager-list">
        ${habits.length ? habits.map(renderHabitManagerRow).join("") : `<p class="habit-empty-note text-muted">Your list is empty. Add your first small daily habit above.</p>`}
      </div>
      ${archivedHabits.length ? `
        <details class="habit-archived">
          <summary>Archived habits (${archivedHabits.length})</summary>
          <div class="habit-manager-list">
            ${archivedHabits.map(renderHabitManagerRow).join("")}
          </div>
        </details>
      ` : ""}
    </section>

    <section class="card habit-week-card" aria-labelledby="habit-week-title">
      <div class="calendar-header">
        <button class="calendar-nav-btn" id="habits-week-prev-btn" aria-label="Previous week">‹</button>
        <div>
          <h3 id="habit-week-title">This week</h3>
          <span class="calendar-month-label">${firstDay.monthLabel} ${firstDay.dayNumber} – ${lastDay.monthLabel} ${lastDay.dayNumber}</span>
        </div>
        <button class="calendar-nav-btn" id="habits-week-next-btn" aria-label="Next week">›</button>
      </div>
      <div class="habit-week-progress" aria-label="${progress}% completion this week">
        <div class="habit-week-progress__copy"><strong>${progress}%</strong><span class="text-muted">of your habit check-ins</span></div>
        <div class="habit-week-progress__track"><span style="width:${progress}%"></span></div>
      </div>
      ${habits.length ? `
        <div class="habit-week-scroll">
          <table class="habit-week-table">
            <thead>
              <tr>
                <th scope="col" class="habit-week-table__habit-heading">Habit</th>
                ${days.map((day) => `
                  <th scope="col" class="${day.isToday ? "is-today" : "is-other-day"}">
                    <span>${day.dayLabel}</span><strong>${day.dayNumber}</strong>
                  </th>
                `).join("")}
              </tr>
            </thead>
            <tbody>
              ${habits.map((habit) => `
                <tr>
                  <th scope="row" class="habit-week-table__habit">
                    <span>${escapeHTML(habit.title)}</span>
                    ${renderHabitCategoryTag(habit.category)}
                  </th>
                  ${days.map((day) => `
                    <td class="${day.isToday ? "is-today" : "is-other-day"}">
                      <span class="habit-week-table__day-label">${day.dayLabel.slice(0, 1)} ${day.dayNumber}</span>
                      ${renderHabitCheckButton(habit, day.dateStr)}
                    </td>
                  `).join("")}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="habit-week-empty">
          <span aria-hidden="true">🗓️</span>
          <strong>Your week starts with one habit</strong>
          <p class="text-muted">Add a habit above, then check in each day to see your progress take shape.</p>
        </div>
      `}
    </section>
    ${confirmingHabitDeleteId ? `
      <div class="modal-overlay habit-delete-overlay">
        <section class="modal-card card" role="alertdialog" aria-modal="true" aria-labelledby="habit-delete-title">
          <h3 id="habit-delete-title">${pendingCheckInCount ? "Delete this checked habit?" : "Delete this habit?"}</h3>
          <p class="text-muted">${pendingCheckInCount
            ? `This habit has ${pendingCheckInCount} check-in${pendingCheckInCount === 1 ? "" : "s"}. Deleting it permanently removes its check-in history, but previously earned XP and levels will not be taken away.`
            : "This permanently removes the habit and its check-in history. Previously earned XP and levels will not be taken away."}</p>
          <div class="habit-delete-actions">
            <button type="button" class="btn-secondary" data-habit-delete-cancel>Keep habit</button>
            <button type="button" class="btn-danger" data-habit-delete-confirm>Delete habit</button>
          </div>
        </section>
      </div>
    ` : ""}
  `;
}

function renderWeeklyWinsCard() {
  const wins = getWeeklyWins();

  return `
    <div class="card weekly-wins-card">
      <h3 style="margin-top:0;">This Week's Wins</h3>
      <div class="weekly-wins-grid">
        <div class="stat-card">
          <div class="stat-value">${wins.completedCount}</div>
          <div class="stat-label text-muted">Completed</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${wins.xpEarned}</div>
          <div class="stat-label text-muted">XP Earned</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${wins.bestDayCount}</div>
          <div class="stat-label text-muted">Best Day</div>
        </div>
      </div>
      ${
        wins.bestDayLabel
          ? `<div class="weekly-wins-best-day text-muted">🏅 Your strongest day this week was <strong>${wins.bestDayLabel}</strong> with ${wins.bestDayCount} completed.</div>`
          : `<div class="weekly-wins-best-day text-muted">Complete a challenge or log a habit to start this week's recap.</div>`
      }
    </div>
  `;
}

// -------------------------------------
// Lock In: panel render helper
// -------------------------------------
const LOCKIN_NOTE_COLORS = [
  { value: "#fff1a8", label: "Sunshine" },
  { value: "#ffd6dc", label: "Rose" },
  { value: "#cdeaff", label: "Sky" },
  { value: "#d7f4cb", label: "Mint" },
];

function getRandomLockInNoteColor() {
  return LOCKIN_NOTE_COLORS[Math.floor(Math.random() * LOCKIN_NOTE_COLORS.length)].value;
}

function getLockInNoteInk(color) {
  const channels = color.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255);
  const luminance = channels
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  return luminance > 0.42 ? "#302817" : "#ffffff";
}

function renderLockInStickyNote() {
  const active = getActiveLockIn();
  if (!active) return "";
  const color = /^#[0-9a-f]{6}$/i.test(active.sessionNoteColor || "")
    ? active.sessionNoteColor
    : "#fff1a8";
  const savedNote = active.savedNoteId
    ? state.notes.find((note) => note.id === active.savedNoteId)
    : null;
  return `
    <section class="lockin-sticky-note" style="--lockin-note-color:${color};--lockin-note-ink:${getLockInNoteInk(color)}" aria-labelledby="lockin-note-title">
      <div class="lockin-sticky-note__top">
        <label id="lockin-note-title" for="lockin-note-input">Sticky note</label>
        <span id="lockin-note-saved" role="status">${savedNote ? "Saved to Sticky Notes" : "Session only"}</span>
        ${isSessionNoteWindow ? `
          <button type="button" class="btn-secondary btn-sm" id="lockin-session-note-pip-btn">${isSessionNotePictureInPictureOpen() ? "Unpin" : "Pin"}</button>
          <button type="button" class="btn-secondary btn-sm" data-session-note-window-close aria-label="Close sticky note">×</button>
        ` : ""}
      </div>
      <textarea id="lockin-note-input" maxlength="500" rows="3" placeholder="Keep your next thought here…">${escapeHTML(active.sessionNote || "")}</textarea>
      <div class="lockin-sticky-note__tools">
        <div class="lockin-sticky-note__swatches" role="group" aria-label="Sticky note color">
          ${LOCKIN_NOTE_COLORS.map(({ value, label }) => `
            <button type="button" class="lockin-note-swatch ${color === value ? "is-selected" : ""}" data-lockin-note-color="${value}" aria-label="${label}" aria-pressed="${color === value}" style="--swatch-color:${value}"></button>
          `).join("")}
        </div>
        <label class="lockin-sticky-note__custom">Custom<input id="lockin-note-color" type="color" value="${color}" aria-label="Choose a custom sticky note color"></label>
      </div>
      <div class="lockin-note-actions">
        ${!isSessionNoteWindow
          ? `<button type="button" class="btn-secondary btn-sm" id="lockin-session-note-pip-btn">Open note window ↗</button>`
          : ""}
        <button type="button" class="btn-secondary btn-sm" id="lockin-save-note-btn">${savedNote ? "Update Sticky Notes" : "Save to Sticky Notes"}</button>
      </div>
      ${!isSessionNoteWindow
        ? `<p class="lockin-note-hint text-muted">Open the note in its own window to pin it independently of the timer.</p>`
        : ""}
    </section>
  `;
}

function updateLockInNoteColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  const active = getActiveLockIn();
  if (!active) return;
  active.sessionNoteColor = color;
  const note = document.querySelector(".lockin-sticky-note");
  if (note) {
    note.style.setProperty("--lockin-note-color", color);
    note.style.setProperty("--lockin-note-ink", getLockInNoteInk(color));
  }
  document.querySelectorAll("[data-lockin-note-color]").forEach((button) => {
    const selected = button.dataset.lockinNoteColor === color;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const colorInput = document.getElementById("lockin-note-color");
  if (colorInput) colorInput.value = color;
  const savedLabel = document.getElementById("lockin-note-saved");
  if (savedLabel && active.savedNoteId) savedLabel.textContent = "Session changes not saved to Sticky Notes";
  saveState();
  syncSessionNotePictureInPicture();
}

function saveLockInNoteToLibrary() {
  const active = getActiveLockIn();
  if (!active) return;
  const content = (active.sessionNote || "").trim();
  if (!content) {
    showToast("Add a thought to the note before saving it.");
    return;
  }

  const existing = active.savedNoteId
    ? state.notes.find((note) => note.id === active.savedNoteId)
    : null;
  const now = new Date().toISOString();
  if (existing) {
    existing.title = active.title.slice(0, 80);
    existing.content = content.slice(0, 2000);
    existing.color = active.sessionNoteColor || "#fff1a8";
    existing.updatedAt = now;
  } else {
    const note = {
      id: generateId(),
      title: active.title.slice(0, 80),
      content: content.slice(0, 2000),
      color: active.sessionNoteColor || "#fff1a8",
      createdAt: now,
      updatedAt: now,
    };
    state.notes.unshift(note);
    active.savedNoteId = note.id;
  }
  const savedLabel = document.getElementById("lockin-note-saved");
  if (savedLabel) savedLabel.textContent = "Saved to Sticky Notes";
  const saveButton = document.getElementById("lockin-save-note-btn");
  if (saveButton) saveButton.textContent = "Update Sticky Notes";
  saveState();
  syncSessionNotePictureInPicture();
}

function supportsDocumentPictureInPicture() {
  return "documentPictureInPicture" in window &&
    typeof window.documentPictureInPicture?.requestWindow === "function";
}

function isSessionNotePictureInPictureOpen() {
  return Boolean(sessionNotePictureInPictureWindow && !sessionNotePictureInPictureWindow.closed);
}

function updateSessionNotePictureInPictureButton() {
  const button = document.getElementById("lockin-session-note-pip-btn");
  if (button) {
    button.textContent = isSessionNoteWindow
      ? isSessionNotePictureInPictureOpen() ? "Unpin note" : "Pin note"
      : "Open note window ↗";
  }
}

function preparePictureInPictureWindow(pipWindow, bodyClass, content) {
  pipWindow.document.title = bodyClass === "lockin-pip-host" ? "Timer" : "Note";
  pipWindow.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  const stylesheet = pipWindow.document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL("style.css", window.location.href).href;
  pipWindow.document.head.append(stylesheet);
  pipWindow.document.body.classList.add(bodyClass);
  pipWindow.document.body.classList.toggle("is-floating-transparent", state.preferences.floatingWindowsTransparent);
  pipWindow.document.body.innerHTML = content;
}

function closeSessionNotePictureInPicture() {
  const pipWindow = sessionNotePictureInPictureWindow;
  sessionNotePictureInPictureWindow = null;
  if (pipWindow && !pipWindow.closed) pipWindow.close();
  const noteWidget = getFloatingWidget("note");
  if (noteWidget?.mode === "pip" && noteWidget.kind === "session" && noteWidget.ownerId === appWindowId) {
    setFloatingWidget("note", null);
  }
  updateSessionNotePictureInPictureButton();
}

function syncSessionNotePictureInPicture() {
  const pipWindow = sessionNotePictureInPictureWindow;
  if (!pipWindow || pipWindow.closed) return;
  const active = getActiveLockIn();
  if (!active) {
    closeSessionNotePictureInPicture();
    return;
  }
  const note = pipWindow.document.querySelector(".session-note-pip");
  const color = /^#[0-9a-f]{6}$/i.test(active.sessionNoteColor || "") ? active.sessionNoteColor : "#fff1a8";
  pipWindow.document.body.classList.toggle("is-floating-transparent", state.preferences.floatingWindowsTransparent);
  note?.style.setProperty("--lockin-note-color", color);
  note?.style.setProperty("--lockin-note-ink", getLockInNoteInk(color));
  const input = pipWindow.document.getElementById("session-note-pip-content");
  if (input && pipWindow.document.activeElement !== input) {
    input.value = active.sessionNote || "";
  }
  pipWindow.document.querySelectorAll("[data-pip-note-color]").forEach((button) => {
    const selected = button.dataset.pipNoteColor === color;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

async function toggleSessionNotePictureInPicture() {
  const active = getActiveLockIn();
  if (!active) return;
  if (!isSessionNoteWindow) {
    if (sessionNotePopupWindow && !sessionNotePopupWindow.closed) {
      sessionNotePopupWindow.focus();
      return;
    }
    const noteUrl = new URL(window.location.href);
    ["focus", "note", "timer", "session-note"].forEach((key) => noteUrl.searchParams.delete(key));
    noteUrl.searchParams.set("session-note", active.id);
    noteUrl.hash = "";
    sessionNotePopupWindow = window.open(
      noteUrl.toString(),
      `questify-lockin-note-${active.id}`,
      "popup=yes,width=420,height=520,resizable=yes,scrollbars=no"
    );
    if (!sessionNotePopupWindow) {
      showToast("The Lock In note stayed on this page because the browser blocked its separate window. Allow pop-ups to open it.");
      return;
    }
    sessionNotePopupWindow.focus();
    return;
  }
  if (isSessionNotePictureInPictureOpen()) {
    closeSessionNotePictureInPicture();
    return;
  }
  if (!supportsDocumentPictureInPicture()) {
    showToast("This browser can't pin notes above other windows. The note remains editable in its separate window.");
    return;
  }
  const color = /^#[0-9a-f]{6}$/i.test(active.sessionNoteColor || "") ? active.sessionNoteColor : "#fff1a8";
  try {
    const pipWindow = await window.documentPictureInPicture.requestWindow({ width: 300, height: 190 });
    sessionNotePictureInPictureWindow = pipWindow;
    preparePictureInPictureWindow(
      pipWindow,
      "note-pip-host",
      `<main class="note-pip session-note-pip" style="--lockin-note-color:${color};--lockin-note-ink:${getLockInNoteInk(color)}">
        <header><span>Note</span><button type="button" class="btn-secondary btn-sm" data-pip-unpin>Unpin</button></header>
        <label class="sr-only" for="session-note-pip-content">Focus note</label>
        <textarea id="session-note-pip-content" maxlength="500" placeholder="Add a thought…">${escapeHTML(active.sessionNote || "")}</textarea>
        <div class="sticky-note-card__colors" role="group" aria-label="Note color">
          ${LOCKIN_NOTE_COLORS.map(({ value, label }) => `
            <button type="button" class="lockin-note-swatch ${color === value ? "is-selected" : ""}" data-pip-note-color="${value}" aria-label="${label}" aria-pressed="${color === value}" style="--swatch-color:${value}"></button>
          `).join("")}
        </div>
      </main>`
    );
    const input = pipWindow.document.getElementById("session-note-pip-content");
    input?.addEventListener("input", () => {
      const current = getActiveLockIn();
      if (!current) return;
      current.sessionNote = input.value.slice(0, 500);
      saveState();
      syncSessionNoteInput();
    });
    pipWindow.document.querySelectorAll("[data-pip-note-color]").forEach((button) => {
      button.addEventListener("click", () => updateLockInNoteColor(button.dataset.pipNoteColor));
    });
    pipWindow.document.querySelector("[data-pip-unpin]")?.addEventListener("click", () => {
      closeSessionNotePictureInPicture();
      returnToQuestifyFromPopup();
    });
    pipWindow.addEventListener("pagehide", () => {
      if (sessionNotePictureInPictureWindow === pipWindow) {
        sessionNotePictureInPictureWindow = null;
        const noteWidget = getFloatingWidget("note");
        if (noteWidget?.mode === "pip" && noteWidget.kind === "session" && noteWidget.ownerId === appWindowId) {
          setFloatingWidget("note", null);
        }
        updateSessionNotePictureInPictureButton();
      }
    }, { once: true });
    setFloatingWidget("note", { mode: "pip", kind: "session", id: active.id });
    syncSessionNotePictureInPicture();
    updateSessionNotePictureInPictureButton();
  } catch (error) {
    console.error("Could not pin the Lock In note:", error);
    showToast("The browser couldn't pin this note. It remains saved in its separate editor window.");
  }
}

function syncSessionNoteInput() {
  const active = getActiveLockIn();
  const input = document.getElementById("lockin-note-input");
  if (input && document.activeElement !== input) input.value = active?.sessionNote || "";
}

function openLockInFocusWindow() {
  const focusUrl = new URL(window.location.href);
  focusUrl.searchParams.set("focus", "lockin");
  focusUrl.hash = "";
  const popupHeight = getActiveLockIn() ? 760 : 560;
  const focusWindow = window.open(
    focusUrl.toString(),
    "questify-lockin-focus",
    `popup=yes,width=440,height=${popupHeight},resizable=yes,scrollbars=no`
  );
  if (!focusWindow) {
    showToast("The focus window was blocked. Allow pop-ups, or keep using the Lock In page here.");
    return;
  }
  focusWindow.focus();
}

function openLockInTimerPopupFallback() {
  if (lockInTimerPopupWindow && !lockInTimerPopupWindow.closed) {
    lockInTimerPopupWindow.focus();
    return true;
  }
  const timerUrl = new URL(window.location.href);
  ["focus", "note", "timer", "session-note"].forEach((key) => timerUrl.searchParams.delete(key));
  timerUrl.searchParams.set("timer", "lockin");
  timerUrl.hash = "";
  lockInTimerPopupWindow = window.open(
    timerUrl.toString(),
    "questify-lockin-timer",
    "popup=yes,width=340,height=300,resizable=yes,scrollbars=no"
  );
  if (!lockInTimerPopupWindow) return false;
  lockInTimerPopupWindow.focus();
  updateLockInPictureInPictureButton();
  return true;
}

function renderLockInFocusWindow() {
  const active = getActiveLockIn();
  return `
    <section class="lockin-focus-window ${active ? "is-active" : "is-setup"}" aria-labelledby="lockin-focus-window-title">
      <header class="lockin-focus-window__header">
        <div class="lockin-focus-window__brand">
          <div><p class="dashboard-section__eyebrow">FOCUS SPACE</p><h1 id="lockin-focus-window-title">${escapeHTML(active?.title || "Questify Lock In")}</h1></div>
        </div>
        ${active ? `<button type="button" id="lockin-picture-in-picture-btn" class="btn-secondary btn-sm" aria-label="Pin timer above other windows">${lockInPictureInPictureWindow && !lockInPictureInPictureWindow.closed ? "Unpin timer" : "Pin timer"}</button>` : ""}
        <button type="button" id="lockin-focus-window-close" class="btn-secondary btn-sm">Close</button>
      </header>
      ${renderLockInPanel()}
    </section>
  `;
}

function updateLockInPictureInPictureButton() {
  const button = document.getElementById("lockin-picture-in-picture-btn");
  if (button) {
    button.textContent = lockInPictureInPictureWindow && !lockInPictureInPictureWindow.closed
      ? "Unpin timer"
      : lockInTimerPopupWindow && !lockInTimerPopupWindow.closed
      ? "Close timer window"
      : "Pin timer";
  }
}

function updateLockInPictureInPicture(active, elapsedSec) {
  if (!lockInPictureInPictureWindow || lockInPictureInPictureWindow.closed) return;
  lockInPictureInPictureWindow.document.body.classList.toggle(
    "is-floating-transparent",
    state.preferences.floatingWindowsTransparent
  );
  const title = lockInPictureInPictureWindow.document.getElementById("lockin-pip-title");
  const timer = lockInPictureInPictureWindow.document.getElementById("lockin-pip-timer");
  const progress = lockInPictureInPictureWindow.document.getElementById("lockin-pip-progress");
  if (title) title.textContent = active.title;
  if (timer) {
    const remaining = Math.max(0, active.targetMinutes * 60 - elapsedSec);
    timer.textContent = active.isPaused
      ? `Paused · ${formatLockInClock(remaining)}`
      : remaining > 0
      ? formatLockInClock(remaining)
      : `+${formatLockInClock(elapsedSec - active.targetMinutes * 60)}`;
  }
  if (progress) progress.style.width = `${Math.min(100, (elapsedSec / (active.targetMinutes * 60)) * 100)}%`;
  const pauseButton = lockInPictureInPictureWindow.document.querySelector("[data-pip-pause]");
  if (pauseButton) pauseButton.textContent = active.isPaused ? "Resume" : "Pause";
}

function closeLockInPictureInPicture() {
  if (lockInPictureInPictureInterval) clearInterval(lockInPictureInPictureInterval);
  lockInPictureInPictureInterval = null;
  const pipWindow = lockInPictureInPictureWindow;
  lockInPictureInPictureWindow = null;
  if (pipWindow && !pipWindow.closed) pipWindow.close();
  if (ownsFloatingWidget("timer", "pip")) setFloatingWidget("timer", null);
  updateLockInPictureInPictureButton();
}

async function openLockInPictureInPicture() {
  if (lockInPictureInPictureWindow && !lockInPictureInPictureWindow.closed) {
    closeLockInPictureInPicture();
    return;
  }
  if (lockInTimerPopupWindow && !lockInTimerPopupWindow.closed) {
    lockInTimerPopupWindow.close();
    lockInTimerPopupWindow = null;
    updateLockInPictureInPictureButton();
    return;
  }
  const active = getActiveLockIn();
  if (!active) {
    showToast("Start a Lock In session before pinning its timer.");
    return;
  }
  if (!supportsDocumentPictureInPicture()) {
    if (isLockInTimerWindow) {
      showToast("Picture-in-Picture isn't available. Keep using this timer window; it may not stay on top.");
      return;
    }
    const opened = openLockInTimerPopupFallback();
    showToast(opened
      ? "Picture-in-Picture is unavailable here. The timer opened in a separate window, but may not stay on top."
      : "Picture-in-Picture is unavailable and the browser blocked the timer window. Allow pop-ups to continue.");
    return;
  }
  try {
    const pipWindow = await window.documentPictureInPicture.requestWindow({ width: 310, height: 150 });
    lockInPictureInPictureWindow = pipWindow;
    preparePictureInPictureWindow(
      pipWindow,
      "lockin-pip-host",
      `<main class="lockin-pip">
        <header class="lockin-pip__header"><strong id="lockin-pip-title">${escapeHTML(active.title)}</strong><button type="button" class="btn-secondary btn-sm" data-pip-unpin>Unpin</button></header>
        <span id="lockin-pip-timer" class="lockin-pip__timer"></span>
        <div class="lockin-pip__track"><span id="lockin-pip-progress"></span></div>
        <div class="lockin-pip__actions"><button type="button" class="btn-secondary btn-sm" data-pip-pause>${active.isPaused ? "Resume" : "Pause"}</button><button type="button" class="btn-secondary btn-sm" data-pip-add-time>+10 min</button></div>
      </main>`
    );
    pipWindow.document.querySelector("[data-pip-unpin]")?.addEventListener("click", () => {
      closeLockInPictureInPicture();
      returnToQuestifyFromPopup();
    });
    pipWindow.document.querySelector("[data-pip-pause]")?.addEventListener("click", () => {
      const current = getActiveLockIn();
      if (!current) return;
      current.isPaused ? resumeLockIn(current.id) : pauseLockIn(current.id);
      renderView();
    });
    pipWindow.document.querySelector("[data-pip-add-time]")?.addEventListener("click", () => {
      const current = getActiveLockIn();
      if (!current) return;
      addLockInTime(current.id, 10);
      updateLockInTimerDisplay();
    });
    pipWindow.addEventListener("pagehide", () => {
      if (lockInPictureInPictureWindow === pipWindow) {
        lockInPictureInPictureWindow = null;
        if (ownsFloatingWidget("timer", "pip")) setFloatingWidget("timer", null);
      }
      updateLockInPictureInPictureButton();
    }, { once: true });
    setFloatingWidget("timer", { mode: "pip", kind: "lockin", id: active.id });
    updateLockInPictureInPicture(active, getLockInElapsedSeconds(active));
    updateLockInPictureInPictureButton();
  } catch (error) {
    console.error("Could not pin the Lock In timer:", error);
    if (isLockInTimerWindow) {
      showToast("The browser couldn't pin this timer. It remains usable in this separate window.");
      return;
    }
    const opened = openLockInTimerPopupFallback();
    showToast(opened
      ? "The floating timer was unavailable. Opened a regular timer window; it may not stay on top."
      : "The browser could not create a floating or separate timer window. Allow pop-ups and try again.");
  }
}

function renderLockInTimerPopup() {
  const active = getActiveLockIn();
  if (!active) {
    return `<section class="lockin-timer-window"><header class="lockin-timer-window__header"><strong>No active Lock In</strong><button class="btn-secondary btn-sm" data-timer-window-close aria-label="Close timer window">×</button></header><p class="text-muted">Start a focus session in Questify to use its timer window.</p></section>`;
  }
  const elapsedSec = getLockInElapsedSeconds(active);
  return `
    <section class="lockin-timer-window" aria-label="Lock In timer pop-out">
      <header class="lockin-timer-window__header">
        <strong>${escapeHTML(active.title)}</strong>
        <button type="button" class="btn-secondary btn-sm" data-timer-pin aria-label="Pin timer above other windows">Pin</button>
        <button type="button" class="btn-secondary btn-sm" data-timer-window-close aria-label="Close timer window">×</button>
      </header>
      <div class="lockin-timer-window__readout" id="lockin-timer">${formatLockInClock(Math.max(0, active.targetMinutes * 60 - elapsedSec))}</div>
      <p id="lockin-status" class="lockin-status">${active.isPaused ? "Paused" : "Locked in..."}</p>
      <div class="lockin-timer-window__track"><span id="lockin-progress-fill" style="width:${Math.min(100, (elapsedSec / (active.targetMinutes * 60)) * 100)}%"></span></div>
      <div class="lockin-timer-window__actions">
        <button type="button" class="btn-secondary btn-sm" id="lockin-pause-btn" data-id="${escapeAttribute(active.id)}">${active.isPaused ? "Resume" : "Pause"}</button>
        <button type="button" class="btn-secondary btn-sm" id="lockin-add-time-btn" data-id="${escapeAttribute(active.id)}">+10 min</button>
      </div>
    </section>
  `;
}

function renderLockInPanel() {
  const active = getActiveLockIn();

  if (active) {
    return `
      <div class="card lockin-panel lockin-panel--active" id="lockin-panel">
        <div class="lockin-panel__header">
          <span class="lockin-panel__badge">🔒 Lock In</span>
          <div class="lockin-panel__header-tools">
            <span id="lockin-status" class="lockin-status">Locked in...</span>
            ${!isLockInFocusWindow && !isLockInTimerWindow
              ? `<button type="button" class="btn-secondary btn-sm lockin-open-window-btn">Open focus window ↗</button>`
              : ""}
          </div>
        </div>
        ${isLockInFocusWindow ? "" : `<h3 class="lockin-panel__title">${escapeHTML(active.title)}</h3>`}
        <div class="lockin-focus-clock">
          <svg class="lockin-focus-clock__dial" viewBox="0 0 120 120" role="progressbar" aria-label="Focus session progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <circle class="lockin-focus-clock__track" cx="60" cy="60" r="48"></circle>
            <circle id="lockin-progress-fill" class="lockin-focus-clock__progress" cx="60" cy="60" r="48"></circle>
          </svg>
          <div class="lockin-focus-clock__readout">
            <span id="lockin-timer" class="lockin-timer">0m / ${active.targetMinutes}m target</span>
            <span id="lockin-xp-preview" class="lockin-xp-preview text-muted">~0 XP so far</span>
          </div>
        </div>
        <div class="lockin-focus-controls">
          <div class="lockin-focus-controls__copy">
            <strong>Quiet focus</strong>
            <span class="text-muted">Mute new Questify toasts, notification-log entries, and browser reminders for this session. Alerts already delivered cannot be recalled; other apps and OS alerts are unchanged.</span>
          </div>
          <div
            id="lockin-notifications-switch"
            class="theme-switch ${state.preferences.blockNotificationsDuringLockIn ? "is-on" : ""}"
            role="switch"
            aria-checked="${state.preferences.blockNotificationsDuringLockIn}"
            aria-label="Block notifications during Lock In"
            tabindex="0"
          ><div class="theme-switch__knob"></div></div>
        </div>
        <details class="focus-os-guidance">
          <summary>Silence notifications from other apps</summary>
          <p>Questify cannot change phone-wide settings. Android: open Quick Settings and enable Do Not Disturb/Focus. iPhone: open Control Center, tap Focus, and choose a mode.</p>
        </details>
        <div class="lockin-panel__actions lockin-panel__actions--secondary">
          <button id="lockin-pause-btn" class="btn-secondary btn-sm" data-id="${active.id}">
            ${active.isPaused ? "Resume" : "Pause"}
          </button>
          <button id="lockin-add-time-btn" class="btn-secondary btn-sm" data-id="${active.id}">+10 min</button>
        </div>
        <div class="lockin-panel__actions">
          <button id="lockin-finish-btn" class="btn btn-sm" data-id="${active.id}">Finish Session</button>
          <button id="lockin-cancel-btn" class="btn-secondary btn-sm" data-id="${active.id}">Cancel</button>
        </div>
        ${renderLockInStickyNote()}
      </div>
    `;
  }

  return `
    <div class="card lockin-panel" id="lockin-panel">
      <div class="lockin-panel__header">
        <span class="lockin-panel__badge">🔒 Lock In</span>
        <button type="button" class="btn-secondary btn-sm lockin-open-window-btn">Open focus window ↗</button>
      </div>
      <p class="text-muted lockin-panel__description">
        Choose your focus duration and whether Questify should hold its own alerts. Your selected duration is remembered.
      </p>
      <form id="lockin-start-form" class="lockin-start-form" novalidate>
        <label for="lockin-title-input" class="sr-only">Session title</label>
        <input
          type="text"
          id="lockin-title-input"
          placeholder="e.g. Deep work"
          autocomplete="off"
          maxlength="50"
        />
        <div class="lockin-start-form__difficulty">
          <label for="lockin-difficulty-select" class="sr-only">Difficulty</label>
          <select id="lockin-difficulty-select" class="difficulty-select">
            <option value="easy">Easy</option>
            <option value="medium" selected>Medium</option>
            <option value="hard">Hard</option>
          </select>
        </div>
        <div class="lockin-duration-control">
          <div class="lockin-duration-control__heading">
            <span>Session length</span>
            <span class="text-muted">Pick a focus block</span>
          </div>
          <div class="lockin-duration-options" role="group" aria-label="Session duration">
            ${LOCKIN_DURATION_OPTIONS.map(
              (mins) => `
                <button
                  type="button"
                  class="lockin-duration-option ${mins === (state.preferences.lastLockInDuration || 60) ? "is-selected" : ""}"
                  data-duration="${mins}"
                  aria-pressed="${mins === (state.preferences.lastLockInDuration || 60)}"
                >${mins} min</button>
              `
            ).join("")}
            <button
              type="button"
              class="lockin-duration-option"
              data-duration="custom"
              aria-pressed="false"
            >Custom</button>
          </div>
          <input type="hidden" id="lockin-duration-select" value="${[15, 25, 45, 60, 90].includes(state.preferences.lastLockInDuration) ? state.preferences.lastLockInDuration : "custom"}" />
          <label for="lockin-custom-minutes-input" class="sr-only">Custom duration in minutes</label>
          <input
            type="number"
            id="lockin-custom-minutes-input"
            class="lockin-custom-input ${[15, 25, 45, 60, 90].includes(state.preferences.lastLockInDuration) ? "is-hidden" : ""}"
            placeholder="Enter minutes (1–240)"
            min="1"
            max="240"
            value="${[15, 25, 45, 60, 90].includes(state.preferences.lastLockInDuration) ? "" : Math.min(240, Math.max(1, Number(state.preferences.lastLockInDuration) || 60))}"
          />
        </div>
        <div class="lockin-start-quiet">
          <label for="lockin-start-quiet-input">
            <input id="lockin-start-quiet-input" type="checkbox" ${state.preferences.blockNotificationsDuringLockIn ? "checked" : ""}>
            <span><strong>Mute Questify notifications</strong><small>Suppresses new Questify toasts, notification-log entries, and browser reminders for this session only. It cannot recall alerts already delivered.</small></span>
          </label>
          <details class="focus-os-guidance">
            <summary>Silence notifications from other apps</summary>
            <p>Questify is a web app and cannot change phone-wide notification settings. Use your device's native mode: Android — open Quick Settings and turn on Do Not Disturb/Focus; iPhone — open Control Center, tap Focus, and choose a mode.</p>
          </details>
        </div>
        <button type="submit" class="btn lockin-start-form__submit">Start focus session</button>
      </form>
      <p class="error-text" id="lockin-error"></p>
      ${renderLockInStickyNote()}
    </div>
  `;
}

// -------------------------------------
// Challenges: render a single card
// -------------------------------------
function renderChallengeCard(challenge) {
  const difficulty = ["easy", "medium", "hard"].includes(challenge.difficulty)
    ? challenge.difficulty
    : "easy";
  const difficultyLabel = getDifficultyConfig(difficulty).label;
  const category = getCategoryConfig(challenge.category || "general");
  const scheduledDate = getChallengeScheduledDate(challenge);
  const dateLabel = escapeHTML(formatScheduledDateLabel(scheduledDate));
  const urgency = challenge.completed ? null : getUrgencyStatus(challenge);
  const recurrence = challenge.recurrence || "none";
  const xpValue = Number.isFinite(Number(challenge.xpValue)) ? Number(challenge.xpValue) : 0;
  const actualMinutes = Number.isFinite(Number(challenge.actualMinutes)) ? Number(challenge.actualMinutes) : 0;
  const targetMinutes = Number.isFinite(Number(challenge.targetMinutes)) ? Number(challenge.targetMinutes) : 0;

  const urgencyTag =
    urgency === "overdue"
      ? `<span class="urgency-tag urgency-overdue">Overdue</span>`
      : urgency === "due-today"
      ? `<span class="urgency-tag urgency-due-today">Due Today</span>`
      : "";

  const recurrenceTag =
    recurrence !== "none"
      ? `<span class="recurrence-tag" title="Repeats ${getRecurrenceConfig(recurrence).label.toLowerCase()}">🔁 ${getRecurrenceConfig(recurrence).label}</span>`
      : "";

  let actionsHTML;
  if (challenge.archived) {
    actionsHTML = `
      <button class="btn-sm btn-secondary" data-action="unarchive">Restore</button>
      <button class="btn-sm btn-delete" data-action="delete">Delete</button>
    `;
  } else if (challenge.completed) {
    actionsHTML = `
      <button class="btn-sm btn-complete" disabled>Done</button>
      <button class="btn-sm btn-secondary" data-action="archive">Archive</button>
      <button class="btn-sm btn-delete" data-action="delete">Delete</button>
    `;
  } else {
    actionsHTML = `
      <button class="btn-sm btn-complete" data-action="complete">Complete</button>
      <button class="btn-sm btn-delete" data-action="delete">Delete</button>
    `;
  }

  return `
    <div class="card challenge-card ${challenge.completed ? "is-completed" : ""} ${challenge.archived ? "is-archived" : ""}" data-id="${escapeAttribute(challenge.id)}">
      <div class="challenge-card__info">
        <span class="challenge-card__title">${escapeHTML(challenge.title)}</span>
        <span class="challenge-card__xp">+${xpValue} XP</span>
        <span class="difficulty-tag difficulty-${difficulty}">${difficultyLabel}</span>
        <span class="category-tag" title="${category.label}">${category.icon} ${category.label}</span>
        ${recurrenceTag}
        ${urgencyTag}
        ${
          challenge.isLockIn
            ? `<span class="challenge-card__date">⏱️ ${
                actualMinutes ? `Locked in ${actualMinutes}m` : `Target ${targetMinutes}m`
              }</span>`
            : ""
        }
        ${!challenge.completed && !challenge.isLockIn ? `<span class="challenge-card__date">📅 ${dateLabel}</span>` : ""}
      </div>
      <div class="challenge-card__actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// -------------------------------------
// Onboarding tour: slide content (data as config, same pattern as BADGES)
// -------------------------------------
const TOUR_STEPS = [
  {
    view: "dashboard",
    section: "Dashboard",
    selector: ".dashboard-daily-review",
    title: "Start with your Daily Review",
    body: "Check today's habit progress, XP, streak, and weekly rhythm here. A check-in made on this card stays in sync with Habits and Calendar.",
  },
  {
    view: "dashboard",
    section: "Dashboard",
    selector: ".dashboard-level-chip",
    title: "See your progress build",
    body: "Challenges and habit check-ins earn XP. Your level and progress are always visible from the dashboard.",
  },
  {
    view: "habits",
    section: "Habits",
    selector: ".habit-manager-card",
    title: "Build a routine that fits",
    body: "Create, edit, archive, or check in to daily habits. Your check-ins sync with the dashboard and calendar; deleting a checked habit asks before its history is removed.",
  },
  {
    view: "habits",
    section: "Habits",
    selector: ".habit-analytics-card",
    title: "Understand your consistency",
    body: "Switch between daily, weekly, and monthly summaries to review check-ins, streaks, and missed days.",
  },
  {
    view: "calendar",
    section: "Calendar",
    selector: ".calendar-view-heading",
    title: "Explore your activity",
    body: "Review habits, challenge completions, streaks, and XP together. Today is emphasized, future dates are dimmed, and habit updates stay in sync.",
  },
  {
    view: "lockin",
    section: "Lock In",
    selector: ".lockin-duration-control",
    title: "Set up a focused session",
    body: "Name your session, choose a difficulty, and pick a 25, 45, 60, 90-minute, or custom focus block. You can mute Questify notifications for the session; use your device's Focus or Do Not Disturb mode for other apps.",
  },
  {
    view: "notes",
    section: "Sticky Notes",
    selector: ".sticky-notes-heading",
    title: "Keep ideas close",
    body: "Create saved notes and open one in its own window. Pinning uses browser Picture-in-Picture where supported; otherwise the regular window remains available.",
  },
  {
    view: "badges",
    section: "Badges",
    selector: ".badge-progress-summary",
    title: "Celebrate every kind of progress",
    body: "Earn badges across Questify's habits, challenges, focus sessions, and other features. See what you've unlocked and what to work toward next.",
  },
  {
    view: "profile",
    section: "Profile",
    selector: ".profile-progress-section",
    title: "Your stats in one place",
    body: "Profile brings your personal details, XP, habit check-ins, challenge progress, badges, and activity history together.",
  },
  {
    view: "settings",
    section: "Settings",
    selector: "[aria-labelledby='data-backup-title']",
    title: "Keep your data backed up",
    body: "Export a JSON backup or import one to restore your progress on this device. Import replaces the current local data, so export a copy first if you may need it.",
  },
];

function startProductTour() {
  tourStep = 0;
  isTourActive = true;
  tourTargetView = TOUR_STEPS[tourStep].view;
  navigateTo(tourTargetView);
}

function finishTour(completed = false) {
  state.user.hasSeenTour = true;
  if (completed) {
    state.user.hasCompletedTour = true;
    checkBadges({ skipSave: true });
  }
  saveState();
  isTourActive = false;
  clearTourPositioning();
  navigateTo("dashboard");
}

function renderTourOverlay() {
  const step = TOUR_STEPS[tourStep];
  if (!step) return "";
  const last = tourStep === TOUR_STEPS.length - 1;
  return `
    <div class="onboarding-tour-overlay" aria-hidden="true"></div>
    <section class="onboarding-tour-bubble card" id="onboarding-tour-bubble" role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-description">
      <div class="onboarding-tour-bubble__topline">
        <span>${escapeHTML(step.section || "QUESTIFY QUICK TOUR")}</span>
        <span>${tourStep + 1} of ${TOUR_STEPS.length}</span>
      </div>
      <h2 id="tour-title">${escapeHTML(step.title)}</h2>
      <p id="tour-description">${escapeHTML(step.body)}</p>
      <div class="onboarding-tour-progress" role="progressbar" aria-label="Tour progress" aria-valuenow="${tourStep + 1}" aria-valuemin="1" aria-valuemax="${TOUR_STEPS.length}">
        <span style="width:${((tourStep + 1) / TOUR_STEPS.length) * 100}%"></span>
      </div>
      <div class="onboarding-tour-actions">
        <button type="button" class="btn-secondary btn-sm" id="tour-skip-btn">Skip tour</button>
        <div>
          <button type="button" class="btn-secondary btn-sm" id="tour-previous-btn" ${tourStep === 0 ? "disabled" : ""}>Previous</button>
          <button type="button" class="btn btn-sm" id="tour-next-btn">${last ? "Finish tour" : "Next"}</button>
        </div>
      </div>
    </section>
  `;
}

function positionTourOverlay() {
  const step = TOUR_STEPS[tourStep];
  const target = step && document.querySelector(step.selector);
  const bubble = document.getElementById("onboarding-tour-bubble");
  if (!bubble) return;
  document.querySelectorAll(".tour-highlight").forEach((element) => {
    if (element !== target) element.classList.remove("tour-highlight");
  });
  if (!target) {
    bubble.style.left = `${Math.max(16, (window.innerWidth - bubble.offsetWidth) / 2)}px`;
    bubble.style.top = `${Math.max(16, (window.innerHeight - bubble.offsetHeight) / 2)}px`;
    return;
  }
  target.classList.add("tour-highlight");
  if (target.closest("#app-header")) {
    document.getElementById("app-header").classList.add("is-tour-target");
  }
  const rect = target.getBoundingClientRect();
  const margin = 16;
  bubble.style.maxHeight = `${Math.max(0, window.innerHeight - margin * 2)}px`;
  const bubbleRect = bubble.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - bubbleRect.width - margin);
  const left = Math.min(maxLeft, Math.max(
    margin,
    rect.left + rect.width / 2 - bubbleRect.width / 2
  ));
  const belowTop = rect.bottom + 14;
  const aboveTop = rect.top - bubbleRect.height - 14;
  const preferredTop = belowTop + bubbleRect.height <= window.innerHeight - margin
    ? belowTop
    : aboveTop >= margin
      ? aboveTop
      : rect.top + rect.height / 2 - bubbleRect.height / 2;
  const maxTop = Math.max(margin, window.innerHeight - bubbleRect.height - margin);
  const top = Math.min(maxTop, Math.max(margin, preferredTop));
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

function clearTourPositioning() {
  window.removeEventListener("scroll", positionTourOverlay);
  window.removeEventListener("resize", positionTourOverlay);
  document.querySelectorAll(".tour-highlight").forEach((target) => {
    target.classList.remove("tour-highlight");
  });
  document.getElementById("app-header")?.classList.remove("is-tour-target");
}

function attachTourHandlers() {
  const step = TOUR_STEPS[tourStep];
  if (!step) return;
  const target = document.querySelector(step.selector);
  window.addEventListener("scroll", positionTourOverlay, { passive: true });
  window.addEventListener("resize", positionTourOverlay);
  if (target && !target.getClientRects().length && window.matchMedia("(max-width: 767px)").matches) {
    document.querySelector(".app-nav")?.classList.add("is-more-open");
    document.getElementById("nav-more-toggle")?.setAttribute("aria-expanded", "true");
  }
  target?.scrollIntoView({
    block: "nearest",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  positionTourOverlay();
  document.getElementById("tour-next-btn")?.addEventListener("click", () => {
    if (tourStep === TOUR_STEPS.length - 1) {
      finishTour(true);
      return;
    }
    tourStep += 1;
    tourTargetView = TOUR_STEPS[tourStep].view;
    navigateTo(tourTargetView, false);
  });
  document.getElementById("tour-previous-btn")?.addEventListener("click", () => {
    if (tourStep === 0) return;
    tourStep -= 1;
    tourTargetView = TOUR_STEPS[tourStep].view;
    navigateTo(tourTargetView, false);
  });
  document.getElementById("tour-skip-btn")?.addEventListener("click", () => finishTour(false));
  document.getElementById("tour-next-btn")?.focus();
}

function isCurrentPolicyAccepted() {
  return state.legalAcceptance?.policyVersion === LEGAL_POLICY_VERSION &&
    Boolean(state.legalAcceptance.acceptedAt);
}

let confirmingNoteDeleteId = null;

function renderStickyNotesPage() {
  const notes = [...state.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return `
    <section class="sticky-notes-page" aria-labelledby="sticky-notes-title">
      <header class="view-heading sticky-notes-heading">
        <div>
          <p class="dashboard-section__eyebrow">YOUR THOUGHTS, IN ONE PLACE</p>
          <h1 id="sticky-notes-title">Sticky Notes</h1>
          <p class="text-muted">Capture ideas, then open a note in its own window to float it above other apps where your browser supports it.</p>
        </div>
        <button type="button" class="btn" id="create-sticky-note">＋ New note</button>
      </header>
      ${notes.length
        ? `<div class="sticky-notes-grid">${notes.map((note) => renderStickyNoteCard(note)).join("")}</div>`
        : `<div class="card sticky-notes-empty">
            <span class="sticky-notes-empty__icon" aria-hidden="true">▤</span>
            <h2>Your note space is clear</h2>
            <p class="text-muted">Create a note for ideas you want to keep after your focus session ends.</p>
            <button type="button" class="btn" data-create-first-note>Create your first note</button>
          </div>`
      }
    </section>
  `;
}

function renderStickyNotePopup() {
  const note = state.notes.find((item) => item.id === stickyNoteWindowId);
  if (!note) {
    return `
      <section class="sticky-note-window__empty card">
        <p class="dashboard-section__eyebrow">STICKY NOTES</p>
        <h1>This note is no longer available</h1>
        <p class="text-muted">It may have been deleted in another Questify window.</p>
        <button type="button" class="btn-secondary" data-note-window-close>Close window</button>
      </section>
    `;
  }
  const color = /^#[0-9a-f]{6}$/i.test(note.color || "") ? note.color : "#fff1a8";
  return `
    <section class="sticky-note-window" aria-label="Sticky note window">
      <article class="sticky-note-card sticky-note-card--window" data-note-card="${escapeAttribute(note.id)}" style="--lockin-note-color:${color};--lockin-note-ink:${getLockInNoteInk(color)}">
        <div class="sticky-note-card__header">
          <span class="sticky-note-card__pin-indicator">Sticky note</span>
          <span class="sticky-note-card__updated">${escapeHTML(formatRelativeTime(note.updatedAt))}</span>
          <button type="button" class="btn-secondary btn-sm" id="saved-note-pip-btn">${isSavedNotePictureInPictureOpen() ? "Unpin" : "Pin"}</button>
          <button type="button" class="btn-secondary btn-sm" data-note-window-close aria-label="Close sticky note">×</button>
        </div>
        <label class="sr-only" for="note-window-title">Note title</label>
        <input id="note-window-title" class="sticky-note-card__title" type="text" maxlength="80" value="${escapeAttribute(note.title)}" data-note-title="${escapeAttribute(note.id)}" aria-label="Note title">
        <label class="sr-only" for="note-window-content">Note content</label>
        <textarea id="note-window-content" data-note-content="${escapeAttribute(note.id)}" maxlength="2000" rows="8" placeholder="Write a thought…">${escapeHTML(note.content)}</textarea>
        <div class="sticky-note-card__colors" role="group" aria-label="Note color">
          ${LOCKIN_NOTE_COLORS.map(({ value, label }) => `
            <button type="button" class="lockin-note-swatch ${color === value ? "is-selected" : ""}" data-note-color-id="${escapeAttribute(note.id)}" data-note-color="${value}" aria-label="${label}" aria-pressed="${color === value}" style="--swatch-color:${value}"></button>
          `).join("")}
          <label class="lockin-sticky-note__custom">Custom<input type="color" value="${color}" data-note-custom-color="${escapeAttribute(note.id)}" aria-label="Choose a custom note color"></label>
        </div>
        <div class="sticky-note-card__actions">
          <span class="sticky-note-window__sync" role="status">Edits save automatically and sync with Questify.</span>
        </div>
      </article>
    </section>
  `;
}

function openStickyNoteWindow(noteId) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) {
    showToast("This sticky note could not be found.");
    return;
  }
  const noteUrl = new URL(window.location.href);
  ["focus", "note", "timer", "session-note"].forEach((key) => noteUrl.searchParams.delete(key));
  noteUrl.searchParams.set("note", noteId);
  noteUrl.hash = "";
  const noteWindow = window.open(
    noteUrl.toString(),
    `questify-sticky-note-${noteId}`,
    "popup=yes,width=440,height=560,resizable=yes,scrollbars=no"
  );
  if (!noteWindow) {
    showToast("The sticky note stayed on this page because the browser blocked its separate window. Allow pop-ups to open it.");
    return false;
  }
  noteWindow.focus();
  return true;
}

function isSavedNotePictureInPictureOpen() {
  return Boolean(savedNotePictureInPictureWindow && !savedNotePictureInPictureWindow.closed);
}

function updateSavedNotePictureInPictureButton() {
  const button = document.getElementById("saved-note-pip-btn");
  if (button) {
    button.textContent = isSavedNotePictureInPictureOpen() &&
      savedNotePictureInPictureNoteId === stickyNoteWindowId
      ? "Unpin"
      : "Pin";
  }
  document.querySelectorAll("[data-note-pip]").forEach((noteButton) => {
    noteButton.textContent = isSavedNotePictureInPictureOpen() &&
      savedNotePictureInPictureNoteId === noteButton.dataset.notePip
      ? "Unpin above windows"
      : "Pin above windows";
  });
}

function closeSavedNotePictureInPicture() {
  const pipWindow = savedNotePictureInPictureWindow;
  savedNotePictureInPictureWindow = null;
  savedNotePictureInPictureNoteId = null;
  if (pipWindow && !pipWindow.closed) pipWindow.close();
  const noteWidget = getFloatingWidget("note");
  if (noteWidget?.mode === "pip" && noteWidget.kind === "saved" && noteWidget.ownerId === appWindowId) {
    setFloatingWidget("note", null);
  }
  updateSavedNotePictureInPictureButton();
}

function syncSavedNotePictureInPicture() {
  const pipWindow = savedNotePictureInPictureWindow;
  if (!pipWindow || pipWindow.closed) return;
  const note = state.notes.find((item) => item.id === savedNotePictureInPictureNoteId);
  if (!note) {
    closeSavedNotePictureInPicture();
    return;
  }
  const card = pipWindow.document.querySelector(".note-pip");
  const color = /^#[0-9a-f]{6}$/i.test(note.color || "") ? note.color : "#fff1a8";
  if (card) {
    card.style.setProperty("--lockin-note-color", color);
    card.style.setProperty("--lockin-note-ink", getLockInNoteInk(color));
  }
  pipWindow.document.body.style.setProperty("--lockin-note-color", color);
  pipWindow.document.body.style.setProperty("--lockin-note-ink", getLockInNoteInk(color));
  pipWindow.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  pipWindow.document.body.classList.toggle("is-floating-transparent", state.preferences.floatingWindowsTransparent);
  const title = pipWindow.document.getElementById("saved-note-pip-title");
  if (title && pipWindow.document.activeElement !== title) title.value = note.title;
  const content = pipWindow.document.getElementById("saved-note-pip-content");
  if (content && pipWindow.document.activeElement !== content) content.value = note.content;
  pipWindow.document.querySelectorAll("[data-pip-note-color]").forEach((button) => {
    const selected = button.dataset.pipNoteColor === color;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const updated = pipWindow.document.getElementById("saved-note-pip-updated");
  if (updated) updated.textContent = formatRelativeTime(note.updatedAt);
}

function syncStickyNotePopupEditor(note) {
  if (!isStickyNoteWindow || note.id !== stickyNoteWindowId) return;
  const title = [...document.querySelectorAll("[data-note-title]")]
    .find((input) => input.dataset.noteTitle === note.id);
  const content = [...document.querySelectorAll("[data-note-content]")]
    .find((input) => input.dataset.noteContent === note.id);
  if (title && document.activeElement !== title) title.value = note.title;
  if (content && document.activeElement !== content) content.value = note.content;
  const card = [...document.querySelectorAll("[data-note-card]")]
    .find((element) => element.dataset.noteCard === note.id);
  const updated = card?.querySelector(".sticky-note-card__updated");
  if (updated) updated.textContent = formatRelativeTime(note.updatedAt);
  document.title = `${note.title || "Sticky Note"} — Questify`;
}

async function toggleSavedNotePictureInPicture(noteId = stickyNoteWindowId) {
  if (isSavedNotePictureInPictureOpen() && savedNotePictureInPictureNoteId === noteId) {
    closeSavedNotePictureInPicture();
    return;
  }
  if (isSavedNotePictureInPictureOpen()) closeSavedNotePictureInPicture();
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) {
    showToast("This sticky note could not be found.");
    return;
  }
  if (!supportsDocumentPictureInPicture()) {
    if (isStickyNoteWindow) {
      showToast("This browser can't pin notes above other windows. Your note remains editable here.");
    } else if (openStickyNoteWindow(noteId)) {
      showToast("Picture-in-Picture isn't available. Opened the note in a separate window; it may not stay on top.");
    }
    return;
  }
  const color = /^#[0-9a-f]{6}$/i.test(note.color || "") ? note.color : "#fff1a8";
  try {
    const pipWindow = await window.documentPictureInPicture.requestWindow({ width: 310, height: 210 });
    savedNotePictureInPictureWindow = pipWindow;
    savedNotePictureInPictureNoteId = note.id;
    pipWindow.document.title = "Note";
    preparePictureInPictureWindow(
      pipWindow,
      "note-pip-host",
      `<main class="note-pip saved-note-pip" style="--lockin-note-color:${color};--lockin-note-ink:${getLockInNoteInk(color)}">
        <header><input id="saved-note-pip-title" type="text" maxlength="80" value="${escapeAttribute(note.title)}" aria-label="Note title"><button type="button" class="btn-secondary btn-sm" data-pip-unpin>Unpin</button></header>
        <label class="sr-only" for="saved-note-pip-content">Note content</label>
        <textarea id="saved-note-pip-content" maxlength="2000" placeholder="Write a thought…">${escapeHTML(note.content)}</textarea>
        <div class="sticky-note-card__colors" role="group" aria-label="Note color">
          ${LOCKIN_NOTE_COLORS.map(({ value, label }) => `
            <button type="button" class="lockin-note-swatch ${color === value ? "is-selected" : ""}" data-pip-note-color="${value}" aria-label="${label}" aria-pressed="${color === value}" style="--swatch-color:${value}"></button>
          `).join("")}
        </div>
      </main>`
    );
    const titleInput = pipWindow.document.getElementById("saved-note-pip-title");
    const contentInput = pipWindow.document.getElementById("saved-note-pip-content");
    const updateNote = () => {
      const current = state.notes.find((item) => item.id === note.id);
      if (!current) {
        closeSavedNotePictureInPicture();
        return;
      }
      current.title = (titleInput?.value || "").slice(0, 80);
      current.content = (contentInput?.value || "").slice(0, 2000);
      current.updatedAt = new Date().toISOString();
      saveState();
      syncStickyNotePopupEditor(current);
      syncSavedNotePictureInPicture();
    };
    titleInput?.addEventListener("input", updateNote);
    contentInput?.addEventListener("input", updateNote);
    pipWindow.document.querySelectorAll("[data-pip-note-color]").forEach((button) => {
      button.addEventListener("click", () => updateStickyNoteColor(note.id, button.dataset.pipNoteColor));
    });
    pipWindow.document.querySelector("[data-pip-unpin]")?.addEventListener("click", () => {
      closeSavedNotePictureInPicture();
      returnToQuestifyFromPopup();
    });
    pipWindow.addEventListener("pagehide", () => {
      if (savedNotePictureInPictureWindow === pipWindow) {
        savedNotePictureInPictureWindow = null;
        savedNotePictureInPictureNoteId = null;
        const noteWidget = getFloatingWidget("note");
        if (noteWidget?.mode === "pip" && noteWidget.kind === "saved" && noteWidget.ownerId === appWindowId) {
          setFloatingWidget("note", null);
        }
        updateSavedNotePictureInPictureButton();
      }
    }, { once: true });
    setFloatingWidget("note", { mode: "pip", kind: "saved", id: note.id });
    updateSavedNotePictureInPictureButton();
  } catch (error) {
    console.error("Could not open the saved note Picture-in-Picture window:", error);
    const status = document.getElementById("saved-note-pip-status");
    if (status) status.textContent = "The floating note could not open. The browser may limit simultaneous PiP windows.";
    if (!isStickyNoteWindow && openStickyNoteWindow(noteId)) {
      showToast("The floating note could not open. Opened a regular note window, which may not stay on top.");
    } else {
      showToast("The browser could not pin this note. It remains editable in its current window.");
    }
  }
}

function attachStickyNotePopupHandlers() {
  attachStickyNoteEditorHandlers();
  document.querySelectorAll("[data-note-color-id]").forEach((button) => {
    button.addEventListener("click", () => updateStickyNoteColor(button.dataset.noteColorId, button.dataset.noteColor));
  });
  document.querySelectorAll("[data-note-custom-color]").forEach((input) => {
    input.addEventListener("input", () => updateStickyNoteColor(input.dataset.noteCustomColor, input.value));
  });
  document.getElementById("saved-note-pip-btn")?.addEventListener("click", toggleSavedNotePictureInPicture);
  document.querySelectorAll("[data-note-window-close]").forEach((button) => {
    button.addEventListener("click", closeStickyNoteWindow);
  });
}

function closeStickyNoteWindow() {
  if (window.opener && !window.opener.closed) {
    window.close();
    return;
  }
  const appUrl = new URL(window.location.href);
  appUrl.searchParams.delete("note");
  appUrl.hash = "";
  window.location.replace(appUrl.toString());
}

function returnToQuestifyFromPopup() {
  if (window.opener && !window.opener.closed) {
    window.opener.focus();
    window.close();
    return;
  }
  const appUrl = new URL(window.location.href);
  ["focus", "note", "timer", "session-note"].forEach((key) => appUrl.searchParams.delete(key));
  appUrl.hash = "";
  if (appUrl.href !== window.location.href) window.location.replace(appUrl.toString());
}

function renderStickyNoteCard(note) {
  const color = /^#[0-9a-f]{6}$/i.test(note.color || "") ? note.color : "#fff1a8";
  const confirmingDelete = confirmingNoteDeleteId === note.id;
  const pinnedNote = getFloatingWidget("note");
  const isPinned = pinnedNote?.mode === "app" &&
    pinnedNote.kind === "saved" &&
    pinnedNote.id === note.id &&
    pinnedNote.ownerId === appWindowId;
  const isPinnedAboveWindows = isSavedNotePictureInPictureOpen() &&
    savedNotePictureInPictureNoteId === note.id;
  return `
    <article class="sticky-note-card ${isPinned ? "is-pinned" : ""}" data-note-card="${escapeAttribute(note.id)}" style="--lockin-note-color:${color};--lockin-note-ink:${getLockInNoteInk(color)}">
      <div class="sticky-note-card__header">
        <span class="sticky-note-card__pin-indicator">${isPinned ? "Pinned on screen" : "Sticky note"}</span>
        <span class="sticky-note-card__updated">${escapeHTML(formatRelativeTime(note.updatedAt))}</span>
      </div>
      <label class="sr-only" for="note-title-${escapeAttribute(note.id)}">Note title</label>
      <input id="note-title-${escapeAttribute(note.id)}" class="sticky-note-card__title" type="text" maxlength="80" value="${escapeAttribute(note.title)}" data-note-title="${escapeAttribute(note.id)}" aria-label="Note title">
      <label class="sr-only" for="note-content-${escapeAttribute(note.id)}">Note content</label>
      <textarea id="note-content-${escapeAttribute(note.id)}" data-note-content="${escapeAttribute(note.id)}" maxlength="2000" rows="5" placeholder="Write a thought…">${escapeHTML(note.content)}</textarea>
      <div class="sticky-note-card__colors" role="group" aria-label="Note color">
        ${LOCKIN_NOTE_COLORS.map(({ value, label }) => `
          <button type="button" class="lockin-note-swatch ${color === value ? "is-selected" : ""}" data-note-color-id="${escapeAttribute(note.id)}" data-note-color="${value}" aria-label="${label}" aria-pressed="${color === value}" style="--swatch-color:${value}"></button>
        `).join("")}
        <label class="lockin-sticky-note__custom">Custom<input type="color" value="${color}" data-note-custom-color="${escapeAttribute(note.id)}" aria-label="Choose a custom note color"></label>
      </div>
      <div class="sticky-note-card__actions">
        <button type="button" class="btn-secondary btn-sm" data-note-pin-app="${escapeAttribute(note.id)}">${isPinned ? "Unpin in Questify" : "Pin in Questify"}</button>
        <button type="button" class="btn-secondary btn-sm" data-note-pip="${escapeAttribute(note.id)}">${isPinnedAboveWindows ? "Unpin above windows" : "Pin above windows"}</button>
        <button type="button" class="btn-secondary btn-sm" data-note-open-window="${escapeAttribute(note.id)}">Open in window ↗</button>
        ${confirmingDelete
          ? `<span class="sticky-note-card__confirm">Delete this note?</span>
             <button type="button" class="btn-delete btn-sm" data-note-delete-confirm="${escapeAttribute(note.id)}">Delete</button>
             <button type="button" class="btn-secondary btn-sm" data-note-delete-cancel>Keep</button>`
          : `<button type="button" class="btn-delete btn-sm" data-note-delete="${escapeAttribute(note.id)}">Delete</button>`
        }
      </div>
    </article>
  `;
}

function attachStickyNotesHandlers() {
  const createNote = () => {
    const now = new Date().toISOString();
    const note = {
      id: generateId(),
      title: "New note",
      content: "",
      color: getRandomLockInNoteColor(),
      createdAt: now,
      updatedAt: now,
    };
    state.notes.unshift(note);
    confirmingNoteDeleteId = null;
    saveState();
    renderView();
    document.querySelector(`[data-note-title="${note.id}"]`)?.focus();
  };
  document.getElementById("create-sticky-note")?.addEventListener("click", createNote);
  document.querySelector("[data-create-first-note]")?.addEventListener("click", createNote);

  attachStickyNoteEditorHandlers();

  document.querySelectorAll("[data-note-color-id]").forEach((button) => {
    button.addEventListener("click", () => updateStickyNoteColor(button.dataset.noteColorId, button.dataset.noteColor));
  });
  document.querySelectorAll("[data-note-custom-color]").forEach((input) => {
    input.addEventListener("input", () => updateStickyNoteColor(input.dataset.noteCustomColor, input.value));
  });
  document.querySelectorAll("[data-note-open-window]").forEach((button) => {
    button.addEventListener("click", () => openStickyNoteWindow(button.dataset.noteOpenWindow));
  });
  document.querySelectorAll("[data-note-pip]").forEach((button) => {
    button.addEventListener("click", () => toggleSavedNotePictureInPicture(button.dataset.notePip));
  });
  document.querySelectorAll("[data-note-pin-app]").forEach((button) => {
    button.addEventListener("click", () => {
      const pinnedNote = getFloatingWidget("note");
      if (pinnedNote?.mode === "app" &&
          pinnedNote.kind === "saved" &&
          pinnedNote.id === button.dataset.notePinApp &&
          pinnedNote.ownerId === appWindowId) {
        setFloatingWidget("note", null);
      } else {
        setFloatingWidget("note", { mode: "app", kind: "saved", id: button.dataset.notePinApp });
      }
      renderView();
    });
  });
  document.querySelectorAll("[data-note-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      confirmingNoteDeleteId = button.dataset.noteDelete;
      renderView();
    });
  });
  document.querySelectorAll("[data-note-delete-confirm]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.noteDeleteConfirm;
      state.notes = state.notes.filter((note) => note.id !== id);
      if (getFloatingWidget("note")?.id === id) setFloatingWidget("note", null);
      confirmingNoteDeleteId = null;
      saveState();
      renderView();
    });
  });
  document.querySelectorAll("[data-note-delete-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      confirmingNoteDeleteId = null;
      renderView();
    });
  });
}

function attachStickyNoteEditorHandlers() {
  document.querySelectorAll("[data-note-title], [data-note-content]").forEach((input) => {
    input.addEventListener("input", () => {
      const noteId = input.dataset.noteTitle || input.dataset.noteContent;
      const note = state.notes.find((item) => item.id === noteId);
      if (!note) return;
      if (input.hasAttribute("data-note-title")) note.title = input.value.slice(0, 80);
      else note.content = input.value.slice(0, 2000);
      note.updatedAt = new Date().toISOString();
      const card = input.closest("[data-note-card]");
      const updatedLabel = card?.querySelector(".sticky-note-card__updated");
      if (updatedLabel) updatedLabel.textContent = "just now";
      saveState();
      syncAppFloatingWidgetNote();
      syncStickyNotePopupEditor(note);
      syncSavedNotePictureInPicture();
    });
  });
}

function updateStickyNoteColor(id, color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  note.color = color;
  note.updatedAt = new Date().toISOString();
  saveState();
  const card = [...document.querySelectorAll("[data-note-card]")]
    .find((element) => element.dataset.noteCard === id);
  if (card) {
    card.style.setProperty("--lockin-note-color", color);
    card.style.setProperty("--lockin-note-ink", getLockInNoteInk(color));
    card.querySelectorAll("[data-note-color-id]").forEach((button) => {
      const selected = button.dataset.noteColor === color;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const colorInput = card.querySelector("[data-note-custom-color]");
    if (colorInput) colorInput.value = color;
  }
  syncSavedNotePictureInPicture();
}

// -------------------------------------
// View registry
// -------------------------------------
const views = {
  consent: () => `
    <section class="consent-screen" aria-labelledby="consent-title">
      <div class="consent-card card">
        <img src="logo.svg" alt="Questify" class="consent-logo" width="64" height="64">
        <p class="dashboard-section__eyebrow">GETTING STARTED</p>
        <h1 id="consent-title">Review and accept</h1>
        <p class="text-muted consent-intro">Questify keeps your progress in this browser on this device. Review both documents below; you must agree to each before continuing.</p>
        <div class="consent-document-links">
          <a class="consent-document-link" href="privacy.html" target="_blank" rel="noopener">
            <span><strong>Read the Privacy Policy</strong><small>What data stays on this device and how reminders work · Opens in a new tab</small></span><span aria-hidden="true">↗</span>
          </a>
          <a class="consent-document-link" href="terms.html" target="_blank" rel="noopener">
            <span><strong>Read the Terms of Service</strong><small>How Questify works and the terms for using it · Opens in a new tab</small></span><span aria-hidden="true">↗</span>
          </a>
        </div>
        <form id="consent-form" novalidate>
          <fieldset class="consent-agreements" aria-describedby="consent-instructions consent-error">
            <legend>Agree to both documents</legend>
            <p class="consent-instructions" id="consent-instructions">Select both options to continue.</p>
            <label class="consent-check">
              <input type="checkbox" name="privacy" required aria-describedby="consent-instructions consent-error" aria-invalid="false">
              <span>I agree to the <a href="privacy.html" target="_blank" rel="noopener" aria-label="Privacy Policy, opens in a new tab">Privacy Policy</a>.</span>
            </label>
            <label class="consent-check">
              <input type="checkbox" name="terms" required aria-describedby="consent-instructions consent-error" aria-invalid="false">
              <span>I agree to the <a href="terms.html" target="_blank" rel="noopener" aria-label="Terms of Service, opens in a new tab">Terms of Service</a>.</span>
            </label>
          </fieldset>
          <p class="consent-error" id="consent-error" role="alert" aria-live="assertive"></p>
          <button type="submit" class="btn">Agree to both and continue</button>
        </form>
        <p class="consent-version">Document version ${LEGAL_POLICY_VERSION}</p>
      </div>
    </section>
  `,
  login: () => `
    <div class="login-screen">
      <div class="login-card card">
        <img src="logo.svg" alt="Questify logo" class="login-card__logo">
        <h1>Build Habits. Earn Streaks.</h1>
        <p class="text-muted">Enter your name to start your first streak today.</p>
        <form id="login-form" class="login-form" novalidate>
          <label for="login-name-input" class="sr-only">Your name</label>
          <input
            type="text"
            id="login-name-input"
            placeholder="Your name"
            autocomplete="off"
            aria-required="true"
          />
          <p class="error-text" id="login-error"></p>
          <button type="submit" class="btn">Start My Streak</button>
        </form>
      </div>
    </div>
  `,
  notes: () => renderStickyNotesPage(),
  lockin: () => `
    <section class="view-heading">
      <div>
        <p class="dashboard-section__eyebrow">FOCUS ON ONE THING</p>
        <h2>Lock In</h2>
        <p class="text-muted">Choose a focus block, quiet Questify notifications if you like, and keep your session in view.</p>
      </div>
    </section>
    ${renderLockInPanel()}
  `,
  dashboard: () => `
    <section class="dashboard-hero">
      <div class="dashboard-greeting">
        <p class="dashboard-greeting__date">${new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</p>
        <h2>Welcome back, ${escapeHTML(state.user.name)}</h2>
        <p class="text-muted">Small wins add up. Here's your day at a glance.</p>
      </div>
      <div class="dashboard-level-chip" aria-label="Level ${state.user.level}">
        <span>YOUR LEVEL</span>
        <strong>${state.user.level}</strong>
      </div>
    </section>

    ${renderFirstTimeWelcomeCard()}

    ${renderCalendarDayDetails(getTodayDateString(), "dashboard")}

    ${renderDashboardLockInCta()}

    ${renderResumeLockInBanner()}

    <section class="dashboard-section" aria-labelledby="dashboard-today-title">
      <div class="dashboard-section__heading">
        <div>
          <p class="dashboard-section__eyebrow">YOUR DAILY SNAPSHOT</p>
          <h3 id="dashboard-today-title">Today</h3>
        </div>
      </div>
      <div class="dashboard-overview-grid">
        ${renderTodaySummaryCard()}
        ${(() => {
          const goal = getDailyGoalProgress();
          const dueCount = getOverdueChallenges().length + getDueTodayChallenges().length;
          return `
            <div class="card dashboard-today-stats">
              <div class="dashboard-today-stats__item">
                <span class="dashboard-today-stats__icon" aria-hidden="true">✅</span>
                <span class="dashboard-today-stats__value">${getTodayCompletedCount()}</span>
                <span class="text-muted">completed today</span>
              </div>
              <div class="dashboard-today-stats__item">
                <span class="dashboard-today-stats__icon" aria-hidden="true">🎯</span>
                <span class="dashboard-today-stats__value">${Math.max(0, goal.goal - goal.completed)}</span>
                <span class="text-muted">to reach your goal</span>
              </div>
              <div class="dashboard-today-stats__item">
                <span class="dashboard-today-stats__icon" aria-hidden="true">📌</span>
                <span class="dashboard-today-stats__value">${dueCount}</span>
                <span class="text-muted">due or overdue</span>
              </div>
            </div>
          `;
        })()}
      </div>
    </section>

    ${(() => {
      const overdue = getOverdueChallenges();
      const dueToday = getDueTodayChallenges();
      const undoneCount = overdue.length + dueToday.length;

      if (undoneCount === 0) {
        return `
          <div class="card dashboard-all-done" role="status">
            <div class="dashboard-all-done__icon" aria-hidden="true">✨</div>
            <div class="dashboard-all-done__copy">
              <div class="dashboard-all-done__title">You're clear for today</div>
              <div class="text-muted">No overdue or scheduled challenges. Take a breath or plan your next small win.</div>
            </div>
          </div>
        `;
      }

      const overdueSection =
        overdue.length > 0
          ? `
            <h4 class="dashboard-subsection-title dashboard-subsection-title--overdue">⚠️ Overdue (${overdue.length})</h4>
            <div id="dashboard-overdue-list" class="challenge-list">
              ${overdue.map(renderChallengeCard).join("")}
            </div>
          `
          : "";

      const dueTodaySection =
        dueToday.length > 0
          ? `
            <h4 class="dashboard-subsection-title">Due Today (${dueToday.length})</h4>
            <div id="dashboard-due-today-list" class="challenge-list">
              ${dueToday.map(renderChallengeCard).join("")}
            </div>
          `
          : "";

      return overdueSection + dueTodaySection;
    })()}

    <section class="dashboard-section dashboard-section--tasks" aria-label="Add a challenge">
      <form id="quick-add-form" class="quick-add-form" novalidate>
        <label for="quick-add-input" class="quick-add-form__label">Add a small win</label>
        <div class="quick-add-form__controls">
          <input
            type="text"
            id="quick-add-input"
            placeholder="e.g. Stretch for 5 minutes"
            autocomplete="off"
          />
          <button type="submit" class="btn">Add challenge</button>
        </div>
      </form>
    </section>

    <section class="dashboard-section" aria-labelledby="dashboard-progress-title">
      <div class="dashboard-section__heading">
        <div>
          <p class="dashboard-section__eyebrow">YOUR MOMENTUM</p>
          <h3 id="dashboard-progress-title">Progress &amp; consistency</h3>
        </div>
      </div>
      <div class="dashboard-progress-grid">
        <div class="card dashboard-xp-card">
          <div class="dashboard-xp-card__stats">
            <div class="stat-card">
              <div class="stat-value">${state.user.xp}</div>
              <div class="stat-label text-muted">Total XP</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${getCompletedChallenges().length}</div>
              <div class="stat-label text-muted">Challenges completed</div>
            </div>
          </div>
          ${renderXpBar()}
        </div>
        <div class="card dashboard-activity-card">
          <div class="dashboard-card-heading">
            <div>
              <h4>Last 7 days</h4>
              <p class="text-muted">A little progress, every day.</p>
            </div>
          </div>
          ${renderActivityStrip()}
          ${(() => {
            const cmp = getWeekComparison();
            const arrow = cmp.delta > 0 ? "▲" : cmp.delta < 0 ? "▼" : "•";
            const deltaClass = cmp.delta > 0 ? "is-up" : cmp.delta < 0 ? "is-down" : "";
            const deltaText = cmp.delta === 0 ? "same as" : `${arrow} ${Math.abs(cmp.delta)} vs`;
            return `
              <p class="week-comparison-note text-muted">
                <strong>${cmp.thisWeekCount}</strong> this week ·
                <span class="week-comparison-delta ${deltaClass}">${deltaText}</span>
                last week (${cmp.lastWeekCount})
              </p>
            `;
          })()}
        </div>
      </div>
    </section>

    <section class="dashboard-section dashboard-insights-grid" aria-label="Weekly insights and badges">
      <div class="card dashboard-category-card">
        <div class="dashboard-card-heading">
          <div>
            <p class="dashboard-section__eyebrow">WEEKLY INSIGHT</p>
            <h4>Category balance</h4>
          </div>
          <span class="dashboard-card-heading__icon" aria-hidden="true">◒</span>
        </div>
        ${renderCategoryBalanceCards()}
      </div>
      <div class="dashboard-badges-card">
        <div class="dashboard-card-heading">
          <div>
            <p class="dashboard-section__eyebrow">KEEP IT UP</p>
            <h4>Recent badges</h4>
          </div>
          <span class="dashboard-card-heading__icon" aria-hidden="true">🏅</span>
        </div>
        <div class="badge-preview-strip">
      ${
        state.unlockedBadgeIds.length === 0
          ? `<p class="text-muted">No badges yet. Log a habit or complete a challenge to earn your first one.</p>`
          : state.unlockedBadgeIds
              .slice(-3)
              .reverse()
              .map((badgeId) => {
                const badge = BADGES.find((b) => b.id === badgeId);
                if (!badge) return "";
                return `
                  <div class="card badge-card is-unlocked">
                    <div class="badge-card__icon">${badge.icon}</div>
                    <div class="badge-card__name">${badge.name}</div>
                  </div>
                `;
              })
              .join("")
      }
        </div>
      </div>
    </section>
  `,
  challenges: () => `
    <section class="view-heading">
      <div>
        <p class="dashboard-section__eyebrow">PLAN YOUR NEXT WIN</p>
        <h2>Challenges</h2>
        <p class="text-muted">Turn the things you want to do into clear, achievable steps.</p>
      </div>
    </section>

    <form id="add-challenge-form" class="add-challenge-form" novalidate>
      <label for="add-challenge-input" class="sr-only">New challenge title</label>
      <input
        type="text"
        id="add-challenge-input"
        placeholder="e.g. Read for 20 minutes"
        autocomplete="off"
        maxlength="60"
        aria-required="true"
      />
      <label for="add-challenge-difficulty" class="sr-only">Difficulty</label>
      <select id="add-challenge-difficulty" class="difficulty-select">
        <option value="easy">Easy · 10 XP</option>
        <option value="medium">Medium · 20 XP</option>
        <option value="hard">Hard · 35 XP</option>
      </select>
      <label for="add-challenge-category" class="sr-only">Category</label>
      <select id="add-challenge-category" class="difficulty-select">
        ${Object.entries(CATEGORY_CONFIG)
          .filter(([id]) => id !== "lockin")
          .map(([id, cfg]) => `<option value="${id}">${cfg.icon} ${cfg.label}</option>`)
          .join("")}
      </select>
      <label for="add-challenge-recurrence" class="sr-only">Repeats</label>
      <select id="add-challenge-recurrence" class="difficulty-select">
        ${Object.entries(RECURRENCE_CONFIG)
          .map(([id, cfg]) => `<option value="${id}">${cfg.label}</option>`)
          .join("")}
      </select>
      <label for="add-challenge-date" class="sr-only">Scheduled date</label>
      <input
        type="date"
        id="add-challenge-date"
        class="date-input"
        value="${getTodayDateString()}"
      />
      <button type="submit" class="btn">Add</button>
    </form>
    <p class="error-text" id="add-challenge-error"></p>
    <p class="char-counter" id="add-challenge-counter">0/50</p>

    <div class="filter-bar">
      <label for="search-input" class="sr-only">Search challenges</label>
      <input
        type="text"
        id="search-input"
        class="search-input"
        placeholder="Search challenges..."
        autocomplete="off"
        value="${escapeHTML(searchQuery)}"
      />
      <div class="filter-buttons">
        <button class="filter-btn ${statusFilter === "all" ? "is-active" : ""}" data-filter="all">All</button>
        <button class="filter-btn ${statusFilter === "active" ? "is-active" : ""}" data-filter="active">Active</button>
        <button class="filter-btn ${statusFilter === "completed" ? "is-active" : ""}" data-filter="completed">Completed</button>
        <button class="filter-btn ${statusFilter === "archived" ? "is-active" : ""}" data-filter="archived">Archived</button>
      </div>
      <div class="filter-buttons">
        <button class="filter-btn ${dueFilter === "all" ? "is-active" : ""}" data-due-filter="all">All Dates</button>
        <button class="filter-btn ${dueFilter === "today" ? "is-active" : ""}" data-due-filter="today">Today</button>
        <button class="filter-btn ${dueFilter === "week" ? "is-active" : ""}" data-due-filter="week">This Week</button>
      </div>
    </div>

    <div id="challenge-list" class="challenge-list">
      ${(() => {
        const filtered = getFilteredChallenges();
        const regularChallengeCount = state.challenges.filter((challenge) => !challenge.isLockIn).length;

        if (regularChallengeCount === 0) {
          return `<p class="empty-state text-muted">No challenges yet. Add your first one above.</p>`;
        }

        if (filtered.length === 0) {
          return `<p class="empty-state text-muted">No challenges match your search/filter.</p>`;
        }

        return filtered.map(renderChallengeCard).join("");
      })()}
    </div>
  `,
  calendar: () => `
    <section class="view-heading calendar-view-heading">
      <div>
        <p class="dashboard-section__eyebrow">YOUR HABIT HISTORY</p>
        <h2>Calendar</h2>
        <p class="text-muted">Review daily check-ins, challenge wins, XP, and consistency over time.</p>
      </div>
      <div class="calendar-mode-switch" role="group" aria-label="Calendar view">
        ${[["month", "Month"], ["week", "Week"], ["day", "Day"]].map(([mode, label]) => `
          <button type="button" data-calendar-mode="${mode}" class="${calendarViewMode === mode ? "is-active" : ""}" aria-pressed="${calendarViewMode === mode}">${label}</button>
        `).join("")}
      </div>
    </section>

    ${calendarViewMode === "month"
      ? `${renderCalendarMonthInsights()}<section class="card calendar-month-view" aria-label="Monthly habit calendar">${renderCalendarGrid()}</section>`
      : calendarViewMode === "week"
      ? renderWeeklyView()
      : ""}
    ${renderCalendarDayDetails(calendarSelectedDate)}
    ${renderTodayHabitsCard()}
    ${renderWeeklyWinsCard()}
  `,
  habits: () => renderHabitTracker(),
  badges: () => {
    const easyBadges = BADGES.filter((b) => b.tier === "easy");
    const hardBadges = BADGES.filter((b) => b.tier === "hard");
    const unlockedCount = state.unlockedBadgeIds.length;

    const renderBadgeGrid = (badgeList) => `
      <div class="badge-grid">
        ${badgeList
          .map((badge) => {
            const isUnlocked = state.unlockedBadgeIds.includes(badge.id);
            return `
              <div class="card badge-card ${isUnlocked ? "is-unlocked" : "is-locked"}">
                <div class="badge-card__icon">${badge.icon}</div>
                <div class="badge-card__name">${badge.name}</div>
                <div class="badge-card__desc text-muted">${badge.description}</div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    return `
      <h2>Badges</h2>
      <p class="text-muted">Earn badges across habits, challenges, Lock In, streaks, XP, and the rest of Questify.</p>
      <p class="badge-progress-summary">${unlockedCount} / ${BADGES.length} unlocked</p>

      <h3 class="dashboard-section-title" style="margin-top: var(--space-lg);">
        Easy · ${easyBadges.filter((b) => state.unlockedBadgeIds.includes(b.id)).length}/${easyBadges.length}
      </h3>
      ${renderBadgeGrid(easyBadges)}

      <h3 class="dashboard-section-title" style="margin-top: var(--space-lg);">
        Hard · ${hardBadges.filter((b) => state.unlockedBadgeIds.includes(b.id)).length}/${hardBadges.length}
      </h3>
      ${renderBadgeGrid(hardBadges)}
    `;
  },
  profile: () => `
    <div class="profile-header">
      <h2>Profile</h2>
    </div>

    <div class="card">
      ${
        isEditingName
          ? `
        <form id="edit-name-form" class="edit-name-form" novalidate>
          <label for="edit-name-input" class="sr-only">Your name</label>
          <input
            type="text"
            id="edit-name-input"
            value="${escapeHTML(state.user.name)}"
            autocomplete="off"
            aria-required="true"
          />
          <button type="submit" class="btn">Save</button>
        </form>
        <p class="error-text" id="edit-name-error"></p>
      `
          : `
        <div class="profile-header">
          <h3>${escapeHTML(state.user.name)}</h3>
          <button class="btn-secondary" id="edit-name-btn">Edit Name</button>
        </div>
      `
      }

      <div class="profile-stats">
        <div class="stat-card">
          <div class="stat-value">${state.user.level}</div>
          <div class="stat-label text-muted">Level</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${state.user.streak}</div>
          <div class="stat-label text-muted">Day Streak</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${state.challenges.length}</div>
          <div class="stat-label text-muted">Challenges</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${getCompletedChallenges().length}</div>
          <div class="stat-label text-muted">Completed</div>
        </div>
      </div>

      ${renderXpBar()}
    </div>

    <section class="profile-progress-section" aria-labelledby="profile-progress-title">
      <div class="view-heading">
        <div>
          <p class="dashboard-section__eyebrow">YOUR MOMENTUM</p>
          <h3 id="profile-progress-title">Progress &amp; statistics</h3>
          <p class="text-muted">Your challenge, habit, and XP milestones in one place.</p>
        </div>
      </div>
      <div class="stats-summary">
        <div class="card stat-card">
          <div class="stat-value">${state.user.xp}</div>
          <div class="stat-label text-muted">Total XP</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${getTotalHabitCompletions()}</div>
          <div class="stat-label text-muted">Habit check-ins</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${
            state.challenges.length === 0
              ? "0%"
              : Math.round((getCompletedChallenges().length / state.challenges.length) * 100) + "%"
          }</div>
          <div class="stat-label text-muted">Challenge completion</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${state.unlockedBadgeIds.length} / ${BADGES.length}</div>
          <div class="stat-label text-muted">Badges</div>
        </div>
      </div>
      <div class="card chart-card">
        <h3>Last 7 days activity</h3>
        <canvas id="activity-chart"></canvas>
      </div>
    </section>
  `,
  settings: () => `
    <h2>Settings</h2>
    <p class="settings-intro">Make Questify feel right for you. Your choices are saved on this device.</p>

    ${renderInstallSection()}

    <div class="settings-section card settings-update-card">
      <div class="settings-row">
        <div>
          <div>Update Questify</div>
          <div class="text-muted">Check for a newer deployment. Questify will ask before installing it.</div>
        </div>
        <button id="update-app-btn" class="btn btn-sm" type="button">Check for updates</button>
      </div>
      <p id="update-app-status" class="settings-update-status text-muted" role="status" aria-live="polite">Check for updates to see whether you have the latest version.</p>
    </div>

    <section class="settings-section card" aria-labelledby="data-backup-title">
      <div class="settings-card-heading">
        <h3 id="data-backup-title">Import &amp; export data</h3>
        <p class="text-muted">Save a backup of your habits, challenges, notes, settings, and progress, or restore a Questify JSON backup. Importing replaces the data on this device.</p>
      </div>
      <div class="settings-row settings-data-actions">
        <button type="button" class="btn-secondary btn-sm" id="export-data-btn">Export data</button>
        <button type="button" class="btn-secondary btn-sm" id="import-data-btn">Import data</button>
        <input type="file" id="import-data-file" accept=".json,application/json" hidden>
      </div>
      <p id="data-backup-status" class="text-muted" role="status" aria-live="polite"></p>
    </section>

    <section class="settings-section card navigation-preferences" aria-labelledby="navigation-preferences-title">
      <div class="settings-card-heading">
        <h3 id="navigation-preferences-title">Navigation preferences</h3>
        <p class="text-muted">Choose how Questify navigation is arranged on this device. Auto adapts to your screen until you choose a layout.</p>
      </div>
      <div class="navigation-choice-grid" role="group" aria-label="Navigation layout">
        ${[
          ["auto", "Auto", "Adapts to screen size", "↔"],
          ["sidebar", "Sidebar", "Navigation beside your work", "☷"],
          ["bottom", "Bottom bar", "Navigation along the bottom", "▱"],
        ].map(([mode, label, description, glyph]) => `
          <button type="button" class="navigation-choice ${state.preferences.navigationMode === mode ? "is-selected" : ""}" data-navigation-mode="${mode}" aria-pressed="${state.preferences.navigationMode === mode}">
            <span class="navigation-choice__preview navigation-choice__preview--${mode}" aria-hidden="true"><span>${glyph}</span><i></i><i></i><i></i></span>
            <strong>${label}</strong>
            <small>${description}</small>
            ${mode === "auto" ? `<small class="navigation-choice__hint">Recommended</small>` : ""}
          </button>
        `).join("")}
      </div>
    </section>

    <section class="settings-section card settings-theme-card" aria-labelledby="theme-picker-title">
      <div class="settings-card-heading">
        <h3 id="theme-picker-title">Choose your look</h3>
        <p class="text-muted">Six complete styles, each with its own typography and visual mood. Saved on this device.</p>
      </div>
      <div class="theme-picker" role="group" aria-label="Color themes">
        ${APP_THEMES.map((theme) => `
          <button
            class="theme-option ${state.preferences.theme === theme.id ? "is-selected" : ""}"
            type="button"
            data-theme-choice="${theme.id}"
            aria-pressed="${state.preferences.theme === theme.id}"
          >
            <span class="theme-option__preview" aria-hidden="true">
              <i style="background-color: ${theme.swatches[0]}"></i>
              <i style="background-color: ${theme.swatches[1]}"></i>
              <i style="background-color: ${theme.swatches[2]}"></i>
            </span>
            <span class="theme-option__copy">
              <span class="theme-option__name">${theme.name}</span>
              <span class="theme-option__description">${theme.description}</span>
            </span>
          </button>
        `).join("")}
      </div>
    </section>

    <div class="settings-section card">
      <div class="settings-row">
        <div>
          <div>Daily Goal</div>
          <div class="text-muted">How many challenge and habit check-ins you want each day</div>
        </div>
        <input
          type="number"
          id="daily-goal-input"
          class="date-input weekly-goal-input"
          min="1"
          max="20"
          value="${state.user.dailyGoal}"
        />
      </div>
    </div>

    <section class="settings-section card" aria-labelledby="settings-feedback-title">
      <div class="settings-card-heading">
        <h3 id="settings-feedback-title">Notifications &amp; feedback</h3>
        <p class="text-muted">Choose what Questify can send and how it responds.</p>
      </div>
      <div class="settings-row">
        <div>
          <div>Sound Effects</div>
          <div class="text-muted">Play a short sound on completions and badge unlocks</div>
        </div>
        <div
          id="sound-switch"
          class="theme-switch ${state.preferences.soundEnabled ? "is-on" : ""}"
          role="switch"
          aria-checked="${state.preferences.soundEnabled}"
          aria-label="Toggle sound effects"
          tabindex="0"
        >
          <div class="theme-switch__knob"></div>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div>Haptic Feedback</div>
          <div class="text-muted">Vibrate on completions and badge unlocks (mobile only)</div>
        </div>
        <div
          id="haptics-switch"
          class="theme-switch ${state.preferences.hapticsEnabled ? "is-on" : ""}"
          role="switch"
          aria-checked="${state.preferences.hapticsEnabled}"
          aria-label="Toggle haptic feedback"
          tabindex="0"
        >
          <div class="theme-switch__knob"></div>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div>Daily Reminders</div>
          <div class="text-muted">${getReminderPermissionMessage()}</div>
          <div class="text-muted">At most one browser notification per day for overdue or due-today challenges.</div>
        </div>
        <div
          id="reminders-switch"
          class="theme-switch ${state.preferences.remindersEnabled ? "is-on" : ""}"
          role="switch"
          aria-checked="${state.preferences.remindersEnabled}"
          aria-label="Toggle daily reminders"
          tabindex="0"
        >
          <div class="theme-switch__knob"></div>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div>Quiet focus</div>
          <div class="text-muted">Mute Questify alerts and reminders during Lock In. This web app cannot silence other apps or system alerts.</div>
        </div>
        <div
          id="block-notifications-switch"
          class="theme-switch ${state.preferences.blockNotificationsDuringLockIn ? "is-on" : ""}"
          role="switch"
          aria-checked="${state.preferences.blockNotificationsDuringLockIn}"
          aria-label="Mute Questify notifications during Lock In"
          tabindex="0"
        >
          <div class="theme-switch__knob"></div>
        </div>
      </div>
      <p class="system-notifications-note">
        To pause notifications from every app, turn on your device's Do Not Disturb or Focus mode separately. Browsers do not provide web apps permission to control system-wide notifications.
      </p>
      </section>

      <section class="settings-section card" aria-labelledby="floating-window-settings-title">
        <div class="settings-card-heading">
          <h3 id="floating-window-settings-title">Floating windows</h3>
          <p class="text-muted">Pin the timer and notes in compact browser Picture-in-Picture windows. Browser support controls their always-on-top behavior.</p>
        </div>
        <div class="settings-row">
          <div>
            <div>Translucent appearance</div>
            <div class="text-muted">Use a softly transparent surface for floating timers and sticky notes.</div>
          </div>
          <div
            id="floating-transparency-switch"
            class="theme-switch ${state.preferences.floatingWindowsTransparent ? "is-on" : ""}"
            role="switch"
            aria-checked="${state.preferences.floatingWindowsTransparent}"
            aria-label="Toggle transparency for floating windows"
            tabindex="0"
          >
            <div class="theme-switch__knob"></div>
          </div>
        </div>
      </section>

      <section class="settings-section card settings-privacy-card" aria-labelledby="settings-privacy-title">
        <div>
          <h3 id="settings-privacy-title">Your privacy</h3>
          <p class="text-muted">Habits, challenges, and progress stay in this browser. Read what Questify stores and how browser notifications work.</p>
        </div>
        <div class="settings-legal-links">
          <a class="btn-secondary btn-sm settings-privacy-link" href="privacy.html">Privacy policy</a>
          <a class="btn-secondary btn-sm settings-privacy-link" href="terms.html">Terms of Service</a>
        </div>
      </section>

    <section class="settings-section card tour-replay-card" aria-labelledby="tour-replay-title">
      <div>
        <h3 id="tour-replay-title">Product walkthrough</h3>
        <p class="text-muted">Tour Daily Review, synced habit tracking, Calendar, Lock In, Sticky Notes, badges, Profile, and data backups.</p>
      </div>
      <button type="button" id="replay-tour-btn" class="btn-secondary btn-sm">Replay tour</button>
    </section>

    <div class="settings-section card">
      <div class="settings-row">
        <div>
          <div>Reset All Data</div>
          <div class="text-muted">Erases habits, challenges, XP, badges, and streak. Your name is kept.</div>
        </div>
        ${
          !isConfirmingReset
            ? `<button id="reset-data-btn" class="btn-danger btn-sm">Reset</button>`
            : ""
        }
      </div>
      ${
        isConfirmingReset
          ? `
        <div class="confirm-inline">
          <p>Are you sure? This cannot be undone.</p>
          <button id="confirm-reset-btn" class="btn-danger btn-sm">Yes, reset everything</button>
          <button id="cancel-reset-btn" class="btn-secondary btn-sm">Cancel</button>
        </div>
      `
          : ""
      }
    </div>

    <div class="settings-section card">
      <div class="settings-row">
        <div>
          <div>Log Out</div>
          <div class="text-muted">Clears your session on this device</div>
        </div>
        <button id="logout-btn" class="btn-secondary btn-sm">Log Out</button>
      </div>
    </div>
  `,
};

// -------------------------------------
// Shared: wire up Complete/Delete clicks on any challenge list container
// Using document-level delegation to avoid memory leaks from repeated attachments
// -------------------------------------
function attachChallengeListDelegation(listElId) {
  const listEl = document.getElementById(listElId);
  if (!listEl) return;

  // Use document-level delegation - only attach once
  // The listElId parameter is kept for backwards compatibility but not used
  // All challenge action buttons have data-action attributes
  if (!document.__challengeDelegationAttached) {
    document.__challengeDelegationAttached = true;
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const card = e.target.closest(".challenge-card");
      const id = card?.dataset.id;
      if (!id) return;

      const action = btn.dataset.action;

      if (action === "complete") {
        completeChallenge(id);
        renderView();
      }

      if (action === "delete") {
        deleteChallenge(id);
        renderView();
      }

      if (action === "archive") {
        archiveChallenge(id);
        renderView();
      }

      if (action === "unarchive") {
        unarchiveChallenge(id);
        renderView();
      }
    });
  }
}

// -------------------------------------
// Wire up the dashboard view after it's rendered
// -------------------------------------
function attachDashboardHandlers() {
  attachChallengeListDelegation("dashboard-overdue-list");
  attachChallengeListDelegation("dashboard-due-today-list");

  // First-time user: Add First Challenge button
  const firstChallengeBtn = document.getElementById("first-challenge-btn");
  if (firstChallengeBtn) {
    dismissFirstStepWelcome();
    firstChallengeBtn.addEventListener("click", () => {
      const added = addChallenge("Read for 5 minutes", "easy", getTodayDateString(), "learning");
      if (!added) {
        showToast("⚠️ Could not add your first challenge. Please try again.");
        return;
      }
      triggerActionFeedback();
      showToast("📖 Your first step is ready. Go make it a win!");
      renderView();
    });
  }

  const customFirstChallengeBtn = document.getElementById("custom-first-challenge-btn");
  if (customFirstChallengeBtn) {
    customFirstChallengeBtn.addEventListener("click", () => {
      dismissFirstStepWelcome();
      navigateTo("challenges");
    });
  }

  const quickAddForm = document.getElementById("quick-add-form");
  if (quickAddForm) {
    quickAddForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("quick-add-input");

      const result = validateText(input.value, {
        ...VALIDATION_RULES.challengeTitle,
        fieldName: "Challenge title",
      });

      if (!result.isValid) {
        showToast(`⚠️ ${escapeHTML(result.errorMessage)}`);
        return;
      }

      addChallenge(result.value);
      renderView();
    });
  }

  const resumeLockInBtn = document.getElementById("dashboard-resume-lockin-btn");
  if (resumeLockInBtn) {
    resumeLockInBtn.addEventListener("click", () => {
      navigateTo("lockin");
    });
  }

  const startLockInBtn = document.getElementById("dashboard-lockin-btn");
  if (startLockInBtn) {
    startLockInBtn.addEventListener("click", () => {
      navigateTo("lockin");
    });
  }
}

function attachHabitHandlers() {
  if (!document.__habitDelegationAttached) {
    document.__habitDelegationAttached = true;
    document.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-habit-toggle]");
      if (toggle && !toggle.disabled) {
        const didToggle = toggleHabitCompletion(toggle.dataset.habitId, toggle.dataset.habitDate);
        if (didToggle) renderView();
        return;
      }

      const archiveButton = event.target.closest("[data-habit-archive]");
      if (archiveButton) {
        archiveHabit(archiveButton.dataset.habitArchive);
        renderView();
        return;
      }

      const editButton = event.target.closest("[data-habit-edit]");
      if (editButton) {
        editingHabitId = editingHabitId === editButton.dataset.habitEdit ? null : editButton.dataset.habitEdit;
        renderView();
        return;
      }

      const deleteButton = event.target.closest("[data-habit-delete]");
      if (deleteButton) {
        confirmingHabitDeleteId = deleteButton.dataset.habitDelete;
        renderView();
        document.querySelector(".habit-delete-overlay [data-habit-delete-cancel]")?.focus();
        return;
      }

      if (event.target.closest("[data-habit-delete-cancel]")) {
        confirmingHabitDeleteId = null;
        renderView();
        return;
      }

      if (event.target.closest("[data-habit-delete-confirm]")) {
        const deleted = deleteHabit(confirmingHabitDeleteId);
        confirmingHabitDeleteId = null;
        editingHabitId = null;
        renderView();
        if (deleted) showToast("Habit deleted. Previously earned XP remains yours.");
        return;
      }

      const periodButton = event.target.closest("[data-habit-period]");
      if (periodButton) {
        habitAnalyticsPeriod = periodButton.dataset.habitPeriod;
        renderView();
        return;
      }

      const navigateButton = event.target.closest("[data-navigate]");
      if (navigateButton) {
        navigateTo(navigateButton.dataset.navigate);
      }
    });
  }

  const form = document.getElementById("add-habit-form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("add-habit-input");
      const descriptionInput = document.getElementById("add-habit-description");
      const difficultyInput = document.getElementById("add-habit-difficulty");
      const categoryInput = document.getElementById("add-habit-category");
      const error = document.getElementById("add-habit-error");
      const result = addHabit(input.value, descriptionInput.value, difficultyInput.value, categoryInput.value);
      if (!result.ok) {
        error.textContent = result.error;
        input.classList.add("input-error");
        return;
      }
      renderView();
      document.getElementById("add-habit-input")?.focus();
    });
  }

  document.querySelectorAll("[data-habit-edit-form]").forEach((editForm) => {
    editForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(editForm);
      const result = editHabit(
        editForm.dataset.habitEditForm,
        String(formData.get("title") || ""),
        String(formData.get("description") || ""),
        String(formData.get("difficulty") || "medium"),
        String(formData.get("category") || "general")
      );
      if (!result.ok) {
        editForm.querySelector("[data-habit-edit-error]").textContent = result.error;
        return;
      }
      editingHabitId = null;
      renderView();
      showToast("Habit updated. Its check-in history is unchanged.");
    });
  });

  const previousWeek = document.getElementById("habits-week-prev-btn");
  if (previousWeek) {
    previousWeek.addEventListener("click", () => {
      weekViewDate.setDate(weekViewDate.getDate() - 7);
      renderView();
    });
  }

  const nextWeek = document.getElementById("habits-week-next-btn");
  if (nextWeek) {
    nextWeek.addEventListener("click", () => {
      weekViewDate.setDate(weekViewDate.getDate() + 7);
      renderView();
    });
  }
}

// -------------------------------------
// Wire up the calendar view after it's rendered
// -------------------------------------
function attachCalendarHandlers() {
  document.querySelectorAll("[data-calendar-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      calendarViewMode = button.dataset.calendarMode;
      renderView();
    });
  });

  const todayButton = document.getElementById("calendar-today-btn");
  if (todayButton) {
    todayButton.addEventListener("click", () => {
      calendarSelectedDate = getTodayDateString();
      calendarViewDate = new Date();
      weekViewDate = new Date();
      renderView();
    });
  }

  document.querySelectorAll("[data-calendar-day-offset]").forEach((button) => {
    button.addEventListener("click", () => {
      calendarSelectedDate = addDaysToDateString(calendarSelectedDate, Number(button.dataset.calendarDayOffset));
      calendarViewDate = new Date(`${calendarSelectedDate}T00:00:00`);
      renderView();
    });
  });

  const prevBtn = document.getElementById("calendar-prev-btn");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      const selected = new Date(`${calendarSelectedDate}T00:00:00`);
      const target = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
      const day = Math.min(selected.getDate(), new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate());
      calendarViewDate = target;
      calendarSelectedDate = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      renderView();
    });
  }

  const nextBtn = document.getElementById("calendar-next-btn");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const selected = new Date(`${calendarSelectedDate}T00:00:00`);
      const target = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
      const day = Math.min(selected.getDate(), new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate());
      calendarViewDate = target;
      calendarSelectedDate = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      renderView();
    });
  }

  document.querySelectorAll(".calendar-day[data-calendar-date]").forEach((dayButton) => {
    dayButton.addEventListener("click", () => {
      calendarSelectedDate = dayButton.dataset.calendarDate;
      renderView();
    });
  });

  const weekPrevBtn = document.getElementById("week-prev-btn");
  if (weekPrevBtn) {
    weekPrevBtn.addEventListener("click", () => {
      weekViewDate.setDate(weekViewDate.getDate() - 7);
      calendarSelectedDate = addDaysToDateString(calendarSelectedDate, -7);
      renderView();
    });
  }

  const weekNextBtn = document.getElementById("week-next-btn");
  if (weekNextBtn) {
    weekNextBtn.addEventListener("click", () => {
      weekViewDate.setDate(weekViewDate.getDate() + 7);
      calendarSelectedDate = addDaysToDateString(calendarSelectedDate, 7);
      renderView();
    });
  }

  const weekGrid = document.getElementById("week-grid");
  if (weekGrid) {
    weekGrid.addEventListener("click", (e) => {
      const chip = e.target.closest(".week-chip.is-active");
      if (chip) {
        const id = chip.dataset.id;
        if (!id) return;
        completeChallenge(id);
        renderView();
        return;
      }

      const dayCard = e.target.closest(".week-day-card");
      if (dayCard) {
        calendarSelectedDate = dayCard.dataset.date;
        renderView();
      }
    });

    weekGrid.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const dayCard = event.target.closest(".week-day-card");
      if (!dayCard) return;
      event.preventDefault();
      calendarSelectedDate = dayCard.dataset.date;
      renderView();
    });
  }

  const dayDetailOverlay = document.getElementById("day-detail-overlay");
  if (dayDetailOverlay) {
    dayDetailOverlay.addEventListener("click", (e) => {
      if (e.target.id === "day-detail-overlay") {
        dayDetailDate = null;
        renderView();
      }
    });
  }

  const dayDetailCloseBtn = document.getElementById("day-detail-close-btn");
  if (dayDetailCloseBtn) {
    dayDetailCloseBtn.addEventListener("click", () => {
      dayDetailDate = null;
      renderView();
    });
  }

}

// -------------------------------------
// Wire up the challenges view after it's rendered
// -------------------------------------
function attachChallengesHandlers() {
  document.querySelectorAll(".lockin-open-window-btn").forEach((button) => {
    button.addEventListener("click", openLockInFocusWindow);
  });

  document.getElementById("lockin-timer-app-toggle")?.addEventListener("click", () => {
    const timerWidget = getFloatingWidget("timer");
    if (timerWidget?.mode === "app" && timerWidget.ownerId === appWindowId) {
      setFloatingWidget("timer", null);
    } else {
      if (lockInPictureInPictureWindow && !lockInPictureInPictureWindow.closed) {
        closeLockInPictureInPicture();
      }
      setFloatingWidget("timer", { mode: "app", kind: "lockin", id: getActiveLockIn()?.id });
    }
    renderView();
  });

  document.getElementById("lockin-session-note-app-btn")?.addEventListener("click", () => {
    const noteWidget = getFloatingWidget("note");
    if (noteWidget?.mode === "app" && noteWidget.kind === "session" && noteWidget.ownerId === appWindowId) {
      setFloatingWidget("note", null);
    } else {
      if (sessionNotePictureInPictureWindow && !sessionNotePictureInPictureWindow.closed) {
        closeSessionNotePictureInPicture();
      }
      const active = getActiveLockIn();
      if (active) setFloatingWidget("note", { mode: "app", kind: "session", id: active.id });
    }
    renderView();
  });

  const lockInNoteInput = document.getElementById("lockin-note-input");
  if (lockInNoteInput) {
    lockInNoteInput.addEventListener("input", () => {
      const active = getActiveLockIn();
      if (!active) return;
      active.sessionNote = lockInNoteInput.value.slice(0, 500);
      const savedLabel = document.getElementById("lockin-note-saved");
      if (savedLabel) savedLabel.textContent = active.savedNoteId
        ? "Session changes not saved to Sticky Notes"
        : "Session only";
      saveState();
      syncSessionNotePictureInPicture();
    });
  }
  document.getElementById("lockin-session-note-pip-btn")?.addEventListener("click", toggleSessionNotePictureInPicture);
  document.getElementById("lockin-save-note-btn")?.addEventListener("click", saveLockInNoteToLibrary);
  document.querySelectorAll("[data-lockin-note-color]").forEach((button) => {
    button.addEventListener("click", () => updateLockInNoteColor(button.dataset.lockinNoteColor));
  });
  document.getElementById("lockin-note-color")?.addEventListener("input", (event) => {
    updateLockInNoteColor(event.currentTarget.value);
  });

  document.getElementById("lockin-focus-window-close")?.addEventListener("click", () => {
    if (window.opener && !window.opener.closed) {
      window.close();
      return;
    }
    const appUrl = new URL(window.location.href);
    appUrl.searchParams.delete("focus");
    appUrl.hash = "";
    window.location.replace(appUrl.toString());
  });
  document.getElementById("lockin-picture-in-picture-btn")?.addEventListener("click", openLockInPictureInPicture);
  document.querySelectorAll("[data-timer-pin]").forEach((button) => {
    button.addEventListener("click", openLockInPictureInPicture);
  });
  document.querySelectorAll("[data-timer-window-close], [data-session-note-window-close]").forEach((button) => {
    button.addEventListener("click", () => window.close());
  });

  const quietFocusSwitch = document.getElementById("lockin-notifications-switch");
  if (quietFocusSwitch) {
    const toggleQuietFocus = () => {
      setBlockNotificationsDuringLockIn(!state.preferences.blockNotificationsDuringLockIn);
      renderView();
    };
    quietFocusSwitch.addEventListener("click", toggleQuietFocus);
    quietFocusSwitch.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleQuietFocus();
      }
    });
  }

  const lockinStartForm = document.getElementById("lockin-start-form");
  if (lockinStartForm) {
    lockinStartForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const titleInput = document.getElementById("lockin-title-input");
      const difficultySelect = document.getElementById("lockin-difficulty-select");
      const durationSelect = document.getElementById("lockin-duration-select");
      const customInput = document.getElementById("lockin-custom-minutes-input");
      const quietFocusInput = document.getElementById("lockin-start-quiet-input");
      const errorEl = document.getElementById("lockin-error");

      const isCustom = durationSelect.value === "custom";
      const minutesValue = isCustom ? customInput.value : durationSelect.value;

      if (isCustom && (!customInput.value || parseInt(customInput.value, 10) < 1)) {
        errorEl.textContent = "Enter a valid number of minutes.";
        return;
      }

      const result = startLockIn(titleInput.value, minutesValue, difficultySelect.value, quietFocusInput.checked);
      if (!result.ok) {
        errorEl.textContent = result.error;
        return;
      }
      errorEl.textContent = "";
      renderView();
    });
  }

  const lockinDurationSelect = document.getElementById("lockin-duration-select");
  const lockinCustomInput = document.getElementById("lockin-custom-minutes-input");
  const lockinDurationOptions = document.querySelector(".lockin-duration-options");
  if (lockinDurationSelect && lockinCustomInput && lockinDurationOptions) {
    lockinDurationOptions.addEventListener("click", (event) => {
      const option = event.target.closest(".lockin-duration-option");
      if (!option) return;

      lockinDurationSelect.value = option.dataset.duration;
      if (option.dataset.duration !== "custom") {
        state.preferences.lastLockInDuration = Number(option.dataset.duration);
        saveState();
      }
      lockinDurationOptions.querySelectorAll(".lockin-duration-option").forEach((button) => {
        const isSelected = button === option;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-pressed", String(isSelected));
      });

      const isCustom = lockinDurationSelect.value === "custom";
      lockinCustomInput.classList.toggle("is-hidden", !isCustom);
      if (isCustom) lockinCustomInput.focus();
    });
    lockinCustomInput.addEventListener("input", () => {
      const minutes = Number(lockinCustomInput.value);
      if (minutes >= 1 && minutes <= 240) {
        state.preferences.lastLockInDuration = minutes;
        saveState();
      }
    });
  }

  const lockinFinishBtn = document.getElementById("lockin-finish-btn");
  if (lockinFinishBtn) {
    lockinFinishBtn.addEventListener("click", () => {
      finishLockIn(lockinFinishBtn.dataset.id);
      renderView();
    });
  }

  const lockinCancelBtn = document.getElementById("lockin-cancel-btn");
  if (lockinCancelBtn) {
    lockinCancelBtn.addEventListener("click", () => {
      cancelLockIn(lockinCancelBtn.dataset.id);
      renderView();
    });
  }

  const lockinPauseBtn = document.getElementById("lockin-pause-btn");
  if (lockinPauseBtn) {
    lockinPauseBtn.addEventListener("click", () => {
      const active = getActiveLockIn();
      if (!active) return;
      if (active.isPaused) {
        resumeLockIn(lockinPauseBtn.dataset.id);
        showToast("▶️ Resumed");
      } else {
        pauseLockIn(lockinPauseBtn.dataset.id);
        showToast("⏸️ Session paused");
      }
      triggerActionFeedback();
      renderView();
    });
  }

  const lockinAddTimeBtn = document.getElementById("lockin-add-time-btn");
  if (lockinAddTimeBtn) {
    lockinAddTimeBtn.addEventListener("click", () => {
      addLockInTime(lockinAddTimeBtn.dataset.id, 10);
      showToast("⏱️ +10 minutes added");
      triggerActionFeedback();
      renderView();
      const timerEl = document.getElementById("lockin-timer");
      if (timerEl) {
        timerEl.classList.add("is-pulsing");
        setTimeout(() => timerEl.classList.remove("is-pulsing"), 500);
      }
    });
  }

  startLockInTicker();

  const form = document.getElementById("add-challenge-form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("add-challenge-input");
      const errorEl = document.getElementById("add-challenge-error");

      const result = validateText(input.value, {
        ...VALIDATION_RULES.challengeTitle,
        fieldName: "Challenge title",
      });

      if (!result.isValid) {
        errorEl.textContent = result.errorMessage;
        input.classList.add("input-error");
        return;
      }

      errorEl.textContent = "";
      input.classList.remove("input-error");
      const difficultySelect = document.getElementById("add-challenge-difficulty");
      const difficulty = difficultySelect ? difficultySelect.value : "easy";
      const categorySelect = document.getElementById("add-challenge-category");
      const category = categorySelect ? categorySelect.value : "general";
      const recurrenceSelect = document.getElementById("add-challenge-recurrence");
      const recurrence = recurrenceSelect ? recurrenceSelect.value : "none";
      const dateInput = document.getElementById("add-challenge-date");
      const scheduledDate = dateInput && dateInput.value ? dateInput.value : getTodayDateString();
      addChallenge(result.value, difficulty, scheduledDate, category, recurrence);
      renderView();
    });

    const input = document.getElementById("add-challenge-input");
    const counterEl = document.getElementById("add-challenge-counter");
    if (input && counterEl) {
      input.addEventListener("input", () => {
        updateCharCounter(input, counterEl, VALIDATION_RULES.challengeTitle.maxLength);
      });
    }
  }

  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    // Create singleton debounced function if it doesn't exist
    if (!debouncedSearchRerender) {
      debouncedSearchRerender = debounce(() => {
        renderView();
        const newSearchInput = document.getElementById("search-input");
        if (newSearchInput) {
          newSearchInput.focus();
          newSearchInput.setSelectionRange(searchQuery.length, searchQuery.length);
        }
      }, CONFIG.SEARCH_DEBOUNCE_MS);
    }

    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      debouncedSearchRerender();
    });
  }

  const filterBtns = document.querySelectorAll(".filter-btn");
  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.filter) {
        statusFilter = btn.dataset.filter;
      } else if (btn.dataset.dueFilter) {
        dueFilter = btn.dataset.dueFilter;
      }
      renderView();
    });
  });

  attachChallengeListDelegation("challenge-list");
}

// -------------------------------------
// Wire up the profile view after it's rendered
// -------------------------------------
function attachProfileHandlers() {
  const editBtn = document.getElementById("edit-name-btn");
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      isEditingName = true;
      renderView();
    });
  }

  const editForm = document.getElementById("edit-name-form");
  if (editForm) {
    editForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("edit-name-input");
      const errorEl = document.getElementById("edit-name-error");

      const result = validateText(input.value, {
        ...VALIDATION_RULES.userName,
        fieldName: "Name",
      });

      if (!result.isValid) {
        errorEl.textContent = result.errorMessage;
        input.classList.add("input-error");
        return;
      }

      state.user.name = result.value;
      saveState();
      isEditingName = false;
      renderView();
    });
  }
}

function setAppUpdateStatus(message) {
  const status = document.getElementById("update-app-status");
  if (status) status.textContent = message;
}

function closeAppUpdatePrompt() {
  if (!appUpdatePrompt) return;
  if (appUpdatePrompt.open) appUpdatePrompt.close();
  appUpdatePrompt.remove();
  appUpdatePrompt = null;
}

function getLastUpdatePromptDismissedAt() {
  try {
    const stored = Number(localStorage.getItem(UPDATE_REMINDER_STORAGE_KEY));
    return Number.isFinite(stored) ? stored : 0;
  } catch (error) {
    console.error("Could not read the app update reminder schedule:", error);
    return 0;
  }
}

function rememberUpdatePromptDismissal() {
  try {
    localStorage.setItem(UPDATE_REMINDER_STORAGE_KEY, String(Date.now()));
  } catch (error) {
    console.error("Could not save the app update reminder schedule:", error);
    showToast("Questify could not save your update reminder preference.");
  }
}

function maybeShowAvailableAppUpdate(registration, isNewDeployment = false) {
  if (!registration?.waiting || appUpdatePrompt || document.visibilityState === "hidden") return;
  const lastDismissedAt = getLastUpdatePromptDismissedAt();
  if (!isNewDeployment && lastDismissedAt &&
      Date.now() - lastDismissedAt < UPDATE_REMINDER_INTERVAL_MS) return;
  showAppUpdatePrompt(registration, null);
}

async function checkForAvailableAppUpdate(registration) {
  if (!navigator.onLine || !registration ||
      Date.now() - lastBackgroundUpdateCheckAt < 5 * 60 * 1000) return;
  lastBackgroundUpdateCheckAt = Date.now();
  try {
    await registration.update();
    maybeShowAvailableAppUpdate(registration);
  } catch (error) {
    console.warn("Background check for a Questify update failed:", error);
  }
}

function initServiceWorkerUpdateNotifications() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then((registration) => {
    appUpdateRegistration = registration;

    const watchInstallingWorker = (worker) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" &&
            registration.waiting &&
            navigator.serviceWorker.controller) {
          maybeShowAvailableAppUpdate(registration, true);
        }
      });
    };

    registration.addEventListener("updatefound", () => {
      watchInstallingWorker(registration.installing);
    });
    watchInstallingWorker(registration.installing);
    maybeShowAvailableAppUpdate(registration);

    const checkForUpdates = () => checkForAvailableAppUpdate(registration);
    window.addEventListener("online", checkForUpdates);
    window.addEventListener("focus", checkForUpdates);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdates();
    });
    checkForUpdates();

    if (!appUpdateCheckIntervalId) {
      appUpdateCheckIntervalId = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
    }
    if (!appUpdateReminderIntervalId) {
      appUpdateReminderIntervalId = setInterval(
        () => maybeShowAvailableAppUpdate(appUpdateRegistration),
        60 * 60 * 1000
      );
    }
  }).catch((error) => {
    console.warn("Could not initialize Questify deployment notifications:", error);
  });
}

function activateAppUpdate(registration, button) {
  const waitingWorker = registration.waiting;
  if (!waitingWorker) {
    closeAppUpdatePrompt();
    setAppUpdateStatus("The update is no longer waiting. Check again to see the current version.");
    if (button) {
      button.disabled = false;
      button.textContent = "Check for updates";
    }
    return;
  }

  shouldReloadForAppUpdate = true;
  setAppUpdateStatus("Installing update… Questify will reload when it is ready.");
  if (button) {
    button.disabled = true;
    button.textContent = "Updating…";
  }
  closeAppUpdatePrompt();
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (appUpdateActivationTimeoutId) clearTimeout(appUpdateActivationTimeoutId);
    appUpdateActivationTimeoutId = null;
    if (shouldReloadForAppUpdate) window.location.reload();
  }, { once: true });
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
  appUpdateActivationTimeoutId = setTimeout(() => {
    shouldReloadForAppUpdate = false;
    appUpdateActivationTimeoutId = null;
    setAppUpdateStatus("The update did not finish activating. You can keep using this version and try again.");
    if (button) {
      button.disabled = false;
      button.textContent = "Check for updates";
    }
  }, 30000);
}

function showAppUpdatePrompt(registration, button) {
  appUpdateRegistration = registration;
  closeAppUpdatePrompt();
  appUpdatePrompt = document.createElement("dialog");
  appUpdatePrompt.className = "app-update-dialog";
  appUpdatePrompt.setAttribute("aria-labelledby", "app-update-dialog-title");
  appUpdatePrompt.innerHTML = `
    <div class="app-update-dialog__icon" aria-hidden="true">↻</div>
    <p class="dashboard-section__eyebrow">A FRESH QUESTIFY IS READY</p>
    <h2 id="app-update-dialog-title">Update available</h2>
    <p>A newer deployment is ready. Update now to load it, or keep using this version and update later from Settings.</p>
    <div class="app-update-dialog__actions">
      <button type="button" class="btn-secondary" data-update-keep>Keep using this version</button>
      <button type="button" class="btn" data-update-accept>Update now</button>
    </div>
  `;
  document.body.append(appUpdatePrompt);
  appUpdatePrompt.querySelector("[data-update-keep]")?.addEventListener("click", () => {
    closeAppUpdatePrompt();
    rememberUpdatePromptDismissal();
    setAppUpdateStatus("Update available. You can keep using this version and update later from Settings.");
    if (button) {
      button.disabled = false;
      button.textContent = "Check for updates";
    }
  });
  appUpdatePrompt.querySelector("[data-update-accept]")?.addEventListener("click", () => {
    activateAppUpdate(registration, button);
  });
  appUpdatePrompt.addEventListener("cancel", (event) => {
    event.preventDefault();
    appUpdatePrompt.querySelector("[data-update-keep]")?.click();
  });
  appUpdatePrompt.showModal();
  appUpdatePrompt.querySelector("[data-update-accept]")?.focus();
}

function waitForServiceWorkerInstall(worker) {
  if (["installed", "activated", "redundant"].includes(worker.state)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      worker.removeEventListener("statechange", handleStateChange);
      reject(new Error("Questify's update is taking longer than expected. Please try again."));
    }, 30000);
    const handleStateChange = () => {
      if (!["installed", "activated", "redundant"].includes(worker.state)) return;
      clearTimeout(timeoutId);
      worker.removeEventListener("statechange", handleStateChange);
      resolve();
    };
    worker.addEventListener("statechange", handleStateChange);
  });
}

async function updateApp(button) {
  button.disabled = true;
  button.textContent = "Checking…";
  setAppUpdateStatus("Checking for a newer Questify deployment…");

  try {
    if (!navigator.onLine) throw new Error("An internet connection is required to check for updates.");
    if (!("serviceWorker" in navigator)) throw new Error("Service workers are not supported in this browser.");

    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error("Questify is not installed as a service worker on this browser.");

    if (!registration.waiting) {
      await registration.update();
      const installing = registration.installing;
      if (installing) await waitForServiceWorkerInstall(installing);
    }

    if (registration.waiting) {
      setAppUpdateStatus("A newer version is ready for you to review.");
      showAppUpdatePrompt(registration, button);
      return;
    }

    setAppUpdateStatus("You're up to date. No newer Questify deployment is available.");
    button.disabled = false;
    button.textContent = "Check for updates";
  } catch (error) {
    console.error("Failed to check for Questify updates:", error);
    const message = error instanceof Error ? error.message : "Questify couldn't check for updates.";
    setAppUpdateStatus(message);
    button.disabled = false;
    button.textContent = "Try again";
    showToast(`⚠️ ${escapeHTML(message)}`);
  }
}

function initPullToRefresh() {
  const indicator = document.getElementById("pull-refresh-indicator");
  const label = document.getElementById("pull-refresh-label");
  if (!indicator || !label) return;

  const ring = indicator.querySelector(".pull-refresh-indicator__ring");
  const refreshThreshold = 52;
  const ringCircumference = 182;
  let startY = null;
  let pullDistance = 0;
  let isRefreshing = false;

  const canStartPull = (target) => (
    !isRefreshing &&
    window.scrollY <= 1 &&
    !target.closest("button, a, input, textarea, select, [contenteditable='true']")
  );

  const updateIndicator = (distance) => {
    pullDistance = Math.min(88, Math.max(0, (distance - 4) * 0.72));
    indicator.style.setProperty("--indicator-offset", `${Math.min(32, pullDistance * 0.5)}px`);
    document.body.style.setProperty("--refresh-content-shift", `${pullDistance * 0.72}px`);
    document.body.classList.add("is-pulling-to-refresh");
    ring?.style.setProperty(
      "stroke-dasharray",
      `${ringCircumference * Math.min(1, pullDistance / refreshThreshold)} ${ringCircumference}`
    );
    indicator.style.setProperty("--pull-distance", `${pullDistance}px`);
    indicator.classList.add("is-pulling");
    indicator.classList.toggle("is-ready", pullDistance >= refreshThreshold);
    indicator.setAttribute("aria-hidden", "false");
    label.textContent = pullDistance >= refreshThreshold ? "Release to refresh" : "Pull to refresh";
  };

  const resetIndicator = () => {
    indicator.classList.remove("is-pulling", "is-ready", "is-refreshing");
    indicator.style.removeProperty("--pull-distance");
    indicator.style.removeProperty("--indicator-offset");
    document.body.classList.remove("is-pulling-to-refresh");
    document.body.style.removeProperty("--refresh-content-shift");
    ring?.style.setProperty("stroke-dasharray", `0 ${ringCircumference}`);
    indicator.setAttribute("aria-hidden", "true");
    label.textContent = "Pull to refresh";
    startY = null;
    pullDistance = 0;
  };

  const refresh = async () => {
    isRefreshing = true;
    indicator.classList.remove("is-pulling", "is-ready");
    indicator.classList.add("is-refreshing");
    indicator.style.setProperty("--pull-distance", "76px");
    indicator.style.setProperty("--indicator-offset", "32px");
    ring?.style.setProperty("stroke-dasharray", "52 130");
    label.textContent = "Refreshing…";
    indicator.setAttribute("aria-hidden", "false");

    try {
      if (navigator.onLine && "serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.update();
          if (registration.waiting) {
            showToast("A Questify update is ready. Review it in Settings when you’re ready.");
          }
        }
      }
      window.location.reload();
    } catch (error) {
      console.error("Failed to refresh Questify:", error);
      showToast(`⚠️ ${escapeHTML(error.message || "Questify couldn't refresh.")}`);
      isRefreshing = false;
      resetIndicator();
    }
  };

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) {
      resetIndicator();
      return;
    }
    if (!canStartPull(event.target)) return;
    startY = event.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (startY === null) return;
    if (event.touches.length !== 1) {
      resetIndicator();
      return;
    }
    const distance = event.touches[0].clientY - startY;
    if (distance <= 5 || window.scrollY > 0) return;
    if (event.cancelable) event.preventDefault();
    updateIndicator(distance);
  }, { passive: false });

  document.addEventListener("touchend", (event) => {
    if (startY === null) return;
    if (event.touches.length > 0) {
      resetIndicator();
      return;
    }
    const shouldRefresh = pullDistance >= refreshThreshold;
    if (shouldRefresh) {
      refresh();
    } else {
      resetIndicator();
    }
  }, { passive: true });

  document.addEventListener("touchcancel", resetIndicator, { passive: true });
}

// -------------------------------------
// Wire up the settings view after it's rendered
// -------------------------------------
function setDataBackupStatus(message, isError = false) {
  const status = document.getElementById("data-backup-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error-text", isError);
}

function exportQuestifyData() {
  try {
    const exportedAt = new Date();
    const backup = {
      format: "questify-backup",
      version: 1,
      exportedAt: exportedAt.toISOString(),
      state,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `questify-backup-${exportedAt.toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDataBackupStatus("Backup downloaded.");
  } catch (error) {
    console.error("Could not export Questify data:", error);
    setDataBackupStatus("Questify couldn't create the backup. Please try again.", true);
  }
}

function getImportedQuestifyState(parsedData) {
  const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (!parsedData || typeof parsedData !== "object" || Array.isArray(parsedData)) {
    throw new Error("The selected file is not a Questify backup.");
  }
  if (parsedData.format === "questify-backup" && parsedData.version !== 1) {
    throw new Error("This Questify backup version is not supported.");
  }

  const importedState = parsedData.format === "questify-backup" ? parsedData.state : parsedData;
  if (!isRecord(importedState) || !isRecord(importedState.user) ||
      !Array.isArray(importedState.challenges) ||
      !importedState.challenges.every(isRecord)) {
    throw new Error("The selected file doesn't contain valid Questify data.");
  }
  if (importedState.user.name !== undefined && typeof importedState.user.name !== "string") {
    throw new Error("The backup contains an invalid profile name.");
  }
  if (importedState.preferences !== undefined && !isRecord(importedState.preferences)) {
    throw new Error("The backup contains invalid settings.");
  }
  for (const key of ["habits", "notes", "habitXpLedger", "notifications"]) {
    if (importedState[key] !== undefined &&
        (!Array.isArray(importedState[key]) || !importedState[key].every(isRecord))) {
      throw new Error(`The backup contains invalid ${key} data.`);
    }
  }
  if (importedState.unlockedBadgeIds !== undefined &&
      (!Array.isArray(importedState.unlockedBadgeIds) ||
       !importedState.unlockedBadgeIds.every((id) => typeof id === "string"))) {
    throw new Error("The backup contains invalid badge data.");
  }
  return importedState;
}

async function importQuestifyData(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    setDataBackupStatus("That file is too large to import (maximum 5 MB).", true);
    return;
  }

  try {
    const parsedData = JSON.parse(await file.text());
    const importedState = getImportedQuestifyState(parsedData);
    if (!window.confirm("Import this backup and replace the Questify data currently saved on this device? This cannot be undone.")) {
      setDataBackupStatus("Import cancelled. Your current data is unchanged.");
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(importedState));
    lockInStateChannel?.postMessage({ type: "state-updated" });
    setDataBackupStatus("Backup imported. Reloading Questify…");
    window.setTimeout(() => window.location.reload(), 300);
  } catch (error) {
    console.error("Could not import Questify data:", error);
    setDataBackupStatus(
      error instanceof SyntaxError
        ? "That file isn't valid JSON. Choose a Questify backup file and try again."
        : error instanceof Error
        ? error.name === "QuotaExceededError"
          ? "This backup is too large for the browser's available storage. Your current data is unchanged."
          : error.message
        : "Questify couldn't import that file. Your current data is unchanged.",
      true
    );
  }
}

function attachSettingsHandlers() {
  document.getElementById("export-data-btn")?.addEventListener("click", exportQuestifyData);

  const importDataButton = document.getElementById("import-data-btn");
  const importDataInput = document.getElementById("import-data-file");
  if (importDataButton && importDataInput) {
    importDataButton.addEventListener("click", () => importDataInput.click());
    importDataInput.addEventListener("change", async () => {
      await importQuestifyData(importDataInput.files?.[0]);
      importDataInput.value = "";
    });
  }

  document.querySelectorAll("[data-navigation-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.preferences.navigationMode = button.dataset.navigationMode;
      saveState();
      applyNavigationLayout();
      renderView();
    });
  });

  document.getElementById("replay-tour-btn")?.addEventListener("click", startProductTour);

  const installBtn = document.getElementById("install-app-btn");
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;

      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;

      // The prompt can only be used once - clear it either way
      deferredInstallPrompt = null;

      if (choice.outcome === "accepted") {
        showToast("Installing Questify...");
      }

      renderView(); // refresh the section (button removed, or shows installed state)
    });
  }

  const updateAppBtn = document.getElementById("update-app-btn");
  if (updateAppBtn) {
    updateAppBtn.addEventListener("click", () => updateApp(updateAppBtn));
  }

  document.querySelectorAll("[data-theme-choice]").forEach((themeButton) => {
    themeButton.addEventListener("click", () => setTheme(themeButton.dataset.themeChoice));
  });

  const goalInput = document.getElementById("daily-goal-input");
  if (goalInput) {
    goalInput.addEventListener("change", () => {
      setDailyGoal(goalInput.value);
      renderView();
    });
  }

  const soundSwitch = document.getElementById("sound-switch");
  if (soundSwitch) {
    const toggleSound = () => {
      state.preferences.soundEnabled = !state.preferences.soundEnabled;
      saveState();
      if (state.preferences.soundEnabled) playTone(660, 0, 0.12);
      renderView();
    };
    soundSwitch.addEventListener("click", toggleSound);
    soundSwitch.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleSound();
      }
    });
  }

  const hapticsSwitch = document.getElementById("haptics-switch");
  if (hapticsSwitch) {
    const toggleHaptics = () => {
      state.preferences.hapticsEnabled = !state.preferences.hapticsEnabled;
      saveState();
      if (state.preferences.hapticsEnabled) vibrateDevice(30);
      renderView();
    };
    hapticsSwitch.addEventListener("click", toggleHaptics);
    hapticsSwitch.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleHaptics();
      }
    });
  }

  const remindersSwitch = document.getElementById("reminders-switch");
  if (remindersSwitch) {
    const toggleReminders = async () => {
      if (state.preferences.remindersEnabled) {
        disableReminders();
        renderView();
      } else {
        const granted = await enableReminders();
        renderView();
        if (granted) {
          showToast("Daily reminders enabled.");
        } else {
          const message = typeof Notification === "undefined"
            ? "Notifications aren't supported on this browser."
            : Notification.permission === "denied"
            ? "Notifications are blocked. Allow them for Questify in your browser settings."
            : "Reminders need browser notification permission to work.";
          showToast(message);
        }
      }
    };
    remindersSwitch.addEventListener("click", toggleReminders);
    remindersSwitch.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleReminders();
      }
    });
  }

  const blockNotificationsSwitch = document.getElementById("block-notifications-switch");
  if (blockNotificationsSwitch) {
    const toggleBlockNotifications = () => {
      setBlockNotificationsDuringLockIn(!state.preferences.blockNotificationsDuringLockIn);
      renderView();
    };
    blockNotificationsSwitch.addEventListener("click", toggleBlockNotifications);
    blockNotificationsSwitch.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleBlockNotifications();
      }
    });
  }

  const floatingTransparencySwitch = document.getElementById("floating-transparency-switch");
  if (floatingTransparencySwitch) {
    const toggleFloatingTransparency = () => {
      state.preferences.floatingWindowsTransparent = !state.preferences.floatingWindowsTransparent;
      saveState();
      lockInPictureInPictureWindow?.document.body.classList.toggle(
        "is-floating-transparent",
        state.preferences.floatingWindowsTransparent
      );
      sessionNotePictureInPictureWindow?.document.body.classList.toggle(
        "is-floating-transparent",
        state.preferences.floatingWindowsTransparent
      );
      savedNotePictureInPictureWindow?.document.body.classList.toggle(
        "is-floating-transparent",
        state.preferences.floatingWindowsTransparent
      );
      renderView();
    };
    floatingTransparencySwitch.addEventListener("click", toggleFloatingTransparency);
    floatingTransparencySwitch.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleFloatingTransparency();
      }
    });
  }

  const resetBtn = document.getElementById("reset-data-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      isConfirmingReset = true;
      renderView();
    });
  }

  const confirmResetBtn = document.getElementById("confirm-reset-btn");
  if (confirmResetBtn) {
    confirmResetBtn.addEventListener("click", () => {
      resetAllData();
    });
  }

  const cancelResetBtn = document.getElementById("cancel-reset-btn");
  if (cancelResetBtn) {
    cancelResetBtn.addEventListener("click", () => {
      isConfirmingReset = false;
      renderView();
    });
  }

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      logout();
    });
  }
}

// -------------------------------------
// Wire up the login form after it's rendered
// -------------------------------------
function attachLoginFormHandler() {
  const form = document.getElementById("login-form");
  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("login-name-input");
    const errorEl = document.getElementById("login-error");

    const result = validateText(input.value, {
      ...VALIDATION_RULES.userName,
      fieldName: "Name",
    });

    if (!result.isValid) {
      errorEl.textContent = result.errorMessage;
      input.classList.add("input-error");
      return;
    }

    errorEl.textContent = "";
    input.classList.remove("input-error");
    completeOnboarding(result.value);
    initNotifBell();
    tourStep = 0;
    if (state.user.hasSeenTour) {
      navigateTo("dashboard");
    } else {
      startProductTour();
    }
  });
}

function attachConsentHandler() {
  const form = document.getElementById("consent-form");
  if (!form) return;
  const checkboxes = [...form.querySelectorAll('input[type="checkbox"]')];
  const error = document.getElementById("consent-error");

  checkboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (!error.textContent) return;
      const missing = checkboxes.filter((item) => !item.checked);
      checkboxes.forEach((item) => {
        item.setAttribute("aria-invalid", String(!item.checked));
        item.closest(".consent-check")?.classList.toggle("is-invalid", !item.checked);
      });
      error.textContent = missing.length
        ? `Please agree to the ${missing.map((item) => item.name === "privacy" ? "Privacy Policy" : "Terms of Service").join(" and ")} to continue.`
        : "";
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const missing = checkboxes.filter((checkbox) => !checkbox.checked);
    checkboxes.forEach((checkbox) => {
      checkbox.setAttribute("aria-invalid", String(!checkbox.checked));
      checkbox.closest(".consent-check")?.classList.toggle("is-invalid", !checkbox.checked);
    });
    if (missing.length) {
      error.textContent = `Please agree to the ${missing.map((checkbox) => checkbox.name === "privacy" ? "Privacy Policy" : "Terms of Service").join(" and ")} to continue.`;
      missing[0].focus();
      return;
    }
    error.textContent = "";
    acceptCurrentPolicies();
  });
}

function renderAppFloatingWidgets() {
  if (isLockInFocusWindow || isStickyNoteWindow) return "";
  const active = getActiveLockIn();
  const timerWidget = getFloatingWidget("timer");
  const noteWidget = getFloatingWidget("note");
  const timerHTML = timerWidget?.mode === "app" &&
      timerWidget.ownerId === appWindowId && active && timerWidget.id === active.id
    ? `
      <aside class="app-floating-widget app-floating-timer card" style="${getFloatingWidgetPositionStyle(timerWidget)}" aria-label="Pinned Lock In timer">
        <div class="app-floating-widget__header" data-floating-widget-drag-handle="timer">
          <span class="dashboard-section__eyebrow">QUESTIFY FOCUS</span>
          <button type="button" class="app-floating-widget__close" data-floating-widget-close="timer" aria-label="Unpin timer">×</button>
        </div>
        <strong class="app-floating-timer__title">${escapeHTML(active.title)}</strong>
        <span id="floating-lockin-timer-value" class="app-floating-timer__time"></span>
        <div class="app-floating-timer__actions">
          <button type="button" class="btn-secondary btn-sm" data-floating-timer-pause>${active.isPaused ? "Resume" : "Pause"}</button>
          <button type="button" class="btn-secondary btn-sm" data-floating-timer-add-time>+10 min</button>
        </div>
      </aside>
    `
    : "";
  let noteHTML = "";

  if (noteWidget?.mode === "app" && noteWidget.ownerId === appWindowId) {
    if (noteWidget.kind === "session" && active?.id === noteWidget.id) {
      const color = /^#[0-9a-f]{6}$/i.test(active.sessionNoteColor || "")
        ? active.sessionNoteColor
        : "#fff1a8";
      noteHTML = `
        <aside class="app-floating-widget app-floating-note card" style="--lockin-note-color:${color};--lockin-note-ink:${getLockInNoteInk(color)};${getFloatingWidgetPositionStyle(noteWidget)}" aria-label="Pinned Lock In note">
          <div class="app-floating-widget__header" data-floating-widget-drag-handle="note">
            <label for="floating-session-note-content">SESSION NOTE</label>
            <button type="button" class="app-floating-widget__close" data-floating-widget-close="note" aria-label="Unpin note">×</button>
          </div>
          <textarea id="floating-session-note-content" maxlength="500" placeholder="Keep your next thought here…">${escapeHTML(active.sessionNote || "")}</textarea>
          <span class="app-floating-widget__caption">Session only · saved automatically</span>
        </aside>
      `;
    } else if (noteWidget.kind === "saved") {
      const note = state.notes.find((item) => item.id === noteWidget.id);
      if (note) {
        const color = /^#[0-9a-f]{6}$/i.test(note.color || "") ? note.color : "#fff1a8";
        noteHTML = `
          <aside class="app-floating-widget app-floating-note card" style="--lockin-note-color:${color};--lockin-note-ink:${getLockInNoteInk(color)};${getFloatingWidgetPositionStyle(noteWidget)}" aria-label="Pinned sticky note">
              <div class="app-floating-widget__header" data-floating-widget-drag-handle="note">
              <label for="floating-saved-note-content">${escapeHTML(note.title || "STICKY NOTE")}</label>
              <button type="button" class="app-floating-widget__close" data-floating-widget-close="note" aria-label="Unpin note">×</button>
            </div>
            <textarea id="floating-saved-note-content" maxlength="2000" placeholder="Write a thought…">${escapeHTML(note.content || "")}</textarea>
            <span class="app-floating-widget__caption">Saved note · edits sync automatically</span>
          </aside>
        `;
      }
    }
  }
  return `${timerHTML}${noteHTML}`;
}

function getFloatingWidgetPositionStyle(widget) {
  if (!Number.isFinite(widget?.left) || !Number.isFinite(widget?.top)) return "";
  const widgetWidth = Math.min(310, window.innerWidth - 16);
  const left = Math.max(8, Math.min(window.innerWidth - widgetWidth - 8, widget.left));
  const top = Math.max(8, Math.min(window.innerHeight - 80, widget.top));
  return `left:${left}px;top:${top}px;right:auto;bottom:auto;`;
}

function preventFloatingWidgetOverlap(movingKind) {
  const otherKind = movingKind === "timer" ? "note" : "timer";
  const moving = document.querySelector(`.app-floating-${movingKind}`);
  const other = document.querySelector(`.app-floating-${otherKind}`);
  const storedOther = getFloatingWidget(otherKind);
  if (!moving || !other || storedOther?.ownerId !== appWindowId) return;

  const getWidgetBounds = (widget) => ({
    left: widget.offsetLeft,
    top: widget.offsetTop,
    right: widget.offsetLeft + widget.offsetWidth,
    bottom: widget.offsetTop + widget.offsetHeight,
    width: widget.offsetWidth,
    height: widget.offsetHeight,
  });
  const movingRect = getWidgetBounds(moving);
  const otherRect = getWidgetBounds(other);
  const overlaps = (a, b) => a.left < b.right && a.right > b.left &&
    a.top < b.bottom && a.bottom > b.top;
  if (!overlaps(movingRect, otherRect)) return;

  const margin = 10;
  const candidates = [
    { left: movingRect.left, top: movingRect.top - otherRect.height - margin },
    { left: movingRect.left, top: movingRect.bottom + margin },
    { left: movingRect.left - otherRect.width - margin, top: movingRect.top },
    { left: movingRect.right + margin, top: movingRect.top },
    { left: 8, top: 8 },
    { left: window.innerWidth - otherRect.width - 8, top: 8 },
    { left: 8, top: window.innerHeight - otherRect.height - 8 },
    { left: window.innerWidth - otherRect.width - 8, top: window.innerHeight - otherRect.height - 8 },
  ].filter((candidate) =>
    candidate.left >= 8 && candidate.top >= 8 &&
    candidate.left + otherRect.width <= window.innerWidth - 8 &&
    candidate.top + otherRect.height <= window.innerHeight - 8 &&
    !overlaps(movingRect, {
      left: candidate.left,
      top: candidate.top,
      right: candidate.left + otherRect.width,
      bottom: candidate.top + otherRect.height,
    })
  );
  if (!candidates.length) return;
  candidates.sort((a, b) =>
    Math.hypot(a.left - otherRect.left, a.top - otherRect.top) -
    Math.hypot(b.left - otherRect.left, b.top - otherRect.top)
  );
  const position = candidates[0];
  other.style.left = `${position.left}px`;
  other.style.top = `${position.top}px`;
  other.style.right = "auto";
  other.style.bottom = "auto";
  setFloatingWidget(otherKind, { ...storedOther, left: position.left, top: position.top });
}

function constrainAppFloatingWidgets() {
  ["timer", "note"].forEach((kind) => {
    const stored = getFloatingWidget(kind);
    if (stored?.ownerId !== appWindowId || stored.mode !== "app") return;
    const widget = document.querySelector(`.app-floating-${kind}`);
    if (!widget) return;
    const width = widget.offsetWidth;
    const height = widget.offsetHeight;
    const currentLeft = widget.offsetLeft;
    const currentTop = widget.offsetTop;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, currentLeft));
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, currentTop));
    if (Math.abs(left - currentLeft) < 1 && Math.abs(top - currentTop) < 1) return;
    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
    widget.style.right = "auto";
    widget.style.bottom = "auto";
    setFloatingWidget(kind, { ...stored, left, top });
  });
  preventFloatingWidgetOverlap("timer");
}

window.addEventListener("resize", constrainAppFloatingWidgets);

function attachAppFloatingWidgetHandlers() {
  document.querySelectorAll("[data-floating-widget-close]").forEach((button) => {
    button.addEventListener("click", () => {
      setFloatingWidget(button.dataset.floatingWidgetClose, null);
      renderView();
    });
  });

  const pauseButton = document.querySelector("[data-floating-timer-pause]");
  if (pauseButton) {
    pauseButton.addEventListener("click", () => {
      const active = getActiveLockIn();
      if (!active) return;
      active.isPaused ? resumeLockIn(active.id) : pauseLockIn(active.id);
      renderView();
    });
  }

  document.querySelector("[data-floating-timer-add-time]")?.addEventListener("click", () => {
    const active = getActiveLockIn();
    if (!active) return;
    addLockInTime(active.id, 10);
    renderView();
  });

  const sessionNoteInput = document.getElementById("floating-session-note-content");
  if (sessionNoteInput) {
    sessionNoteInput.addEventListener("input", () => {
      const active = getActiveLockIn();
      if (!active) return;
      active.sessionNote = sessionNoteInput.value.slice(0, 500);
      saveState();
      syncSessionNoteInput();
      syncSessionNotePictureInPicture();
    });
  }

  const savedNoteInput = document.getElementById("floating-saved-note-content");
  if (savedNoteInput) {
    savedNoteInput.addEventListener("input", () => {
      const noteWidget = getFloatingWidget("note");
      const note = noteWidget?.kind === "saved"
        ? state.notes.find((item) => item.id === noteWidget.id)
        : null;
      if (!note) return;
      note.content = savedNoteInput.value.slice(0, 2000);
      note.updatedAt = new Date().toISOString();
      saveState();
      syncStickyNotePopupEditor(note);
      syncSavedNotePictureInPicture();
    });
  }

  document.querySelectorAll("[data-floating-widget-drag-handle]").forEach((handle) => {
    const widget = handle.closest(".app-floating-widget");
    if (!widget) return;
    let pointerOffsetX = 0;
    let pointerOffsetY = 0;
    let position = null;
    const moveWidget = (event) => {
      if (!position) return;
      const maxLeft = Math.max(8, window.innerWidth - widget.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - Math.min(widget.offsetHeight, window.innerHeight - 16) - 8);
      position.left = Math.max(8, Math.min(maxLeft, event.clientX - pointerOffsetX));
      position.top = Math.max(8, Math.min(maxTop, event.clientY - pointerOffsetY));
      widget.style.left = `${position.left}px`;
      widget.style.top = `${position.top}px`;
      widget.style.right = "auto";
      widget.style.bottom = "auto";
    };
    const stopMoving = () => {
      if (!position) return;
      handle.removeEventListener("pointermove", moveWidget);
      handle.removeEventListener("pointerup", stopMoving);
      handle.removeEventListener("pointercancel", stopMoving);
      handle.classList.remove("is-dragging");
      try {
        handle.releasePointerCapture(position.pointerId);
      } catch (error) {
        if (error.name !== "NotFoundError") console.error("Could not release floating widget pointer:", error);
      }
      const kind = handle.dataset.floatingWidgetDragHandle;
      const stored = getFloatingWidget(kind);
      if (stored?.ownerId === appWindowId) {
        setFloatingWidget(kind, { ...stored, left: position.left, top: position.top });
        preventFloatingWidgetOverlap(kind);
      }
      position = null;
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button, input, textarea, select")) return;
      const rect = widget.getBoundingClientRect();
      position = {
        pointerId: event.pointerId,
        left: rect.left,
        top: rect.top,
      };
      pointerOffsetX = event.clientX - rect.left;
      pointerOffsetY = event.clientY - rect.top;
      handle.classList.add("is-dragging");
      handle.setPointerCapture(event.pointerId);
      handle.addEventListener("pointermove", moveWidget);
      handle.addEventListener("pointerup", stopMoving);
      handle.addEventListener("pointercancel", stopMoving);
      event.preventDefault();
    });
  });
}

// -------------------------------------
// Render the current view into <main>
// -------------------------------------
function renderView() {
  if (!isCurrentPolicyAccepted() && currentView !== "consent") {
    currentView = "consent";
  } else if (!isOnboarded() && !["consent", "login"].includes(currentView)) {
    currentView = "login";
  }

  if (isStickyNoteWindow && !["consent", "login"].includes(currentView)) {
    document.body.classList.add("is-sticky-note-window");
    const note = state.notes.find((item) => item.id === stickyNoteWindowId);
    document.title = `${note?.title || "Sticky Note"} — Questify`;
    mainEl.innerHTML = renderStickyNotePopup();
    attachStickyNotePopupHandlers();
    return;
  }
  document.body.classList.remove("is-sticky-note-window");

  if (isLockInTimerWindow && !["consent", "login"].includes(currentView)) {
    document.body.classList.add("is-lockin-timer-window");
    const active = getActiveLockIn();
    document.title = `${active?.title || "Lock In Timer"} — Questify`;
    mainEl.innerHTML = renderLockInTimerPopup();
    attachChallengesHandlers();
    if (active && !lockInIntervalId) startLockInTicker();
    return;
  }
  document.body.classList.remove("is-lockin-timer-window");

  if (isSessionNoteWindow && !["consent", "login"].includes(currentView)) {
    document.body.classList.add("is-session-note-window");
    const active = getActiveLockIn();
    document.title = `${active?.id === sessionNoteWindowId ? active.title : "Session Note"} — Questify`;
    mainEl.innerHTML = active?.id === sessionNoteWindowId
      ? `<section class="session-note-window">${renderLockInStickyNote()}</section>`
      : `<section class="session-note-window"><h1>Session note unavailable</h1><p class="text-muted">This Lock In session has ended.</p><button type="button" class="btn-secondary" data-session-note-window-close>Close window</button></section>`;
    attachChallengesHandlers();
    return;
  }
  document.body.classList.remove("is-session-note-window");

  if (isLockInFocusWindow && !["consent", "login"].includes(currentView)) {
    document.body.classList.add("is-lockin-focus-window");
    mainEl.innerHTML = `${renderLockInFocusWindow()}${renderLockInExitDialog()}`;
    attachLockInExitDialogHandlers();
    attachChallengesHandlers();
    if (getActiveLockIn() && !lockInIntervalId) startLockInTicker();
    return;
  }
  document.body.classList.remove("is-lockin-focus-window");

  const renderFn = views[currentView];

  if (!renderFn) {
    console.error(`No view registered for "${currentView}"`);
    mainEl.innerHTML = `<h2>Page not found</h2>`;
    return;
  }

  mainEl.innerHTML = `${renderFn()}${renderLockInExitDialog()}${isTourActive ? renderTourOverlay() : ""}${renderAppFloatingWidgets()}`;
  constrainAppFloatingWidgets();
  attachAppFloatingWidgetHandlers();
  updateActiveNavButton();
  toggleHeaderVisibility();
  attachLockInExitDialogHandlers();

  if (currentView === "login") {
    attachLoginFormHandler();
  }

  if (currentView === "consent") {
    attachConsentHandler();
  }

  if (currentView === "profile") {
    attachProfileHandlers();
  }

  if (currentView === "challenges") {
    attachChallengesHandlers();
  }

  if (currentView === "lockin") {
    attachChallengesHandlers();
  }

  if (currentView === "dashboard") {
    attachDashboardHandlers();
    attachHabitHandlers();
  }

  if (currentView === "profile") {
    drawActivityChart("activity-chart");
  }

  if (currentView === "settings") {
    attachSettingsHandlers();
  }

  if (currentView === "calendar") {
    attachCalendarHandlers();
    attachHabitHandlers();
  }

  if (currentView === "habits") {
    attachHabitHandlers();
  }

  if (currentView === "notes") {
    attachStickyNotesHandlers();
  }

  if (getActiveLockIn() && !lockInIntervalId) startLockInTicker();

  if (isTourActive) {
    attachTourHandlers();
  }
}

// -------------------------------------
// Highlight the nav button matching currentView
// -------------------------------------
function updateActiveNavButton() {
  navButtons.forEach((btn) => {
    const isActive = btn.dataset.view === currentView;
    btn.classList.toggle("is-active", isActive);
    if (isActive) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  });
  const activeMoreView = ["challenges", "badges", "notes", "profile", "settings"].includes(currentView);
  const moreToggle = document.getElementById("nav-more-toggle");
  const nav = moreToggle?.closest(".app-nav");
  const secondaryNav = nav?.querySelector(".app-nav-secondary");
  secondaryNav?.classList.toggle(
    "is-expanded",
    activeMoreView || Boolean(nav?.classList.contains("is-more-open"))
  );
  if (moreToggle) {
    moreToggle.classList.toggle("is-active", activeMoreView);
    moreToggle.setAttribute("aria-current", activeMoreView ? "page" : "false");
  }
}

function applyNavigationLayout() {
  const requestedMode = ["sidebar", "bottom"].includes(state.preferences.navigationMode)
    ? state.preferences.navigationMode
    : "auto";
  const effectiveMode = requestedMode === "auto"
    ? (window.matchMedia("(min-width: 768px)").matches ? "sidebar" : "bottom")
    : requestedMode;
  const isMobileSidebar = effectiveMode === "sidebar" && window.matchMedia("(max-width: 767px)").matches;
  if (!isMobileSidebar) {
    isMobileNavigationOpen = false;
  }
  document.body.classList.toggle("nav-layout-sidebar", effectiveMode === "sidebar");
  document.body.classList.toggle("nav-layout-bottom", effectiveMode === "bottom");
  document.body.classList.toggle("is-nav-collapsed", effectiveMode === "sidebar" && !isMobileSidebar && isSidebarCollapsed);
  document.body.classList.toggle("is-mobile-nav-open", isMobileSidebar && isMobileNavigationOpen);
  const button = document.getElementById("sidebar-collapse-btn");
  if (button) {
    if (isMobileSidebar) {
      button.setAttribute("aria-expanded", String(isMobileNavigationOpen));
      button.setAttribute("aria-label", isMobileNavigationOpen ? "Close navigation" : "Open navigation");
      button.title = isMobileNavigationOpen ? "Close navigation" : "Open navigation";
      button.textContent = isMobileNavigationOpen ? "×" : "☰";
    } else {
      button.setAttribute("aria-expanded", String(!isSidebarCollapsed));
      button.setAttribute("aria-label", isSidebarCollapsed ? "Expand navigation" : "Collapse navigation");
      button.title = isSidebarCollapsed ? "Expand navigation" : "Collapse navigation";
      button.textContent = isSidebarCollapsed ? "›" : "‹";
    }
  }
}

// -------------------------------------
// Navigate to a new view, update URL, re-render
// -------------------------------------
function navigateTo(viewName, pushToHistory = true) {
  const destination = viewName === "stats" ? "profile" : viewName;
  if (!views[destination]) {
    console.error(`Cannot navigate: "${viewName}" is not a valid view.`);
    return;
  }
  if (isTourActive && destination !== tourTargetView) {
    isTourActive = false;
    clearTourPositioning();
  }

  document.querySelector(".app-nav")?.classList.remove("is-more-open");
  document.getElementById("nav-more-toggle")?.setAttribute("aria-expanded", "false");
  isMobileNavigationOpen = false;
  applyNavigationLayout();
  currentView = destination;
  isEditingName = false;
  searchQuery = "";
  statusFilter = "all";
  dueFilter = "all";
  isConfirmingReset = false;
  dayDetailDate = null;
  if (destination === "calendar" || destination === "habits") {
    calendarViewDate = new Date(); // always open Calendar on the current month
    weekViewDate = new Date(); // and the current week
    calendarSelectedDate = getTodayDateString();
    dayDetailDate = null;
    editingHabitId = null;
    confirmingHabitDeleteId = null;
  }

  if (pushToHistory) {
    history.pushState({ view: destination }, "", `${window.location.pathname}${window.location.search}`);
  }

  window.scrollTo(0, 0);
  renderView();
}

// -------------------------------------
// Wire up nav button clicks
// -------------------------------------
navButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    navigateTo(btn.dataset.view);
  });
});

const sidebarCollapseButton = document.getElementById("sidebar-collapse-btn");
if (sidebarCollapseButton) {
  sidebarCollapseButton.addEventListener("click", () => {
    if (document.body.classList.contains("nav-layout-sidebar") &&
        window.matchMedia("(max-width: 767px)").matches) {
      isMobileNavigationOpen = !isMobileNavigationOpen;
      applyNavigationLayout();
      return;
    }
    isSidebarCollapsed = !isSidebarCollapsed;
    state.preferences.sidebarCollapsed = isSidebarCollapsed;
    saveState();
    applyNavigationLayout();
  });
}

const navMoreToggle = document.getElementById("nav-more-toggle");
if (navMoreToggle) {
  navMoreToggle.addEventListener("click", () => {
    const nav = navMoreToggle.closest(".app-nav");
    const isOpen = nav?.classList.toggle("is-more-open") || false;
    navMoreToggle.setAttribute("aria-expanded", String(isOpen));
    updateActiveNavButton();
  });
}

document.addEventListener("click", (event) => {
  const nav = document.querySelector(".app-nav");
  const target = event.target instanceof Element ? event.target : null;
  if (document.body.classList.contains("is-mobile-nav-open") && !target?.closest(".app-header")) {
    isMobileNavigationOpen = false;
    applyNavigationLayout();
  }
  if (!nav || nav.contains(target) || !nav.classList.contains("is-more-open")) return;
  nav.classList.remove("is-more-open");
  navMoreToggle?.setAttribute("aria-expanded", "false");
  updateActiveNavButton();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("is-mobile-nav-open")) {
    isMobileNavigationOpen = false;
    applyNavigationLayout();
    sidebarCollapseButton?.focus();
  }
});

window.addEventListener("resize", () => {
  applyNavigationLayout();
});

// -------------------------------------
// Handle browser back/forward buttons
// -------------------------------------
window.addEventListener("popstate", (event) => {
  const viewFromState = event.state?.view;
  if (viewFromState) {
    navigateTo(viewFromState, false);
  }
});

// -------------------------------------
// Initial load
// -------------------------------------
function init() {
  initServiceWorkerUpdateNotifications();
  loadState();
  previouslyOnboarded = isOnboarded();
  isSidebarCollapsed = Boolean(state.preferences.sidebarCollapsed);
  applyNavigationLayout();
  applyTheme();

  if (!isCurrentPolicyAccepted()) {
    navigateTo("consent", false);
    console.log("Questify requires local acceptance of the current policy version.");
    return;
  }

  if (!isOnboarded()) {
    navigateTo("login", true);
    console.log("Questify app initialized. User not onboarded - showing login.");
    return;
  }

  if (isLockInFocusWindow) window.scrollTo(0, 0);
  if (!isLockInFocusWindow) {
    initNotifBell();
    checkDailyReminder();
  }

  const hashView = window.location.hash.replace("#", "");
  const startingView = getActiveLockIn()?.wasInterrupted
    ? "lockin"
    : isStickyNoteWindow
    ? "notes"
    : (hashView === "stats" ? "profile" : views[hashView] && hashView !== "tour" ? hashView : "dashboard");
  if (hashView) {
    history.replaceState({ view: startingView }, "", `${window.location.pathname}${window.location.search}`);
  }
  navigateTo(startingView, false);
  console.log("Questify app initialized.");
}

// -------------------------------------
// Global error boundary: catch unexpected startup failures
// -------------------------------------
function renderErrorBoundary(error) {
  console.error("Fatal error during app initialization:", error);
  appRoot.innerHTML = `
    <div class="error-boundary">
      <div class="error-boundary__card">
        <div class="error-boundary__icon">⚠️</div>
        <h2>Something went wrong</h2>
        <p class="text-muted">
          Questify couldn't start properly. This is usually caused by corrupted local data.
        </p>
        <button id="error-reset-btn" class="btn">Reset & Reload</button>
      </div>
    </div>
  `;

  const resetBtn = document.getElementById("error-reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      window.location.reload();
    });
  }
}

try {
  initPullToRefresh();
  init();
} catch (error) {
  renderErrorBoundary(error);
}