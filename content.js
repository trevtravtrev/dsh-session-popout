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
  if (event.button !== 1) return;
  const row = owningSessionRow(event.target);
  if (row === undefined || insideInteractiveControl(event)) return;
  // Middle mousedown on a session row would start autoscroll; suppress it and
  // stage the click. The actual open happens on auxclick, so a middle press
  // that turns into a drag never opens anything.
  event.preventDefault();
  event.stopPropagation();
  pendingMiddle = { id: sessionIdOf(row), at: Date.now() };
}, true);

document.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;
  const staged = pendingMiddle;
  pendingMiddle = null;
  if (staged === undefined || staged.id === undefined) return;
  if (Date.now() - staged.at > 1500) return; // stale press; ignore
  const row = owningSessionRow(event.target);
  if (row === undefined || sessionIdOf(row) !== staged.id) return;
  event.preventDefault();
  event.stopPropagation();
  requestPopout(staged.id);
}, true);

/** Ask the background worker to open a popout window for a session id. */
function requestPopout(sessionId) {
  const url = `${location.origin}${location.pathname}${location.search}#${HASH_PREFIX}${encodeURIComponent(sessionId)}`;
  try {
    chrome.runtime.sendMessage({ type: 'dsh-session-popout', url }, () => {
      // Context invalidated (extension reloaded): fall back to a plain tab.
      if (chrome.runtime.lastError !== undefined) window.open(url, '_blank', 'noopener');
    });
  } catch {
    window.open(url, '_blank', 'noopener');
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
 * @param {string} id - session id handed over via the URL hash.
 */
async function autoSelectSession(id) {
  const deadline = Date.now() + 60_000;
  const expandedToggles = new Set();
  let sidebarExpanded = false;

  while (Date.now() < deadline) {
    await delay(300);

    const row = document.querySelector(sessionRowSelector(id));
    if (row instanceof HTMLElement) {
      clickRow(row);
      if (await becomesSelected(row)) return; // opened; stay quiet
      // The row exists but never selected: archived sessions and sessions the
      // access snapshot refuses are the known cases.
      toast('Session could not be opened — it may be archived or unavailable.');
      return;
    }

    // Collapsed sidebar rail: expand it once so rows mount.
    if (!sidebarExpanded) {
      const toggle = document.querySelector('[data-sidebar-toggle]');
      if (toggle instanceof HTMLElement) {
        sidebarExpanded = true;
        toggle.click();
        continue;
      }
    }

    // Collapsed workspace groups hide their session rows entirely.
    for (const group of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) {
      const key = group instanceof HTMLElement ? group.dataset.rowKey : undefined;
      if (key === undefined || expandedToggles.has(key)) continue;
      expandedToggles.add(key);
      group.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    // "Show N more" overflow buttons reveal watermarked rows.
    for (const more of document.querySelectorAll('button[data-row-key^="overflow:"][aria-expanded="false"]')) {
      if (more instanceof HTMLElement) more.click();
    }
  }

  // No session rows ever appeared: the GUI likely needs authentication in this
  // window, or the DSH version renders different markup.
  toast('Could not find the session in this window. Open your DSH URL here (with its token), then try again.');
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
  }, 5000);
}
