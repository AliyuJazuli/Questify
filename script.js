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

// -------------------------------------
// State: single source of truth
// -------------------------------------
const STORAGE_KEY = "questify_state";
const LEGAL_POLICY_VERSION = "1.0";

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
  { id: "ocean", name: "Ocean", description: "Crisp coastal glass", color: "#071b2c", swatches: ["#071b2c", "#38bdf8", "#0f6b8f"] },
  { id: "aurora", name: "Aurora", description: "Soft, airy sea glass", color: "#eaf5f2", swatches: ["#eaf5f2", "#62c7a6", "#176d65"] },
  { id: "forest", name: "Forest", description: "Quiet botanical editorial", color: "#edf4e9", swatches: ["#edf4e9", "#8dbb75", "#3f6b43"] },
  { id: "sunset", name: "Sunset", description: "Rounded, warm and playful", color: "#fff1e6", swatches: ["#fff1e6", "#fb8b68", "#a94e37"] },
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
      dailyGoal: CONFIG.DEFAULT_DAILY_GOAL,
    },
    challenges: [],
    habits: [],
    habitXpLedger: [],
    legalAcceptance: null,
    unlockedBadgeIds: [],
    notifications: [],
    preferences: {
      theme: "ocean",
      soundEnabled: true,
      hapticsEnabled: true,
      remindersEnabled: false,
      lastReminderDate: null,
      blockNotificationsDuringLockIn: false,
      lastLockInDuration: 60,
      sidebarCollapsed: false,
      navigationMode: "auto",
    },
  };
}

let state = getDefaultState();

// -------------------------------------
// Persistence: save/load from localStorage
// -------------------------------------
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
        },
        preferences: {
          ...defaultState.preferences,
          ...savedState.preferences,
          navigationMode: ["auto", "sidebar", "bottom"].includes(savedState.preferences?.navigationMode)
            ? savedState.preferences.navigationMode
            : "auto",
          lastLockInDuration: Math.min(240, Math.max(1, Number(savedState.preferences?.lastLockInDuration) || defaultState.preferences.lastLockInDuration)),
          theme: APP_THEMES.some((theme) => theme.id === migratedTheme)
            ? migratedTheme
            : defaultState.preferences.theme,
        },
      };
      console.log("Loaded existing state from localStorage.");
    } else {
      state = getDefaultState();
      console.log("No saved state found. Using default state.");
    }
  } catch (err) {
    console.error("Failed to load state, falling back to default:", err);
    state = getDefaultState();
  }
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
let tourStep = 0; // which onboarding tour slide is showing (0-2)
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
    : "ocean";
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

function getCategoryConfig(category) {
  return CATEGORY_CONFIG[category] || CATEGORY_CONFIG.general;
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

function addHabit(title, description = "", difficulty = "medium") {
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
    completedDates: [],
    xpAwardedDates: [],
    archived: false,
  });
  saveState();
  return { ok: true };
}

function editHabit(id, title, description, difficulty) {
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
  completeChallenge(id);
  stopLockInTicker();
}

