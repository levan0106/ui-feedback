# UI Feedback Bridge

Point at the wrong part of your UI in the browser, and your coding agent receives your note plus the selector, styles, component chain and source `file:line`. It fixes the code and replies in the page. No screenshots.

```
Browser overlay ──POST──▶ bridge 127.0.0.1:47831 ◀── poll / MCP ── agent (Claude Code, Codex)
       ▲                        │
       └──── SSE: agent reply ◀─┘
```

Node >= 20, no dependencies.

## Install

```bash
node bridge/cli.mjs install          # skill + MCP server + `tl-ui-feedback` command
node bridge/cli.mjs install --path   # also add the command to your PATH (Windows)
```

Check with `claude mcp list`. Remove with `tl-ui-feedback uninstall`.

As a Claude Code plugin instead: `claude --plugin-dir <this-folder>`. Use one of the two, not both.

## Use

1. Start a Claude Code session and tell the agent to wait for UI feedback.
2. Serve the site you want to inspect, then open the printed address:
   ```bash
   tl-ui-feedback serve http://localhost:8081      # proxy a running dev server
   tl-ui-feedback serve ./dist --spa               # serve static files
   tl-ui-feedback serve --cmd "npm run dev" http://localhost:5173
   ```
3. Click **Feedback**, pick an element, type a note, **Send to agent** (Ctrl+Enter). `Esc` or Alt+Shift+K pauses picking.

Alternatively load `extension/` in `chrome://extensions` (Developer mode, Load unpacked) to get the overlay on any localhost page without `serve`.

## CLI

`tl-ui-feedback install | uninstall | serve | start | poll | reply "<text>" | status | url | token | stop`

Run `tl-ui-feedback serve --list` to see running servers and `serve --stop <port>` to stop one.

## Security

- Binds to `127.0.0.1` only; rejects unknown `Host` and non-local `Origin`.
- API calls need a token stored in `~/.ui-feedback-bridge/token` (mode 0600).
- Chat history stays in memory; nothing is written to disk. State lives in `~/.ui-feedback-bridge/` (`UIFB_HOME`), port via `UIFB_PORT`.
- Any page on localhost can read the token, so do not run untrusted pages on localhost.

## Develop

```bash
npm test
```

## License

MIT
