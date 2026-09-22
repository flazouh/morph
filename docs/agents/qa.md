# Canonical QA

How an agent QA's Morph end to end. Run the gates in order. Stop at the first failure, fix it, and restart from the gate that failed.

## 1. Freshness

```sh
git fetch origin main
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
```

Report the branch, the ahead/behind counts, and the dirty state before any claim.

## 2. Command gates

Run these from the repository root. Each must exit 0.

1. `bun run typecheck` — every package compiles.
2. `bun run test:panel` — panel, kit, overlay, and bridge behavior.
3. `bun run test:core` — agent, session, Cursor, skin, inspector, background.
4. `bun run test:marketplace` — marketplace API, publishing, sandbox, web.
5. `bun run test:relay` — relay protocol, server, and extension link.
6. `bun run test:build` — WXT build plus the extension build contract.

`bun run test` runs 2 through 6 in order. Use it when nothing is being debugged.

## 3. Feature checklist

Each row names the surface, the proof, and where the automated coverage lives. A row passes when its proof is observed, not when its code looks right.

### Extension shell

| Feature | Proof | Coverage |
|---|---|---|
| Toolbar toggle opens and closes the chat card | Card appears and disappears on the page | `src/overlay/host.test.ts` |
| Card survives page navigation | Card returns after the tab loads a new document | `src/overlay/session.test.ts` |
| Window controls | Close, minimize, expand, drag, and corner resize | `src/overlay/host.test.ts`, `src/overlay/resize.test.ts` |
| Chat tabs | Create, select, close, and keyboard navigation across site threads | `src/panel/ChatTabs.test.tsx` |
| Settings workspace | Theme, font size, provider keys, skills | `src/panel/SettingsView.test.tsx` |

### Agent chat

| Feature | Proof | Coverage |
|---|---|---|
| OpenRouter turn | Send, streamed thinking in the activity row, one final answer bubble | `src/session/real.test.ts`, `src/panel/panel.test.tsx` |
| Cursor turn | Same, through the background host and proxy | `src/cursor/session.test.ts`, `src/cursor/proxy.test.ts` |
| Deterministic turn state | Narration never becomes an answer bubble; stopped and failed phases render | `src/cursor/turn.test.ts`, `src/panel/Transcript.test.tsx` |
| Stop and steer | Stop cancels; a message mid-turn stops and restarts | `src/panel/panel.test.tsx` |
| Tools | Tool steps render with input, result, and error states | `src/panel/ToolStep.test.tsx` |
| Questions | `ask_user` cards answer and expire correctly | `src/panel/Transcript.test.tsx` |
| Spend | Token and cost labels per provider | `src/panel/spend.test.ts` |
| Crew bots | Bots mount, position, hide, and clear | `src/overlay/crew.test.ts` |
| Crew roles | One role list drives `spawn_agent` (OpenRouter) and `customSubagents` (Cursor); a Cursor `task` frame becomes a delegation step | `src/agent/crew/roles.test.ts`, `src/agent/tools.test.ts`, `src/cursor/api.test.ts`, `src/cursor/session.test.ts` |

### Page editing

| Feature | Proof | Coverage |
|---|---|---|
| Apply styles | CSS lands on the page and persists across navigation | `src/skin`, `src/bridge/dom.test.ts` |
| Take a look off | Page scope and site scope removal, each confirmed twice | `src/panel/panel.test.tsx` |
| Inspector | Alt+Shift+I, pick an element, edit the six properties, undo/redo/discard | `src/inspector/controller.test.ts` |
| Inspector handoff | Edits become a prompt in the chat | `src/inspector/handoff.test.ts` |

### Marketplace in the extension

| Feature | Proof | Coverage |
|---|---|---|
| Matches for this page | The panel lists Morphs scoped to the current URL | `src/panel/MarketplaceMatches.test.tsx` |
| Morphs on the icon | The toolbar badge counts what the page has and the reader lacks | `src/marketplace/badge.test.ts`, `src/background.test.ts` |
| Preview | A match previews on the page and restores | `src/marketplace/preview.ts` tests |
| Install, rollback, remove | Library writes and page reloads | `src/marketplace/installer.test.ts`, `src/marketplace/reload.test.ts` |
| Fork drafts | Edit, preview, and publish flow | `src/marketplace/forks`, `src/marketplace/publishing` tests |
| Publish a page redesign | The card offers it once a look is applied; the agent shows the package and asks; the release lands as a root package | `src/panel/PublishLook.test.tsx`, `src/agent/page-publish-tools.test.ts`, `src/marketplace/api/publishing.test.ts` |

