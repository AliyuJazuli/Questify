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
const navButtons = document.querySelectorAll(".app-nav__btn");

if (!appRoot || !mainEl) {
  console.error("Fatal: required app containers not found in HTML.");
}

// -------------------------------------
// State: single source of truth
// -------------------------------------
const STORAGE_KEY = "questify_state";

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
};

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
      dailyGoal: CONFIG.DEFAULT_DAILY_GOAL,
    },
    challenges: [],
    unlockedBadgeIds: [],
    notifications: [],
    preferences: {
      theme: "light",
      soundEnabled: true,
      hapticsEnabled: true,
      remindersEnabled: false,
      lastReminderDate: null,
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
      state = {
        ...defaultState,
        ...savedState,
        user: {
          ...defaultState.user,
          ...savedState.user,
        },
        preferences: {
          ...defaultState.preferences,
          ...savedState.preferences,
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
let lockInIntervalId = null; // ticks the active Lock In session's live timer
let dayDetailDate = null; // "YYYY-MM-DD" of the weekly-view day whose detail modal is open, or null

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

function logout() {
  state = getDefaultState();
  saveState();
  navigateTo("login");
}

function toggleHeaderVisibility() {
  const headerEl = document.getElementById("app-header");
  if (!headerEl) return;
  headerEl.classList.toggle("is-hidden", currentView === "login");
}

// -------------------------------------
// Theme
// -------------------------------------
function applyTheme() {
  const theme = state.preferences.theme;
  const activeTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", activeTheme);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    themeColorMeta.content = activeTheme === "light" ? "#f5f7fb" : "#0d1220";
  }
}

function toggleTheme() {
  state.preferences.theme = state.preferences.theme === "light" ? "dark" : "light";
  saveState();
  applyTheme();
  renderView();
}

// -------------------------------------
// Reset all data
// -------------------------------------
function resetAllData() {
  const nameBackup = state.user.name;
  state = getDefaultState();
  state.user.name = nameBackup;
  state.user.isOnboarded = true;
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

function startLockIn(title, targetMinutes, difficulty = "medium") {
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
  const projectedXp = computeLockInXp(active.targetMinutes, Math.max(1, Math.round(elapsedSec / 60)), active.difficulty);

  if (overBy >= 0) {
    timeEl.textContent = `${formatLockInDuration(targetSec)} target + ${formatLockInDuration(overBy)} over`;
    if (statusEl) {
      statusEl.textContent = active.isPaused ? "⏸️ Paused (in overtime)" : "🔥 Overtime - keep going or finish anytime";
      statusEl.classList.toggle("is-overtime", !active.isPaused);
    }
    if (progressEl) progressEl.style.width = "100%";

    if (!active.notifiedAtTarget && !active.isPaused) {
      active.notifiedAtTarget = true;
      saveState();
      addNotification(`Lock In time's up for "${active.title}" - you can keep going!`, "⏰");
      triggerCompletionFeedback();
    }
  } else {
    timeEl.textContent = `${formatLockInDuration(elapsedSec)} / ${active.targetMinutes}m target`;
    if (statusEl) {
      statusEl.textContent = active.isPaused ? "⏸️ Paused" : "Locked in...";
      statusEl.classList.remove("is-overtime");
    }
    if (progressEl) progressEl.style.width = `${Math.min(100, (elapsedSec / targetSec) * 100)}%`;
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
    name: "New Look",
    description: "Switch to light theme",
    icon: "🌗",
    condition: (s) => s.preferences.theme === "light",
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
    condition: (s) => s.user.hasSeenTour === true,
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

// Returns a map of "YYYY-MM-DD" -> completion count, for challenges
// completed in the given year/month (0-indexed month, JS convention)
function getCompletionCountsForMonth(year, month) {
  const counts = {};

  getCompletedChallenges().forEach((c) => {
    const referenceDate = c.dateCompleted || c.dateCreated;
    const d = new Date(referenceDate);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const key = referenceDate.slice(0, 10);
      counts[key] = (counts[key] || 0) + 1;
    }
  });

  return counts;
}

// Builds the full grid of calendar cells for a given month, including
// the leading/trailing days from adjacent months needed to fill full weeks.
function getCalendarGridData(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const startDayOfWeek = firstOfMonth.getDay(); // 0 = Sunday

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const counts = getCompletionCountsForMonth(year, month);
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
    cells.push({
      day,
      inMonth: true,
      dateStr,
      count: counts[dateStr] || 0,
      isToday: dateStr === todayStr,
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

  const xpEarned = thisWeekCompletions.reduce((sum, c) => sum + c.xpValue, 0);

  // Find the day with the most completions this week
  const dayCounts = {};
  thisWeekCompletions.forEach((c) => {
    const referenceDate = c.dateCompleted || c.dateCreated;
    const key = referenceDate.slice(0, 10);
    dayCounts[key] = (dayCounts[key] || 0) + 1;
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
    completedCount: thisWeekCompletions.length,
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
  return getCompletedChallenges(s).filter((c) => (c.dateCompleted || c.dateCreated).slice(0, 10) === today)
    .length;
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
  if (typeof Notification === "undefined") {
    showToast("⚠️ Notifications aren't supported on this browser.");
    return false;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showToast("Reminders need notification permission to work.");
    return false;
  }

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
    const count = getCompletedChallenges().filter((c) => {
      const referenceDate = c.dateCompleted || c.dateCreated;
      return referenceDate.slice(0, 10) === dateStr;
    }).length;

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

      return `
        <div class="activity-strip__day ${isToday ? "is-today" : ""}" title="${dateLabel}: ${point.count} completed">
          <span class="activity-strip__weekday">${dayLabel}</span>
          <div class="activity-strip__cell intensity-${intensity}">${point.count > 0 ? point.count : ""}</div>
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

    days.push({
      dateStr,
      dayLabel: CALENDAR_WEEKDAY_LABELS[d.getDay()],
      dayNumber: d.getDate(),
      monthLabel: CALENDAR_MONTH_NAMES[d.getMonth()].slice(0, 3),
      isToday,
      completed: completedThatDay,
      active: activeThatDay,
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
        intensity > 0 ? `intensity-${intensity}` : "",
      ]
        .filter(Boolean)
        .join(" ");

      const title = cell.inMonth && cell.count > 0
        ? ` title="${cell.count} completed"`
        : "";

      return `<div class="${classes}"${title}>${cell.day}</div>`;
    })
    .join("");

  return `
    <div class="calendar-header">
      <button class="calendar-nav-btn" id="calendar-prev-btn" aria-label="Previous month">‹</button>
      <span class="calendar-month-label">${CALENDAR_MONTH_NAMES[month]} ${year}</span>
      <button class="calendar-nav-btn" id="calendar-next-btn" aria-label="Next month">›</button>
    </div>
    <div class="calendar-weekday-row">${weekdayRow}</div>
    <div class="calendar-grid">${dayCells}</div>
    <div class="calendar-legend">
      <span>Less</span>
      <span class="calendar-legend-swatch"></span>
      <span class="calendar-legend-swatch intensity-1"></span>
      <span class="calendar-legend-swatch intensity-2"></span>
      <span class="calendar-legend-swatch intensity-3"></span>
      <span class="calendar-legend-swatch intensity-4"></span>
      <span>More</span>
    </div>
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
    <div class="week-day-card ${day.isToday ? "is-today" : ""}" data-date="${day.dateStr}">
      <div class="week-day-header">
        <span class="week-day-label">${day.dayLabel}</span>
        <span class="week-day-number">${day.dayNumber}</span>
      </div>
      <div class="week-day-chips">
        ${activeChips}
        ${completedChips}
        ${isEmpty ? `<div class="week-day-empty text-muted">-</div>` : ""}
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
      </div>
      <div class="week-grid" id="week-grid">
        ${days.map(renderWeekDayCard).join("")}
      </div>
      <p class="week-view-hint text-muted">Tap any scheduled task to mark it complete, or tap a day for details.</p>
    </div>
  `;
}

// -------------------------------------
// Habit Calendar: "Today's Habits" - a bigger, always-visible daily
// breakdown sitting right under the weekly strip, so today's status is
// visible without needing to click into the day-detail modal.
// -------------------------------------
function renderTodayHabitsCard() {
  const todayStr = getTodayDateString();
  const { completed, active } = getDayDetail(todayStr);
  const totalXp = completed.reduce((sum, c) => sum + c.xpValue, 0);
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
    <div class="card today-habits-card" style="margin-top: var(--space-lg);">
      <h3 style="margin-top:0;">Today's Habits</h3>
      <div class="profile-stats" style="grid-template-columns: repeat(3, 1fr); margin-top: 0;">
        <div class="stat-card">
          <div class="stat-value">${state.user.streak}</div>
          <div class="stat-label text-muted">Streak</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${goalProgress.completed}/${goalProgress.goal}</div>
          <div class="stat-label text-muted">Daily Goal</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${totalXp}</div>
          <div class="stat-label text-muted">XP Today</div>
        </div>
      </div>
      ${taskListHTML}
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
  return { completed, active };
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

  const { completed, active } = getDayDetail(dayDetailDate);
  const totalXp = completed.reduce((sum, c) => sum + c.xpValue, 0);
  const d = new Date(`${dayDetailDate}T00:00:00`);
  const label = `${CALENDAR_MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  return `
    <div class="modal-overlay" id="day-detail-overlay">
      <div class="modal-card card" id="day-detail-card" role="dialog" aria-modal="true" aria-label="${label} challenge details">
        <div class="modal-header">
          <h3>${label}</h3>
          <button class="modal-close-btn" id="day-detail-close-btn" aria-label="Close">✕</button>
        </div>
        ${
          completed.length === 0 && active.length === 0
            ? `<p class="text-muted">No challenges for this day.</p>`
            : `
              ${
                completed.length > 0
                  ? `
                    <div class="day-detail-section">
                      <h4>Completed (${completed.length}) · ${totalXp} XP</h4>
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
          : `<div class="weekly-wins-best-day text-muted">Complete a challenge to start building this week's recap.</div>`
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
        <div class="lockin-progress-track">
          <div id="lockin-progress-fill" class="lockin-progress-fill" style="width: 0%;"></div>
        </div>
        <div id="lockin-timer" class="lockin-timer">0m / ${active.targetMinutes}m target</div>
        <div id="lockin-xp-preview" class="lockin-xp-preview text-muted">~0 XP so far</div>
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
        Choose a focus block. Questify will let you know when time is up, and you can keep going if you need to.
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
                  class="lockin-duration-option ${mins === 60 ? "is-selected" : ""}"
                  data-duration="${mins}"
                  aria-pressed="${mins === 60}"
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
          <input type="hidden" id="lockin-duration-select" value="60" />
          <label for="lockin-custom-minutes-input" class="sr-only">Custom duration in minutes</label>
          <input
            type="number"
            id="lockin-custom-minutes-input"
            class="lockin-custom-input is-hidden"
            placeholder="Enter minutes (1–240)"
            min="1"
            max="240"
          />
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
const TOUR_SLIDES = [
  {
    icon: "🎯",
    title: "Create daily challenges",
    body: "Add small goals for yourself - easy, medium, or hard - and pick when they're due. Make them repeat daily or weekly if it's a habit.",
  },
  {
    icon: "🔥",
    title: "Build your streak",
    body: "Complete a challenge every day to keep your streak alive, earn XP, and level up. Miss a day and it resets - so keep at it!",
  },
  {
    icon: "🏆",
    title: "Unlock badges",
    body: "Dozens of badges are waiting to be earned - for milestones, streaks, and more. Check your progress anytime in Badges and Stats.",
  },
];

function finishTour() {
  state.user.hasSeenTour = true;
  saveState();
  navigateTo("dashboard");
}

// -------------------------------------
// View registry
// -------------------------------------
const views = {
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
  tour: () => {
    const slide = TOUR_SLIDES[tourStep];
    const isLast = tourStep === TOUR_SLIDES.length - 1;

    return `
      <div class="login-screen">
        <div class="login-card card tour-card">
          <div class="tour-icon">${slide.icon}</div>
          <h2>${escapeHTML(slide.title)}</h2>
          <p class="text-muted">${escapeHTML(slide.body)}</p>
          <div class="tour-dots">
            ${TOUR_SLIDES.map((_, i) => `<span class="tour-dot ${i === tourStep ? "is-active" : ""}"></span>`).join("")}
          </div>
          <div class="tour-actions">
            <button id="tour-skip-btn" class="btn-secondary">Skip</button>
            <button id="tour-next-btn" class="btn">${isLast ? "Get Started" : "Next"}</button>
          </div>
        </div>
      </div>
    `;
  },
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
          ? `<p class="text-muted">No badges yet. Complete a challenge to earn your first one.</p>`
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
    <h2>Habit Calendar</h2>
    <p class="text-muted">See your completion activity at a glance, week by week and month by month.</p>

    ${renderWeeklyView()}

    ${renderTodayHabitsCard()}

    <div class="card" style="margin-top: var(--space-lg);">
      ${renderCalendarGrid()}
    </div>

    ${renderWeeklyWinsCard()}

    ${renderDayDetailModal()}
  `,
  stats: () => `
    <h2>Statistics</h2>
    <p class="text-muted">Your activity and progress over time.</p>

    <div class="stats-summary" style="margin-top: var(--space-lg);">
      <div class="card stat-card">
        <div class="stat-value">${state.user.xp}</div>
        <div class="stat-label text-muted">Total XP</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${
          state.challenges.length === 0
            ? "0%"
            : Math.round((getCompletedChallenges().length / state.challenges.length) * 100) + "%"
        }</div>
        <div class="stat-label text-muted">Completion Rate</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${state.unlockedBadgeIds.length} / ${BADGES.length}</div>
        <div class="stat-label text-muted">Badges</div>
      </div>
    </div>

    <div class="card chart-card">
      <h3>Last 7 Days Activity</h3>
      <canvas id="activity-chart"></canvas>
    </div>
  `,
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
  `,
  settings: () => `
    <h2>Settings</h2>

    ${renderInstallSection()}

    <div class="settings-section card">
      <div class="settings-row">
        <div>
          <div>Light Theme</div>
          <div class="text-muted">Switch between dark and light appearance</div>
        </div>
        <div
          id="theme-switch"
          class="theme-switch ${state.preferences.theme === "light" ? "is-on" : ""}"
          role="switch"
          aria-checked="${state.preferences.theme === "light"}"
          aria-label="Toggle light theme"
          tabindex="0"
        >
          <div class="theme-switch__knob"></div>
        </div>
      </div>
    </div>

    <div class="settings-section card">
      <div class="settings-row">
        <div>
          <div>Daily Goal</div>
          <div class="text-muted">How many challenges you want to complete each day</div>
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

    <div class="settings-section card">
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
          <div class="text-muted">Get a notification for challenges due today</div>
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
    </div>

    <div class="settings-section card">
      <div class="settings-row">
        <div>
          <div>Reset All Data</div>
          <div class="text-muted">Erases challenges, XP, badges, streak. Your name is kept.</div>
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
}

// -------------------------------------
// Wire up the calendar view after it's rendered
// -------------------------------------
function attachCalendarHandlers() {
  // Only attach once to prevent memory leaks
  if (attachedHandlers.calendar) return;
  attachedHandlers.calendar = true;

  const prevBtn = document.getElementById("calendar-prev-btn");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
      renderView();
    });
  }

  const nextBtn = document.getElementById("calendar-next-btn");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
      renderView();
    });
  }

  const weekPrevBtn = document.getElementById("week-prev-btn");
  if (weekPrevBtn) {
    weekPrevBtn.addEventListener("click", () => {
      weekViewDate.setDate(weekViewDate.getDate() - 7);
      renderView();
    });
  }

  const weekNextBtn = document.getElementById("week-next-btn");
  if (weekNextBtn) {
    weekNextBtn.addEventListener("click", () => {
      weekViewDate.setDate(weekViewDate.getDate() + 7);
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
        dayDetailDate = dayCard.dataset.date;
        renderView();
      }
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
  const lockinStartForm = document.getElementById("lockin-start-form");
  if (lockinStartForm) {
    lockinStartForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const titleInput = document.getElementById("lockin-title-input");
      const difficultySelect = document.getElementById("lockin-difficulty-select");
      const durationSelect = document.getElementById("lockin-duration-select");
      const customInput = document.getElementById("lockin-custom-minutes-input");
      const errorEl = document.getElementById("lockin-error");

      const isCustom = durationSelect.value === "custom";
      const minutesValue = isCustom ? customInput.value : durationSelect.value;

      if (isCustom && (!customInput.value || parseInt(customInput.value, 10) < 1)) {
        errorEl.textContent = "Enter a valid number of minutes.";
        return;
      }

      const result = startLockIn(titleInput.value, minutesValue, difficultySelect.value);
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
      lockinDurationOptions.querySelectorAll(".lockin-duration-option").forEach((button) => {
        const isSelected = button === option;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-pressed", String(isSelected));
      });

      const isCustom = lockinDurationSelect.value === "custom";
      lockinCustomInput.classList.toggle("is-hidden", !isCustom);
      if (isCustom) lockinCustomInput.focus();
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
  // Only attach once to prevent memory leaks
  if (attachedHandlers.profile) return;
  attachedHandlers.profile = true;

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

// -------------------------------------
// Wire up the settings view after it's rendered
// -------------------------------------
function attachSettingsHandlers() {
  // Only attach once to prevent memory leaks
  if (attachedHandlers.settings) return;
  attachedHandlers.settings = true;

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

  const themeSwitch = document.getElementById("theme-switch");
  if (themeSwitch) {
    themeSwitch.addEventListener("click", () => {
      toggleTheme();
    });

    themeSwitch.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTheme();
      }
    });
  }

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
        if (granted) showToast("Daily reminders enabled.");
        renderView();
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
// Wire up the onboarding tour after it's rendered
// -------------------------------------
function attachTourHandlers() {
  const nextBtn = document.getElementById("tour-next-btn");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (tourStep < TOUR_SLIDES.length - 1) {
        tourStep += 1;
        renderView();
      } else {
        finishTour();
      }
    });
  }

  const skipBtn = document.getElementById("tour-skip-btn");
  if (skipBtn) {
    skipBtn.addEventListener("click", () => {
      finishTour();
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
    navigateTo(state.user.hasSeenTour ? "dashboard" : "tour");
  });
}

// -------------------------------------
// Render the current view into <main>
// -------------------------------------
function renderView() {
  if (!isOnboarded() && currentView !== "login") {
    currentView = "login";
  }

  const renderFn = views[currentView];

  if (!renderFn) {
    console.error(`No view registered for "${currentView}"`);
    mainEl.innerHTML = `<h2>Page not found</h2>`;
    return;
  }

  mainEl.innerHTML = renderFn();
  updateActiveNavButton();
  toggleHeaderVisibility();

  if (currentView === "login") {
    attachLoginFormHandler();
  }

  if (currentView === "tour") {
    attachTourHandlers();
  }

  if (currentView === "profile") {
    attachProfileHandlers();
  }

  if (currentView === "challenges") {
    attachChallengesHandlers();
  }

  if (currentView === "dashboard") {
    attachDashboardHandlers();
  }

  if (currentView === "stats") {
    drawActivityChart("activity-chart");
  }

  if (currentView === "settings") {
    attachSettingsHandlers();
  }

  if (currentView === "calendar") {
    attachCalendarHandlers();
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
}

// -------------------------------------
// Navigate to a new view, update URL, re-render
// -------------------------------------
function navigateTo(viewName, pushToHistory = true) {
  if (!views[viewName]) {
    console.error(`Cannot navigate: "${viewName}" is not a valid view.`);
    return;
  }

  if (currentView === "challenges" && viewName !== "challenges") {
    stopLockInTicker();
  }

  currentView = viewName;
  isEditingName = false;
  searchQuery = "";
  statusFilter = "all";
  dueFilter = "all";
  isConfirmingReset = false;
  dayDetailDate = null;
  if (viewName === "calendar") {
    calendarViewDate = new Date(); // always open Calendar on the current month
    weekViewDate = new Date(); // and the current week
  }

  if (pushToHistory) {
    history.pushState({ view: viewName }, "", `#${viewName}`);
  }

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
  applyTheme();

  if (!isOnboarded()) {
    navigateTo("login", true);
    console.log("Questify app initialized. User not onboarded - showing login.");
    return;
  }

  initNotifBell();
  checkDailyReminder();

  const hashView = window.location.hash.replace("#", "");
  const startingView =
    views[hashView] && hashView !== "tour" ? hashView : "dashboard";
  navigateTo(startingView, true);
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
  init();
} catch (error) {
  renderErrorBoundary(error);
}