# DSH Session Popout

A Brave/Chrome extension that opens a DeepSeek Harness session in its own window: **middle-click a session in the left sidebar** and it pops out.

Works with the DeepSeek Harness web GUI (`dsh web`), in any Chromium browser (Brave, Chrome, Edge).

![popout icon](icons/icon128.png)

## Install in Brave (Load unpacked)

1. Clone or download this repo to a folder that will stay put (Brave loads the extension from that folder on every launch):
   ```
   git clone https://github.com/trevtravtrev/dsh-session-popout.git
   ```
2. Open `brave://extensions`.
3. Enable **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the cloned `dsh-session-popout` folder.
5. Open your DeepSeek Harness GUI (e.g. `http://127.0.0.1:3080`) and **middle-click a session** in the left menu — it opens in its own chromeless window.

> Tip: to pin the folder permanently, keep it anywhere in your user profile (e.g. `Documents\GitHub`). Don't delete the folder after loading — Brave re-reads it each start.

## Use

- **Middle-click** (press the scroll wheel) on a session row in the left sidebar → that session opens in a new popout window.
- Everything else keeps normal middle-click behavior; clicking the row's menu/pin/archive buttons with the middle button does nothing special.
- The popout window selects the session automatically: it waits for the app to load, expands the sidebar and any collapsed workspace groups, and clicks the row for you. Your login/token must be valid for that origin — if the popout shows the sign-in screen, sign in there once and middle-click again.
- Archived sessions (and sessions the app refuses to open) show a small notice in the corner instead.

## How it works

DeepSeek Harness's web GUI is a single-page app with no per-session URL. The extension bridges that with a small handoff hash:

1. **Content script** (`content.js`) listens for middle-button presses on session rows. Rows are identified by their stable DOM contract: `div[data-row-key="session:<sessionId>"]` in the sidebar tree.
2. It asks the **service worker** (`background.js`) to open a **popup-type browser window** (no tabs, minimal chrome) at `https://<your-gui-origin>#dsh-session=<id>`.
3. In the new window, the content script consumes the hash, waits for the app to boot, reveals the row (expanding groups/overflow as needed), and clicks it — exactly like a user would.

The extension uses no network access, no `tabs`/`storage` permissions, and touches nothing outside DSH local origins (`localhost` / `127.0.0.1`, any port, plus `*.localhost`).

## Compatibility notes

- Tested against DSH `0.2.2-rc.1` sidebar markup (`data-row-key` rows, `[data-sidebar-toggle]`, `aria-expanded` groups/overflow buttons).
- If you run the GUI on a remote host (not localhost), add the origin to both `manifest.json` → `content_scripts[].matches` and `background.js` → `ALLOWED_HOSTS`, then reload the extension.
- Middle-click autoscroll is suppressed only when the press lands on a session row.

## License

[MIT](LICENSE)