### Marketplace service

| Feature | Proof | Coverage |
|---|---|---|
| Catalog API | List, get, install count, reports, input validation | `src/marketplace/api/http.test.ts` |
| Device auth and OAuth | Issue, approve, exchange, revoke; hashed storage only | `src/marketplace/api/auth.test.ts`, `auth-http.test.ts`, `oauth.test.ts` |
| Release runs | Resumable stages, idempotent content keys, failure recovery | `src/marketplace/api/publishing.test.ts` |
| Postgres constraints | Real migrations, unique keys, transactional catalog writes | `src/marketplace/api/release-postgres.test.ts` (needs local Postgres binaries) |
| Web app | Explore, detail, library, publish pages | `src/marketplace/web/App.test.tsx` |
| Static serving | Routes, cache headers, path traversal refusal | `src/marketplace/api/web.test.ts` |

### Relay

| Feature | Proof | Coverage |
|---|---|---|
| Registration | Bridge id, token, and MCP URL minted | `src/relay/server.test.ts` |
| Origin rules | Untrusted HTTP and WebSocket origins rejected | `src/relay/server.test.ts` |
| Tool calls | MCP requests reach the extension and return | `src/relay/extension.test.ts` |
| Reconnect and heartbeat | Socket drops recover; pings keep the worker alive | `src/relay/extension.test.ts` |

## 4. Live extension QA

Run after the command gates pass. Use Ego Lite. Never open `chrome://extensions`.

1. Build: `bun run build`. The output is `.output/chrome-mv3`.
2. Load or reload into the Ego that is already running, from an `ego-browser nodejs` script. No restart, no file picker:

   ```js
   const task = await taskSpace("load Morph extension")
   const browser = await task.cdp("Target.attachToBrowserTarget")
   const loaded = await cdp("Extensions.loadUnpacked", { path: "<repo>/.output/chrome-mv3" }, browser.sessionId)
   console.log(loaded, await cdp("Extensions.getExtensions", {}, browser.sessionId))
   await task.finish({ keep: [] })
   ```

   Use the legacy `cdp(method, params, sessionId)` helper for `Extensions.*`; `task.cdp` and `page.cdp` refuse that domain. Verify `enabled: true` and the canonical path in the answer.

   Never call `Extensions.uninstall` to reload. It deletes the extension's `chrome.storage.local` with it: the settings, both API keys, the thread list and the designs. Loading the same path again reuses the id and keeps the storage. Verified on Chromium 152: one uninstall left only `chatThreads` behind.
3. Only when Ego is not running: `node scripts/morph-ego-control.mjs` starts Ego on a debugging pipe, loads `.output/chrome-mv3`, and prints `MORPH_CONTROL_READY`. Keep it running; then `printf '%s' '{"action":"load"}' | nc -U /tmp/morph-ego-control.sock` reloads. Starting Ego this way when the user already has it open needs their approval.
4. Open one Ego task space on a real page, for example `https://news.ycombinator.com`.
5. Open the chat from a `panel.html` page in the same space. Every message rides the `@webext-core/messaging` envelope, so a bare `{ type: "openChat" }` is ignored; send the protocol's `overlay` kind:

   ```js
   const [tab] = await chrome.tabs.query({ url: "https://news.ycombinator.com/*" })
   await chrome.tabs.sendMessage(tab.id, { id: 1, type: "overlay", data: { type: "openChat" }, timestamp: Date.now() })
   // -> { res: { type: "ok" } }
   ```

   Query the exact URL of the tab you opened: the reader's own tabs match a loose pattern too. Do not `executeScript` the content script into a page the manifest already covers; a second instance mounts a second card. After a `chrome.runtime.reload()`, extension pages close and the content scripts on open tabs lose their runtime; reload the page tab.