function cancelLockIn(id) {
  deleteChallenge(id);
  stopLockInTicker();
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

  if (!active || !timeEl) {
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
    timeEl.textContent = overBy === 0
      ? "Focus block complete"
      : `${formatLockInClock(overBy)} overtime`;
    if (statusEl) {
      statusEl.textContent = active.isPaused ? "⏸️ Paused (in overtime)" : "🔥 Overtime - keep going or finish anytime";
      statusEl.classList.toggle("is-overtime", !active.isPaused);
      statusEl.classList.toggle("is-paused", active.isPaused);
    }
    if (progressEl) {
      progressEl.style.strokeDashoffset = "0";
      progressEl.closest("svg")?.setAttribute("aria-valuenow", "100");
    }

    if (!active.notifiedAtTarget && !active.isPaused) {
      active.notifiedAtTarget = true;
      saveState();
      addNotification(`Lock In time's up for "${active.title}" - you can keep going!`, "⏰");
      triggerCompletionFeedback();
    }
  } else {
    timeEl.textContent = `${formatLockInClock(remainingSec)} remaining`;
    if (statusEl) {
      statusEl.textContent = active.isPaused ? "⏸️ Paused" : "Locked in...";
      statusEl.classList.remove("is-overtime");
      statusEl.classList.toggle("is-paused", active.isPaused);
    }
    if (progressEl) {
      progressEl.style.strokeDashoffset = String(circumference * (1 - progressPercent / 100));
      progressEl.closest("svg")?.setAttribute("aria-valuenow", String(Math.round(progressPercent)));
    }
  }

  const xpEl = document.getElementById("lockin-xp-preview");
  if (xpEl) xpEl.textContent = `~${projectedXp} XP so far`;
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
        default:
          console.error(`Unknown Lock In exit action: "${button.dataset.lockinExitAction}"`);
      }
    });
  });

  dialog.querySelector("[data-lockin-exit-action='quit']")?.focus();
}

