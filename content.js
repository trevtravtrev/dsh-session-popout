/**
 * DSH Session Popout — content script.
 *
 * Runs on the DeepSeek Harness web GUI (local origins). Two jobs:
 *
 * 1. Middle-click capture: pressing the middle mouse button on a session row
 *    in the left sidebar opens that session in a popout window instead of
 *    starting autoscroll. Session rows are `div[data-row-key="session:<id>"]`
 *    (role=treeitem) in the `sidebar.workspaces` region; the session id is
 *    embedded in the attribute.
 *
 * 2. Session handoff: when a window/tab loads with `#dsh-session=<id>` in its
 *    URL, the hash is consumed and the app is driven to select that session:
 *    wait for boot, expand the sidebar if it is collapsed, expand collapsed
 *    workspace groups and "show more" overflow rows until the row exists,
 *    then click it and confirm via `aria-selected`.
 *
 * No DSH storage or APIs are touched — everything is DOM-level, so it keeps
 * working across DSH updates as long as the row markup stays.
 */

'use strict';

/** URL hash prefix carrying the handoff session id. */
const HASH_PREFIX = 'dsh-session=';

/** Minimum spacing between two popout opens, deduping stacked/double events. */
const OPEN_DEDUPE_MS = 800;

/** Selector for a session row by id (value is CSS-escaped by the caller). */
const sessionRowSelector = (id) => `[data-row-key="${CSS.escape(`session:${id}`)}"]`;

/* ------------------------------------------------------------------ *
 * 1. Middle-click capture
 * ------------------------------------------------------------------ */

/** Session id captured on middle mousedown, awaiting the matching auxclick. */
let pendingMiddle = null;

/**
 * The session row owning an event target, if any.
 * @param {EventTarget|null} target
 * @returns {HTMLElement|undefined} the row element carrying data-row-key.
 */
function owningSessionRow(target) {
  if (!(target instanceof Element)) return undefined;
  const row = target.closest('[data-row-key]');
  if (row instanceof HTMLElement && row.dataset.rowKey.startsWith('session:')) return row;
  return undefined;
}

/** True when the event lands on an interactive control inside a row (menu button, pin, archive...). */
function insideInteractiveControl(event) {
  return event.target instanceof Element
    && event.target.closest('button, a, input, textarea, select, [role="menuitem"]') !== null;
}

/**
 * Session id stored on a row element.
 * @param {HTMLElement} row
 * @returns {string|undefined}
 */
function sessionIdOf(row) {
  const key = row.dataset.rowKey;
  return key.startsWith('session:') ? key.slice('session:'.length) : undefined;
}

document.addEventListener('mousedown', (event) => {
  try {
    if (event.button !== 1) return;
    const row = owningSessionRow(event.target);
    if (row === undefined || insideInteractiveControl(event)) return;
    // Middle mousedown on a session row would start autoscroll; suppress it and
    // stage the click. The actual open happens on auxclick, so a middle press
    // that turns into a drag never opens anything.
    event.preventDefault();
    event.stopPropagation();
    pendingMiddle = { id: sessionIdOf(row), at: Date.now() };
  } catch (_error) {
    // Never let a popout bug break normal page interaction.
  }
}, true);

document.addEventListener('auxclick', (event) => {
  try {
    if (event.button !== 1) return;
    // Consume whatever was staged. pendingMiddle is null when no mousedown
    // staged it (plain middle-click elsewhere) — `== null` covers both null
    // and undefined, so a stray auxclick can never throw on `.id` again.
    const staged = pendingMiddle;
    pendingMiddle = null;
    if (staged == null || staged.id === undefined) return;
    if (Date.now() - staged.at > 1500) return; // stale press; ignore
    const row = owningSessionRow(event.target);
    if (row === undefined || sessionIdOf(row) !== staged.id) return;
    event.preventDefault();
    event.stopPropagation();
    requestPopout(staged.id);
  } catch (_error) {
    // Never let a popout bug break normal page interaction.
  }
}, true);

/**
 * Ask the background worker to open a popout window for a session id.
 * Never opens tabs from the page: the background is the only window opener.
 * @param {string} sessionId
 */