6. Exercise the checklist rows that need a browser: card toggle, a Cursor or OpenRouter turn, a tool call, stop, take-a-look-off, and the inspector.
   A Cursor delegation to a crew role does not work today, so do not spend a turn proving it again. `POST /v1/agents` accepts `customSubagents` and echoes the array back in its 201 (verified on 2026-09-15 with a hand-made call carrying one `reviewer` role), but the agent's Task tool still offers only `generalPurpose`, `explore`, `computerUse`, `videoReview`, `cursor-guide`, `ci-investigator` and `best-of-n-runner`, and it rejects `reviewer` when the model calls it. Morph's agents have no repository, which is the one difference left to test.
   Do not trust the model's own account of its subagents. Asked to list them, Claude Opus 5 named the three crew roles twice, because `DELEGATION_GUIDANCE` describes them in the prompt; only forcing the Task call showed the tool refusing the name. `GET /v1/agents/{id}` never returns `customSubagents`, so it cannot settle the question either.
   For the OpenRouter crew, send `Have the reviewer bot check the header, then tell me what it said.` The card must show a "Delegating" step whose input carries `role: "reviewer"`, whose result brief starts with the reviewer's own prompt, then an `await_agents` step with the bot's verdict. Verified live on Kimi K3.
   The card's iframe is an out-of-process frame: attach to its target (`Target.getTargets`, type `iframe`, url `panel.html#morph-nonce=`) and read it with `Runtime.evaluate`. A closed `AgentDisclosure` stays in the DOM with `aria-hidden="true"`, so `innerText` still contains its text; check the attribute before reporting a banner as shown.
7. Publish a page redesign, the one flow that ends outside the browser. Redesign a page, then use the card's own row rather than typing: it appears above the composer once a look is applied and sends the prompt the agent answers. Check the agent shows the name, slug, version, revision ID, the paths and the file list, and asks through `ask_user` before anything leaves the browser. Accepting starts sign-in, and that is where an agent stops. The worker opens `api-production-0261.up.railway.app/marketplace/device?...` (not github.com, which is what to watch for), the code is already in the field, and "Continue with GitHub" reaches GitHub's consent screen. GitHub keeps "Authorize" disabled for automation, so the reader clicks that one. The publish waits on it: it is parked in `publish_morph` until the code is approved or expires. A thread that redesigned several pages of one site publishes them as one package, with `paths` naming each and the files under `pages/`. A page whose look was taken off is refused, since its after picture would show a bare page.
8. Capture one screenshot per distinct result. Save them under `.impeccable/review/`.
9. Close the task space with `finish({ keep: [] })` and run `/Users/alex/.agents/bin/ego-tidy`.

### Flipping “Allow User Scripts” in QA

The switch is user-gated: Morph cannot flip it, and `chrome.developerPrivate` exists only on `chrome://extensions`. The QA harness can, because Ego gives it CDP into that page. The call needs a real gesture first, so click the page before calling.

```js
const page = await task.newPage()
await page.goto("chrome://extensions/?id=<morph-id>")
await page.mouse.click(400, 300, { label: "gesture" })
await page.evaluate(() =>
  chrome.developerPrivate.updateExtensionConfiguration({ extensionId: "<morph-id>", userScriptsAccess: false })
)
```

`userScriptsAccess: true` turns it back on. The change is live at once in every Morph context; verified on Chromium 152, no extension reload needed. Use `false` to reproduce the User Scripts card, `true` to test writes.

### Driving the card correctly

The card's open state lives in the background worker, keyed by tab id. A direct `openChat` message to the content script shows the card but does not record it, so navigation restore will not fire. To make restore work in a test, write the tab into the record the toolbar toggle uses:

```js
await chrome.storage.session.set({ "open-chat-tabs": [tabId] })
```

Match the tab by a unique URL. The browser may hold several tabs on one site, and `chrome.tabs.query({ url })` returns the first, which may not be the tab you navigate. A mismatch registers the wrong tab and restore misfires. Navigate to a unique URL first, then query it.

## 5. Service startup

Only start these when the scenario needs them. Both default to port 3000, so give them distinct `PORT` values.

- Marketplace API: `bun run start:marketplace-api`. Needs `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_RELEASE_TOKEN`, `RELEASE_RECEIPT_SECRET` (32+ bytes), `REPORT_SALT`, and Postgres. Health: `GET /health`.
- Relay: `bun run relay`. Needs `RELAY_PUBLIC_ORIGIN` for correct public MCP URLs. Health: `GET /health`.

The extension talks to the deployed marketplace (`https://api-production-0261.up.railway.app`) and relay by default.

## 6. Report

Report per gate: command, exit code, and one line of evidence. Per live row: what was done, what was observed, and the screenshot path. Name anything skipped and why.

## Deeper inventories

For a full file-by-file feature map, see the extension and marketplace inventories in the agent transcripts. This checklist is the canonical gate order; those are reference.