window.addEventListener("beforeunload", (event) => {
  const active = getActiveLockIn();
  if (!active || active.isPaused) return;

  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("pagehide", handleLockInPageHide);
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
  // ============= EASY (10) - quick wins that also introduce features =============
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
    description: "Complete challenges in 3 different categories",
    icon: "🧭",
    condition: (s) => {
      const counts = getCategoryCompletionCounts(s);
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

  // ============= HARD (50) - longer-run milestones and mastery goals =============

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
    description: "Complete an Easy, Medium, and Hard challenge",
    icon: "🎯",
    condition: (s) => {
      const counts = getCompletionCountByDifficulty(s);
      return counts.easy >= 1 && counts.medium >= 1 && counts.hard >= 1;
    },
  },
  {
    id: "easy-specialist",
    tier: "hard",
    name: "Easy Specialist",
    description: "Complete 10 Easy challenges",
    icon: "🍀",
    condition: (s) => getCompletionCountByDifficulty(s).easy >= 10,
  },
  {
    id: "medium-specialist",
    tier: "hard",
    name: "Medium Specialist",
    description: "Complete 10 Medium challenges",
    icon: "🎲",
    condition: (s) => getCompletionCountByDifficulty(s).medium >= 10,
  },
  {
    id: "hard-specialist",
    tier: "hard",
    name: "Hard Specialist",
    description: "Complete 10 Hard challenges",
    icon: "🥋",
    condition: (s) => getCompletionCountByDifficulty(s).hard >= 10,
  },
  {
    id: "hard-master",
    tier: "hard",
    name: "Hard Master",
    description: "Complete 25 Hard challenges",
    icon: "🐺",
    condition: (s) => getCompletionCountByDifficulty(s).hard >= 25,
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
    description: "Complete at least 3 challenges in every category",
    icon: "🎨",
    condition: (s) => {
      const counts = getCategoryCompletionCounts(s);
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
  if (state.preferences.blockNotificationsDuringLockIn && getActiveLockIn()) return;

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
  attachedHandlers.notifBell = true;

  const bellBtn = document.getElementById("notif-bell-btn");
  const panel = document.getElementById("notif-panel");
  const clearBtn = document.getElementById("notif-clear-btn");
  const listEl = document.getElementById("notif-list");

  if (!bellBtn || !panel || !clearBtn || !listEl) return;

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
    .filter((c) => !isRunningLockIn(c))
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
  if (state.preferences.blockNotificationsDuringLockIn && getActiveLockIn()) return;

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
  if (state.preferences.blockNotificationsDuringLockIn && getActiveLockIn()) return;
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
function renderFirstTimeWelcomeCard() {
  const hasChallenges = state.challenges.length > 0;
  if (hasChallenges) return "";

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

function renderDashboardHabitSummary() {
  const habits = getActiveHabits();
  const today = getTodayDateString();
  const completed = getHabitCompletionsForDate(today).length;
  const percent = habits.length ? Math.round((completed / habits.length) * 100) : 0;

  if (!habits.length) {
    return `
      <section class="card dashboard-habit-summary dashboard-habit-summary--empty">
        <div>
          <p class="dashboard-section__eyebrow">BUILD YOUR ROUTINE</p>
          <h3>Make space for your daily habits</h3>
          <p class="text-muted">Track the small rituals that help you feel your best, one day at a time.</p>
        </div>
        <button class="btn" type="button" data-navigate="habits">Set up habits</button>
      </section>
    `;
  }

  return `
    <section class="card dashboard-habit-summary" aria-labelledby="dashboard-habits-title">
      <div class="dashboard-habit-summary__heading">
        <div>
          <p class="dashboard-section__eyebrow">SHOW UP FOR YOURSELF</p>
          <h3 id="dashboard-habits-title">Your habits today</h3>
        </div>
        <div class="dashboard-habit-summary__progress">
          <strong>${completed}<span>/${habits.length}</span></strong>
          <span class="text-muted">complete</span>
        </div>
      </div>
      <div class="habit-week-progress__track" aria-label="${percent}% of today's habits complete">
        <span style="width:${percent}%"></span>
      </div>
      <div class="habit-daily-list dashboard-habit-summary__list">
        ${habits.slice(0, 4).map((habit) => renderHabitDailyRow(habit, today)).join("")}
      </div>
      <div class="dashboard-habit-summary__footer">
        ${habits.length > 4 ? `<span class="text-muted">and ${habits.length - 4} more</span>` : ""}
        <button class="btn-secondary btn-sm" type="button" data-navigate="habits">View all habits</button>
      </div>
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

function renderCalendarDayDetails(dateStr) {
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
    <section class="card calendar-day-details" aria-labelledby="calendar-day-title">
      <div class="calendar-day-details__header">
        <div>
          <p class="dashboard-section__eyebrow">DAILY REVIEW</p>
          <h3 id="calendar-day-title">${escapeHTML(label)}</h3>
          <p class="text-muted">${escapeHTML(status)}</p>
        </div>
        ${calendarViewMode === "day" ? `
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
    <div class="week-day-card ${day.isToday ? "is-today" : ""} ${day.dateStr === calendarSelectedDate ? "is-selected" : ""}" data-date="${day.dateStr}" role="button" tabindex="0" aria-pressed="${day.dateStr === calendarSelectedDate}" aria-label="${day.dayLabel}, ${day.monthLabel} ${day.dayNumber}: ${day.habits.length} of ${day.habitTotal} habits, ${day.completed.length} challenges, ${day.xp} XP">
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
      <span class="habit-daily-row__title">${escapeHTML(habit.title)}</span>
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
          <p class="text-muted">Edit names, descriptions, and difficulty without losing check-in history. A check-in earns XP once per habit per date.</p>
        </div>
      </div>
      <form id="add-habit-form" class="add-habit-form" novalidate>
        <label class="sr-only" for="add-habit-input">New daily habit</label>
        <input id="add-habit-input" name="title" type="text" maxlength="50" placeholder="e.g. Read for 10 minutes" autocomplete="off" required>
        <label class="sr-only" for="add-habit-description">Habit description</label>
        <input id="add-habit-description" name="description" type="text" maxlength="180" placeholder="Description (optional)">
        <label class="sr-only" for="add-habit-difficulty">Habit difficulty</label>
        <select id="add-habit-difficulty" name="difficulty">${difficultyOptions("medium")}</select>
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
                  <th scope="col" class="${day.isToday ? "is-today" : ""}">
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
                  </th>
                  ${days.map((day) => `
                    <td class="${day.isToday ? "is-today" : ""}">
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
          <h3 id="habit-delete-title">Delete this habit?</h3>
          <p class="text-muted">This permanently removes the habit and its check-in history. Previously earned XP and levels will not be taken away.</p>
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
function renderLockInPanel() {
  const active = getActiveLockIn();

  if (active) {
    return `
      <div class="card lockin-panel lockin-panel--active" id="lockin-panel">
        <div class="lockin-panel__header">
          <span class="lockin-panel__badge">🔒 Lock In</span>
          <span id="lockin-status" class="lockin-status">Locked in...</span>
        </div>
        <h3 class="lockin-panel__title">${escapeHTML(active.title)}</h3>
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
            <span class="text-muted">Mute Questify toasts, its notification log, and browser reminders. Other apps and OS alerts are unchanged.</span>
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
      </div>
    `;
  }

  return `
    <div class="card lockin-panel" id="lockin-panel">
      <div class="lockin-panel__header">
        <span class="lockin-panel__badge">🔒 Lock In</span>
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
            <span><strong>Mute Questify notifications</strong><small>Suppresses Questify toasts, its notification log, and browser reminders for this session only.</small></span>
          </label>
          <details class="focus-os-guidance">
            <summary>Silence notifications from other apps</summary>
            <p>Questify is a web app and cannot change phone-wide notification settings. Use your device's native mode: Android — open Quick Settings and turn on Do Not Disturb/Focus; iPhone — open Control Center, tap Focus, and choose a mode.</p>
          </details>
        </div>
        <button type="submit" class="btn lockin-start-form__submit">Start focus session</button>
      </form>
      <p class="error-text" id="lockin-error"></p>
    </div>
  `;
}

// -------------------------------------
// Challenges: render a single card
// -------------------------------------
function renderChallengeCard(challenge) {
  const difficulty = challenge.difficulty || "easy";
  const difficultyLabel = getDifficultyConfig(difficulty).label;
  const category = getCategoryConfig(challenge.category || "general");
  const scheduledDate = getChallengeScheduledDate(challenge);
  const dateLabel = formatScheduledDateLabel(scheduledDate);
  const urgency = challenge.completed ? null : getUrgencyStatus(challenge);
  const recurrence = challenge.recurrence || "none";

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
    <div class="card challenge-card ${challenge.completed ? "is-completed" : ""} ${challenge.archived ? "is-archived" : ""}" data-id="${challenge.id}">
      <div class="challenge-card__info">
        <span class="challenge-card__title">${escapeHTML(challenge.title)}</span>
        <span class="challenge-card__xp">+${challenge.xpValue} XP</span>
        <span class="difficulty-tag difficulty-${difficulty}">${difficultyLabel}</span>
        <span class="category-tag" title="${category.label}">${category.icon} ${category.label}</span>
        ${recurrenceTag}
        ${urgencyTag}
        ${
          challenge.isLockIn
            ? `<span class="challenge-card__date">⏱️ ${
                challenge.actualMinutes ? `Locked in ${challenge.actualMinutes}m` : `Target ${challenge.targetMinutes}m`
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
    selector: ".dashboard-hero",
    title: "Your day, at a glance",
    body: "The dashboard brings today's progress, priorities, and momentum together. Start here to decide on your next small win.",
  },
  {
    view: "dashboard",
    selector: ".dashboard-level-chip",
    title: "Progress that builds",
    body: "Challenges and habit check-ins earn XP. Your level and progress are always visible here.",
  },
  {
    view: "habits",
    selector: ".habit-manager-card",
    title: "Make habits measurable",
    body: "Create daily habits, choose their difficulty, and check in once per day. Editing keeps your history.",
  },
  {
    view: "habits",
    selector: ".habit-analytics-card",
    title: "See your consistency",
    body: "Daily, weekly, and monthly views summarize real check-ins, streaks, and missed habits.",
  },
  {
    view: "calendar",
    selector: ".calendar-view-heading",
    title: "Review your history",
    body: "The calendar brings habit activity, challenge completions, streaks, and earned XP into one timeline.",
  },
  {
    view: "badges",
    selector: ".badge-progress-summary",
    title: "Celebrate milestones",
    body: "Badges recognize progress and consistency. Your earned badges and next milestones live here.",
  },
  {
    view: "challenges",
    selector: ".lockin-panel",
    title: "Choose a focus block",
    body: "Locked-In sessions offer a timer and optional suppression of Questify's own notifications. System-wide silence must be enabled in your device's Focus or Do Not Disturb settings.",
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
        <span>QUESTIFY QUICK TOUR</span>
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
  if (!target || !bubble) return;
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

// -------------------------------------
// View registry
// -------------------------------------
const views = {
  consent: () => `
    <section class="consent-screen" aria-labelledby="consent-title">
      <div class="consent-card card">
        <img src="logo.svg" alt="Questify" class="consent-logo" width="64" height="64">
        <p class="dashboard-section__eyebrow">WELCOME TO QUESTIFY</p>
        <h1 id="consent-title">A thoughtful start</h1>
        <p class="text-muted">Before continuing, please review how Questify works and the terms for using this app. Your progress stays on this device.</p>
        <div class="consent-document-links">
          <a class="consent-document-link" href="privacy.html" target="_blank" rel="noopener">
            <span><strong>Privacy Policy</strong><small>Local data, notifications, and your choices</small></span><span aria-hidden="true">↗</span>
          </a>
          <a class="consent-document-link" href="terms.html" target="_blank" rel="noopener">
            <span><strong>Terms of Service</strong><small>What Questify does and what to expect</small></span><span aria-hidden="true">↗</span>
          </a>
        </div>
        <form id="consent-form">
          <label class="consent-check"><input type="checkbox" name="privacy" required><span>I have read and agree to the <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
          <label class="consent-check"><input type="checkbox" name="terms" required><span>I have read and agree to the <a href="terms.html" target="_blank" rel="noopener">Terms of Service</a>.</span></label>
          <p class="error-text" id="consent-error" role="status"></p>
          <button type="submit" class="btn">Agree and continue</button>
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

    ${renderDashboardLockInCta()}

    ${renderFirstTimeWelcomeCard()}
    ${renderResumeLockInBanner()}
    ${renderDashboardHabitSummary()}

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

    ${renderLockInPanel()}

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

        if (state.challenges.length === 0) {
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
      <p class="text-muted">Unlock badges by completing challenges and building streaks.</p>
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
          <div class="text-muted">Download the latest version of the app when you're online.</div>
        </div>
        <button id="update-app-btn" class="btn btn-sm" type="button">Update app</button>
      </div>
    </div>

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
        <p class="text-muted">Take a guided tour of the dashboard, habits, analytics, calendar, badges, and focus timer.</p>
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
      navigateTo("challenges");
    });
  }

  const startLockInBtn = document.getElementById("dashboard-lockin-btn");
  if (startLockInBtn) {
    startLockInBtn.addEventListener("click", () => {
      navigateTo("challenges");
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
      const error = document.getElementById("add-habit-error");
      const result = addHabit(input.value, descriptionInput.value, difficultyInput.value);
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
        String(formData.get("difficulty") || "medium")
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

async function prepareAppUpdate(requireServiceWorker = true) {
  if (!navigator.onLine) throw new Error("An internet connection is required to update Questify.");
  if (!("serviceWorker" in navigator)) {
    if (requireServiceWorker) throw new Error("Service workers are not supported in this browser.");
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    if (requireServiceWorker) throw new Error("No installed Questify app was found to update.");
    return;
  }

  await registration.update();
  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith("questify-cache-"))
        .map((name) => caches.delete(name))
    );
  }
}

async function updateApp(button) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Checking…";

  try {
    await prepareAppUpdate();
    window.location.reload();
  } catch (error) {
    console.error("Failed to update Questify:", error);
    button.disabled = false;
    button.textContent = originalLabel;
    showToast(`⚠️ ${escapeHTML(error.message || "Questify couldn't check for updates.")}`);
  }
}

function initPullToRefresh() {
  const indicator = document.getElementById("pull-refresh-indicator");
  const label = document.getElementById("pull-refresh-label");
  if (!indicator || !label) return;

  const refreshThreshold = 68;
  let startY = null;
  let pullDistance = 0;
  let isRefreshing = false;

  const canStartPull = (target, y) => (
    !isRefreshing &&
    window.scrollY <= 0 &&
    y <= 72 &&
    !target.closest("button, a, input, textarea, select, [contenteditable='true']")
  );

  const updateIndicator = (distance) => {
    pullDistance = Math.min(92, Math.max(0, (distance - 5) * 0.58));
    indicator.style.setProperty("--pull-distance", `${pullDistance}px`);
    indicator.classList.add("is-pulling");
    indicator.classList.toggle("is-ready", pullDistance >= refreshThreshold);
    indicator.setAttribute("aria-hidden", "false");
    label.textContent = pullDistance >= refreshThreshold ? "Release to refresh" : "Pull to refresh";
  };

  const resetIndicator = () => {
    indicator.classList.remove("is-pulling", "is-ready", "is-refreshing");
    indicator.style.removeProperty("--pull-distance");
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
    label.textContent = "Refreshing Questify";
    indicator.setAttribute("aria-hidden", "false");

    try {
      if (navigator.onLine) await prepareAppUpdate(false);
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
    if (!canStartPull(event.target, event.touches[0].clientY)) return;
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
function attachSettingsHandlers() {
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
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.querySelector('[name="privacy"]').checked || !form.querySelector('[name="terms"]').checked) {
      document.getElementById("consent-error").textContent = "Please agree to both documents to continue.";
      return;
    }
    acceptCurrentPolicies();
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

  const renderFn = views[currentView];

  if (!renderFn) {
    console.error(`No view registered for "${currentView}"`);
    mainEl.innerHTML = `<h2>Page not found</h2>`;
    return;
  }

  mainEl.innerHTML = `${renderFn()}${renderLockInExitDialog()}${isTourActive ? renderTourOverlay() : ""}`;
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
  const activeMoreView = ["badges", "profile", "settings"].includes(currentView);
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
  document.body.classList.toggle("nav-layout-sidebar", effectiveMode === "sidebar");
  document.body.classList.toggle("nav-layout-bottom", effectiveMode === "bottom");
  document.body.classList.toggle("is-nav-collapsed", effectiveMode === "sidebar" && isSidebarCollapsed);
  const button = document.getElementById("sidebar-collapse-btn");
  if (button) {
    button.setAttribute("aria-expanded", String(!isSidebarCollapsed));
    button.setAttribute("aria-label", isSidebarCollapsed ? "Expand navigation" : "Collapse navigation");
    button.title = isSidebarCollapsed ? "Expand navigation" : "Collapse navigation";
    button.textContent = isSidebarCollapsed ? "›" : "‹";
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

  if (currentView === "challenges" && destination !== "challenges") {
    stopLockInTicker();
  }

  document.querySelector(".app-nav")?.classList.remove("is-more-open");
  document.getElementById("nav-more-toggle")?.setAttribute("aria-expanded", "false");
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
  if (!nav || nav.contains(event.target) || !nav.classList.contains("is-more-open")) return;
  nav.classList.remove("is-more-open");
  navMoreToggle?.setAttribute("aria-expanded", "false");
  updateActiveNavButton();
});

window.addEventListener("resize", applyNavigationLayout);

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

  initNotifBell();
  checkDailyReminder();

  const hashView = window.location.hash.replace("#", "");
  const startingView = getActiveLockIn()?.wasInterrupted
    ? "challenges"
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