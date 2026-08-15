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
  DEFAULT_WEEKLY_GOAL: 5,
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
      weeklyGoal: CONFIG.DEFAULT_WEEKLY_GOAL,
    },
    challenges: [],
    unlockedBadgeIds: [],
    notifications: [],
    preferences: {
      theme: "dark",
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
      state = {
        ...getDefaultState(),
        ...savedState,
        user: {
          ...getDefaultState().user,
          ...savedState.user,
        },
        preferences: {
          ...getDefaultState().preferences,
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
let isConfirmingReset = false;
let tourStep = 0; // which onboarding tour slide is showing (0-2)
let lockInIntervalId = null; // ticks the active Lock In session's live timer
let dayDetailDate = null; // "YYYY-MM-DD" of the weekly-view day whose detail modal is open, or null

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
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
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
// -------------------------------------
function debounce(fn, delay) {
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
  return challenge.scheduledDate || (challenge.dateCreated ? challenge.dateCreated.slice(0, 10) : getTodayDateString());
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
// going or wrap up whenever they choose.
const LOCKIN_DURATION_OPTIONS = [25, 45, 60, 90];

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
    xpValue: minutes,
    category: "lockin",
    recurrence: "none",
    scheduledDate: getTodayDateString(),
    completed: false,
    archived: false,
    dateCreated: new Date().toISOString(),
    isLockIn: true,
    targetMinutes: minutes,
    startedAt: new Date().toISOString(),
    notifiedAtTarget: false,
    actualMinutes: null,
  };

  state.challenges.push(newSession);
  saveState();
  return { ok: true };
}

function finishLockIn(id) {
  const challenge = state.challenges.find((c) => c.id === id);
  if (!challenge || challenge.completed) return;

  const elapsedSec = Math.floor((Date.now() - new Date(challenge.startedAt).getTime()) / 1000);
  challenge.actualMinutes = Math.max(1, Math.round(elapsedSec / 60));
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

  if (!active || !timeEl) {
    stopLockInTicker();
    return;
  }

  const elapsedSec = Math.floor((Date.now() - new Date(active.startedAt).getTime()) / 1000);
  const targetSec = active.targetMinutes * 60;
  const overBy = elapsedSec - targetSec;

  if (overBy >= 0) {
    timeEl.textContent = `${formatLockInDuration(targetSec)} target + ${formatLockInDuration(overBy)} over`;
    if (statusEl) {
      statusEl.textContent = "🔥 Overtime - keep going or finish anytime";
      statusEl.classList.add("is-overtime");
    }
    if (progressEl) progressEl.style.width = "100%";

    if (!active.notifiedAtTarget) {
      active.notifiedAtTarget = true;
      saveState();
      addNotification(`Lock In time's up for "${active.title}" - you can keep going!`, "⏰");
      triggerCompletionFeedback();
    }
  } else {
    timeEl.textContent = `${formatLockInDuration(elapsedSec)} / ${active.targetMinutes}m target`;
    if (statusEl) {
      statusEl.textContent = "Locked in...";
      statusEl.classList.remove("is-overtime");
    }
    if (progressEl) progressEl.style.width = `${Math.min(100, (elapsedSec / targetSec) * 100)}%`;
  }
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
  if (dateStr === getTodayDateString()) return "Today";
  if (dateStr === getDateStringWithOffset(1)) return "Tomorrow";
  if (dateStr === getDateStringWithOffset(-1)) return "Yesterday";
  const d = new Date(`${dateStr}T00:00:00`);
  return `${CALENDAR_MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
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
    description: "Set a custom weekly goal",
    icon: "🏁",
    condition: (s) => (s.user.weeklyGoal || CONFIG.DEFAULT_WEEKLY_GOAL) !== CONFIG.DEFAULT_WEEKLY_GOAL,
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

  // --- Weekly goal ---
  {
    id: "goal-crusher",
    tier: "hard",
    name: "Goal Crusher",
    description: "Hit your weekly goal",
    icon: "🏹",
    condition: (s) => {
      const wins = getWeeklyWins();
      return wins.completedCount >= (s.user.weeklyGoal || CONFIG.DEFAULT_WEEKLY_GOAL);
    },
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

  showToast(`${icon} ${message}`);
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
          <div class="notif-item__icon">${n.icon}</div>
          <div>
            <div class="notif-item__message">${n.message}</div>
            <div class="notif-item__time">${formatRelativeTime(n.timestamp)}</div>
          </div>
        </div>
      `
    )
    .join("");
}

function initNotifBell() {
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

    return matchesSearch && matchesStatus;
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
// Weekly goal: progress toward user.weeklyGoal
// -------------------------------------
function getWeeklyGoalProgress() {
  const wins = getWeeklyWins();
  const goal = Math.max(1, state.user.weeklyGoal || CONFIG.DEFAULT_WEEKLY_GOAL);
  const percent = Math.min(100, Math.round((wins.completedCount / goal) * 100));
  return { completed: wins.completedCount, goal, percent };
}

function setWeeklyGoal(goal) {
  const parsed = parseInt(goal, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return;
  state.user.weeklyGoal = Math.min(50, parsed);
  saveState();
}

// -------------------------------------
// Category balance: completions this week, grouped by category
// -------------------------------------
function getCategoryBalanceThisWeek() {
  const wins = getWeeklyWins();
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

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

  const padding = 24;
  const chartWidth = displayWidth - padding * 2;
  const chartHeight = displayHeight - padding * 2;
  const barGap = 8;
  const barWidth = chartWidth / data.length - barGap;

  ctx.clearRect(0, 0, displayWidth, displayHeight);

  data.forEach((point, i) => {
    const barHeight = (point.count / maxCount) * chartHeight;
    const x = padding + i * (barWidth + barGap);
    const y = padding + (chartHeight - barHeight);

    ctx.fillStyle = "#d97706";
    ctx.fillRect(x, y, barWidth, barHeight);

    ctx.fillStyle = "#a1a1aa";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(point.count, x + barWidth / 2, y - 6);

    const dayLabel = point.date.slice(8, 10);
    ctx.fillText(dayLabel, x + barWidth / 2, displayHeight - 6);
  });
}

// -------------------------------------
// Weekly Goal: progress ring render helper (inline SVG)
// -------------------------------------
function renderGoalRing() {
  const progress = getWeeklyGoalProgress();
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
        <h3 style="margin: 0 0 4px;">Weekly Goal</h3>
        <p class="text-muted" style="margin: 0;">
          ${
            progress.percent >= 100
              ? "Goal reached! 🎉 Nice work this week."
              : `${progress.goal - progress.completed} more to hit your goal.`
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
      <p class="week-view-hint text-muted">Tap any scheduled task to mark it complete.</p>
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
      <p class="text-muted" style="margin-top:0;">
        Start a focused session. You'll be notified when time's up, but you can keep going.
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
        <label for="lockin-difficulty-select" class="sr-only">Difficulty</label>
        <select id="lockin-difficulty-select" class="difficulty-select">
          <option value="easy">Easy</option>
          <option value="medium" selected>Medium</option>
          <option value="hard">Hard</option>
        </select>
        <label for="lockin-duration-select" class="sr-only">Duration</label>
        <select id="lockin-duration-select" class="difficulty-select">
          ${LOCKIN_DURATION_OPTIONS.map(
            (mins) => `<option value="${mins}" ${mins === 60 ? "selected" : ""}>${mins} min</option>`
          ).join("")}
          <option value="custom">Custom...</option>
        </select>
        <label for="lockin-custom-minutes-input" class="sr-only">Custom minutes</label>
        <input
          type="number"
          id="lockin-custom-minutes-input"
          class="date-input lockin-custom-input is-hidden"
          placeholder="Minutes"
          min="1"
          max="240"
        />
        <button type="submit" class="btn">Lock In</button>
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
        <h1>Welcome to Questify</h1>
        <p class="text-muted">Enter your name to begin your journey.</p>
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
          <button type="submit" class="btn">Start Questing</button>
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
    <div class="dashboard-greeting">
      <h2>Welcome back, ${escapeHTML(state.user.name)}</h2>
      <p class="text-muted">Here's where you stand today.</p>
    </div>

    <div class="card streak-card">
      <div class="streak-flame">🔥</div>
      <div class="streak-info">
        <div class="stat-value">${state.user.streak} day${state.user.streak === 1 ? "" : "s"}</div>
        <div class="text-muted">Current streak</div>
      </div>
    </div>

    ${renderGoalRing()}

    <div class="card">
      <div class="profile-stats" style="grid-template-columns: repeat(2, 1fr);">
        <div class="stat-card">
          <div class="stat-value">${state.user.level}</div>
          <div class="stat-label text-muted">Level</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${getCompletedChallenges().length}</div>
          <div class="stat-label text-muted">Completed</div>
        </div>
      </div>
      ${renderXpBar()}
    </div>

    <div class="card mini-chart-card">
      <h3 class="dashboard-section-title" style="margin-top:0;">Last 7 Days</h3>
      <canvas id="dashboard-mini-chart"></canvas>
    </div>

    <h3 class="dashboard-section-title">Category Balance This Week</h3>
    <div class="card">
      ${renderCategoryBalanceCards()}
    </div>

    <h3 class="dashboard-section-title">Recent Badges</h3>
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

    <h3 class="dashboard-section-title">Quick Add</h3>
    <form id="quick-add-form" class="quick-add-form" novalidate>
      <label for="quick-add-input" class="sr-only">Add a new challenge</label>
      <input
        type="text"
        id="quick-add-input"
        placeholder="Add a new challenge..."
        autocomplete="off"
      />
      <button type="submit" class="btn">Add</button>
    </form>

    ${(() => {
      const overdue = getOverdueChallenges();
      const dueToday = getDueTodayChallenges();

      if (overdue.length === 0 && dueToday.length === 0) {
        return `
          <h3 class="dashboard-section-title">Due Today</h3>
          <p class="empty-state text-muted">🎉 You're all caught up! Nothing overdue or due today.</p>
        `;
      }

      const overdueSection =
        overdue.length > 0
          ? `
            <h3 class="dashboard-section-title dashboard-section-title--overdue">⚠️ Overdue (${overdue.length})</h3>
            <div id="dashboard-overdue-list" class="challenge-list">
              ${overdue.map(renderChallengeCard).join("")}
            </div>
          `
          : "";

      const dueTodaySection = `
        <h3 class="dashboard-section-title">Due Today (${dueToday.length})</h3>
        <div id="dashboard-due-today-list" class="challenge-list">
          ${
            dueToday.length === 0
              ? `<p class="empty-state text-muted">Nothing due today.</p>`
              : dueToday.map(renderChallengeCard).join("")
          }
        </div>
      `;

      return overdueSection + dueTodaySection;
    })()}
  `,
  challenges: () => `
    <h2>Challenges</h2>

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
          <div>Weekly Goal</div>
          <div class="text-muted">How many challenges you want to complete each week</div>
        </div>
        <input
          type="number"
          id="weekly-goal-input"
          class="date-input weekly-goal-input"
          min="1"
          max="50"
          value="${state.user.weeklyGoal}"
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
// -------------------------------------
function attachChallengeListDelegation(listElId) {
  const listEl = document.getElementById(listElId);
  if (!listEl) return;

  listEl.addEventListener("click", (e) => {
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

// -------------------------------------
// Wire up the dashboard view after it's rendered
// -------------------------------------
function attachDashboardHandlers() {
  attachChallengeListDelegation("dashboard-overdue-list");
  attachChallengeListDelegation("dashboard-due-today-list");

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
        showToast(`⚠️ ${result.errorMessage}`);
        return;
      }

      addChallenge(result.value);
      renderView();
    });
  }

  drawActivityChart("dashboard-mini-chart");
}

// -------------------------------------
// Wire up the calendar view after it's rendered
// -------------------------------------
function attachCalendarHandlers() {
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
  if (lockinDurationSelect && lockinCustomInput) {
    lockinDurationSelect.addEventListener("change", () => {
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
    const debouncedRerender = debounce(() => {
      renderView();
      const newSearchInput = document.getElementById("search-input");
      if (newSearchInput) {
        newSearchInput.focus();
        newSearchInput.setSelectionRange(searchQuery.length, searchQuery.length);
      }
    }, CONFIG.SEARCH_DEBOUNCE_MS);

    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      debouncedRerender();
    });
  }

  const filterBtns = document.querySelectorAll(".filter-btn");
  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      statusFilter = btn.dataset.filter;
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

// -------------------------------------
// Wire up the settings view after it's rendered
// -------------------------------------
function attachSettingsHandlers() {
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

  const goalInput = document.getElementById("weekly-goal-input");
  if (goalInput) {
    goalInput.addEventListener("change", () => {
      setWeeklyGoal(goalInput.value);
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