function requestPopout(sessionId) {
  // Dedupe stacked content-script instances (extension reload orphans) and
  // double-delivered events so one click opens exactly one window.
  const now = Date.now();
  const win = /** @type {any} */ (window);
  if (typeof win.__dshPopoutLastOpen === 'number' && now - win.__dshPopoutLastOpen < OPEN_DEDUPE_MS) return;
  win.__dshPopoutLastOpen = now;

  const url = `${location.origin}${location.pathname}${location.search}#${HASH_PREFIX}${encodeURIComponent(sessionId)}`;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    // Extension context truly gone (reloaded/updated while this page stayed open).
    toast('Popout extension was updated — reload this page (Ctrl+R) once, then middle-click again.');
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'dsh-session-popout', url }, (response) => {
      // lastError here can only be a real transport problem now: the
      // background always answers. surface it instead of opening a tab.
      if (chrome.runtime.lastError !== undefined && chrome.runtime.lastError !== null) {
        toast('Popout window failed to open — reload this page (Ctrl+R) and try again.');
        return;
      }
      if (response && response.ok === false) {
        toast('Popout blocked: this origin is not on the extension allow-list.');
      }
    });
  } catch (_contextInvalidated) {
    toast('Popout extension was updated — reload this page (Ctrl+R) once, then middle-click again.');
  }
}

/* ------------------------------------------------------------------ *
 * 2. Session handoff (auto-select on load)
 * ------------------------------------------------------------------ */

/** Session id to auto-select in this window, from the URL hash, if any. */
function consumeHandoffHash() {
  if (!location.hash.startsWith(`#${HASH_PREFIX}`)) return undefined;
  const id = decodeURIComponent(location.hash.slice(1 + HASH_PREFIX.length));
  history.replaceState(null, '', location.pathname + location.search);
  return id === '' ? undefined : id;
}

const sessionId = consumeHandoffHash();

if (sessionId !== undefined) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void autoSelectSession(sessionId); }, { once: true });
  } else {
    void autoSelectSession(sessionId);
  }
}

/**
 * Drive the app until the session row exists and is selected.
 *
 * Sidebar-width policy (learned from live testing): never probe internal
 * attributes — they do not track the visual state. Click the sidebar toggle
 * only while the list region shows ZERO rows, at most a few times, spaced
 * out; an early click during app boot may not register, but clicking in a
 * tight loop oscillates the sidebar and can leave it collapsed.
 *
 * @param {string} id - session id handed over via the URL hash.
 */
