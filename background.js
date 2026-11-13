/**
 * DSH Session Popout — background service worker.
 *
 * Receives "open a session in a popout window" requests from the content
 * script and creates a chromeless browser window (type: "popup") pointing at
 * the DSH web GUI URL with a #dsh-session=<id> handoff hash. The content
 * script running in the new window consumes the hash and selects the session.
 *
 * No permissions are required: chrome.windows.create needs none, and the
 * content script is declared in the manifest.
 */

'use strict';

/** Hosts the popout is allowed to target (mirrors the manifest match patterns). */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Popout window geometry: wide enough that the DSH sidebar starts expanded. */
const WINDOW_WIDTH = 1400;
const WINDOW_HEIGHT = 950;

/**
 * Validate a popout URL before opening a window for it.
 * @param {string} rawUrl - URL built by the content script from its own origin.
 * @returns {boolean} whether the URL is a local DSH GUI address.
 */
function isAllowedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (ALLOWED_HOSTS.has(host) || host.endsWith('.localhost'));
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'dsh-session-popout' || typeof message.url !== 'string') return;
  if (!isAllowedUrl(message.url)) {
    sendResponse({ ok: false, reason: 'url-not-allowed' });
    return;
  }
  chrome.windows.create(
    { url: message.url, type: 'popup', focused: true, width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    () => {
      // window creation failures are non-fatal; never spam the console
      void chrome.runtime.lastError;
    },
  );
  // Always answer so the sender's callback is not left on a closed port —
  // an unanswered channel reports a runtime.lastError in the content script,
  // which used to make it ALSO open a normal tab (double-open bug).
  sendResponse({ ok: true });
  return; // synchronous response; no need to keep the channel open
});
