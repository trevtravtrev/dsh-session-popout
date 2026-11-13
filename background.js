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

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'dsh-session-popout' || typeof message.url !== 'string') return;
  if (!isAllowedUrl(message.url)) return;
  chrome.windows.create({ url: message.url, type: 'popup', focused: true });
});