async function autoSelectSession(id) {
  const deadline = Date.now() + 90_000;
  const expandedGroups = new Set();
  const TOGGLE_BUDGET = 4;
  const TOGGLE_SPACING_MS = 2500;
  let toggleClicks = 0;
  let lastToggleAt = 0;

  while (Date.now() < deadline) {
    await delay(300);

    // DSH's first-run "Add an API key to get started" / DeepSeek sign-in
    // dialog renders the app root inert and reappears in every new window
    // when no official DeepSeek credential is configured — it would block
    // the session click forever. Dismiss it (same as clicking
    // "Configure later") until it stops coming back.
    dismissOnboardingDialog();

    const row = document.querySelector(sessionRowSelector(id));
    if (row instanceof HTMLElement) {
      clickRow(row);
      if (await becomesSelected(row)) return; // opened; stay quiet
      // The row exists but never selected: archived sessions and sessions the
      // access snapshot refuses are the known cases.
      toast('Session could not be opened — it may be archived or unavailable.');
      return;
    }

    const anyRows = document.querySelectorAll('[data-row-key^="workspace:"], [data-row-key^="session:"]').length > 0;
    if (!anyRows) {
      // Sidebar is either rail-collapsed or its list has not loaded yet.
      // Toggle rarely: an early click races app boot and does not register.
      const toggle = document.querySelector('[data-sidebar-toggle]');
      if (toggle instanceof HTMLElement && toggleClicks < TOGGLE_BUDGET && Date.now() - lastToggleAt >= TOGGLE_SPACING_MS) {
        toggleClicks += 1;
        lastToggleAt = Date.now();
        toggle.click();
        continue;
      }
      continue; // give the app (or the just-clicked toggle) time to render
    }

    // Collapsed workspace groups hide their session rows entirely.
    for (const group of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) {
      const key = group instanceof HTMLElement ? group.dataset.rowKey : undefined;
      if (key === undefined || expandedGroups.has(key)) continue;
      expandedGroups.add(key);
      group.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    // "Show N more" overflow buttons reveal watermarked rows.
    for (const more of document.querySelectorAll('button[data-row-key^="overflow:"][aria-expanded="false"]')) {
      if (more instanceof HTMLElement) more.click();
    }
  }

  // No session rows ever appeared: most likely the GUI needs authentication in
  // this window, or the DSH version renders different markup.
  const text = (document.body instanceof HTMLElement ? document.body.innerText : '').toLowerCase();
  if (text.includes('authentication required') || text.includes('sign in') || text.includes('token')) {
    toast('This popout window is not signed in yet. Open your DSH URL (the one with the token) here once — it stays signed in, then middle-click your session again.');
  } else {
    toast('Could not find the session in this window. If this keeps happening, reload the DSH tab and try again.');
  }
}

/**
 * Dismiss DSH's Models onboarding dialog if it is showing.
 *
 * The dialog has two variants: a DeepSeek account sign-in step with an
 * "Add API key" switcher, and the credential editor whose cancel button is
 * labeled "Configure later" (locale-dependent). This walks sign-in → editor →
 * later using multilingual copy matching, writing nothing unless the dialog
 * is actually present. A "Configure later" click is exactly what a user
 * would do; it dismisses for this window session only.
 *
 * @returns {boolean} whether a dismiss action was taken this call.
 */
function dismissOnboardingDialog() {
  // Scope strictly to the onboarding dialog: a named dialog or the
  // onboarding overlay surface. Without this guard, "add api key"-like
  // buttons elsewhere in the app (settings pages) would be fair game.
  const overlay = document.querySelector('[role="dialog"], [class*="onboardingOverlay"]');
  if (overlay === null) return false;
  const buttons = Array.from(overlay.querySelectorAll('button'))
    .filter((button) => {
      const label = (button.textContent || '').trim();
      return label.length > 0 && label.length <= 60 && button.offsetParent !== null;
    });
  const findBy = (pattern) => buttons.find((button) => pattern.test(button.textContent || ''));
  // Step 1: sign-in variant — switch to the API-key editor ("Add API key").
  const addKey = findBy(/add an api key|add api key|添加\s*api\s*key|api\s*キーを追加/i);
  if (addKey !== undefined) {
    addKey.click();
    return true;
  }
  // Step 2: editor variant — its cancel button is the "later" escape.
  const later = findBy(/configure later|稍后配置|後で設定|configurar más tarde|mais tarde|plus tard|später|позже|나중에/i);
  if (later !== undefined) {
    later.click();
    return true;
  }
  return false;
}

/**
 * Click a session row the same way a user would.
 * @param {HTMLElement} row
 */
function clickRow(row) {
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

/**
 * Wait until the row reports selection (`aria-selected="true"`) or a timeout.
 * @param {HTMLElement} row
 * @returns {Promise<boolean>}
 */
async function becomesSelected(row) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    await delay(150);
    if (row.getAttribute('aria-selected') === 'true') return true;
  }
  return false;
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/* ------------------------------------------------------------------ *
 * Minimal toast (no styling assumptions about the host app)
 * ------------------------------------------------------------------ */

/**
 * Show a transient notice in the corner of the window.
 * @param {string} message
 */
function toast(message) {
  try {
    if (!(document.body instanceof HTMLElement)) return;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.45 system-ui,sans-serif;';
    const card = document.createElement('div');
    card.textContent = message;
    card.style.cssText = [
      'max-width:340px', 'padding:10px 14px', 'border-radius:10px',
      'background:#1f2937', 'color:#e5e7eb', 'border:1px solid #374151',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)', 'opacity:0', 'transition:opacity .25s',
    ].join(';');
    host.appendChild(card);
    document.body.appendChild(host);
    requestAnimationFrame(() => { card.style.opacity = '1'; });
    setTimeout(() => {
      card.style.opacity = '0';
      setTimeout(() => { host.remove(); }, 300);
    }, 6000);
  } catch (_error) {
    // Toast is best-effort only.
  }
}
