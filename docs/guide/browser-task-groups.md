# Browser task groups

Use a named Chrome tab group to keep a task's sites together. These commands require a Browser Bridge build that includes group commands; update both the CLI and extension together.

```bash
opencli browser hiring group list
opencli browser hiring group create "Hiring"
opencli browser hiring tab new https://example.com/jobs
opencli browser hiring tab list
```

`group list` reads all **live** groups in the selected Chrome profile, across its windows. Each result includes `id`, `title`, `color`, `collapsed`, `windowId`, and member tabs with their page identities. It does not acquire control of those tabs.

To reuse a group the user already has:

```bash
opencli --profile work browser hiring group use "Hiring"
opencli --profile work browser hiring tab list
opencli --profile work browser hiring tab select <page>
opencli --profile work browser hiring state
```

`group use` explicitly borrows the selected group. Later `open`, `state`, `tab new`, `tab select`, and `tab close` operate within that group. Tabs outside it are rejected, even if they share its Chrome window. The group keeps its name, color, and existing pages. Regular owned browser sessions continue to use the default OpenCLI container; adapters retain their existing behavior.

Group titles are matched **literally**, including characters such as `*`. Chrome permits duplicate titles, so use the numeric ID from `group list` to choose among duplicates. All-digit arguments are interpreted as IDs; a group with an all-digit title can be selected by its listed ID.

```bash
opencli browser hiring group use 91
opencli browser hiring group rename 91 "Recruiting"
opencli browser hiring group delete 91
```

`group create` creates a new blank tab in the current Chrome window, groups it under the agent-chosen name, and borrows the group for the session. It never repurposes an existing page. Pass `--window-id <id>` to place it in a specific window. Chrome groups cannot be empty.

`group rename` changes the title of the specified group. `group delete` **ungroups** all its member tabs and detaches sessions using the group; it leaves the pages open. `tab close` is the separate, explicit command that closes one member tab.

To finish a task while leaving its tabs available:

```bash
opencli browser hiring close
```

Releasing a group session only detaches control. Group sessions have no idle cleanup that blanks or closes pages. Multiple sessions can use separate tabs in one group; a tab already selected by another live session returns `group_tab_busy`. Create or select another tab. A group containing a tab owned by another ordinary OpenCLI session cannot be adopted until that session releases its lease.

Bindings and IDs are stored in `chrome.storage.session`, preserving them across service-worker restarts. After Chrome restarts or the extension reloads/updates, run `group list` and `group use` again. IDs must never be reused from a prior browser session. If a selected group closes while the binding exists, commands fail with `tab_group_not_found` instead of creating a different window.

The Chrome extension APIs expose live groups, not closed/saved groups in Chrome's Saved Tab Groups UI. Deleting a live group does not claim to remove a saved or synced entry; Chrome owns that UI.

## Verification

```bash
npm ci
npm run build
npm --prefix extension ci
npm run build --prefix extension
npm run typecheck
npm run typecheck --prefix extension
npm test
```

The native Chrome test uses a fresh profile, a copied built extension and a random local bridge port. It leaves existing Chrome profiles and OpenCLI daemons alone:

```bash
OPENCLI_GROUP_E2E=1 CHROME_PATH=/path/to/installed/chrome-for-testing \
  npx vitest run --project e2e tests/e2e/browser-groups-chrome.test.ts
```

Run headed under a real display (or `xvfb-run` on Linux); the test checks native window focus as well as group operations.

References: [Chrome tabGroups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups), [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Chrome session storage](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session).
