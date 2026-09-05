# pi-goimports

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that runs
`goimports` automatically after every `write`/`edit` to a `*.go` file and
appends the diff to the tool result, so the next turn sees the actual
import/format changes. It also appends a standing rule to the system prompt
once per agent run telling the model to write the code body first and let
goimports manage resolvable imports.

## What it does

- **`before_agent_start`** — appends a constant rule to the system prompt once
  per agent run (cache-safe): write the body first, let goimports add the
  imports it can resolve, only add non-resolvable imports manually after
  goimports has run. Also tells the model how to recover from a stale module
  cache index (run `gomodindex`), and notes that edits via the `bash` tool are
  not processed automatically.
- **`tool_result`** for `write`/`edit` on `*.go` — runs `goimports -d -w`
  (prints the diff to stdout and applies it in one call) and appends the diff
  to the tool result. No-op when goimports changes nothing.

## Binary lookup (cached per session)

A bare `execFile` probe on PATH confirms goimports is on PATH **and** actually
runs. If that fails, the `go env GOBIN`/`GOPATH` candidate is probed (so
`go install` into a GOBIN that isn't on PATH is still found after `/reload`).
Errors (probe stderr, `go env` failures) propagate unmodified into the
`session_start` notify. The result is stable for the whole session so the
system-prompt rule doesn't flip mid-session; install goimports and `/reload`
to (de)activate.

## Install

```bash
pi install npm:pi-goimports
# or pin a version
pi install npm:pi-goimports@0.1.1

# alternative — from git
pi install git:github.com/huww98/pi-goimports
pi install git:github.com/huww98/pi-goimports@v0.1.1
```

To try without installing: `pi -e npm:pi-goimports`.

## Configuration

- `PI_GOIMPORTS_ARGS` — extra args appended to `goimports -d -w`
  (e.g. `-local github.com/myorg` for local import grouping).

## Requirements

- `goimports` on PATH or in `$GOBIN`/`GOPATH/bin` (install with
  `go install golang.org/x/tools/cmd/goimports@latest`).
- `go` on PATH (goimports shells out to `go` for env context, even for
  `package x`).
- `diff` on PATH (goimports `-d` shells out to `diff` for the diff output;
  always present on macOS/Linux).
- Optional: `gomodindex` (`go install golang.org/x/tools/internal/modindex/gomodindex@latest`).
  goimports v0.48.0+ resolves module-cache candidates from the index
  that gopls maintains in `os.UserCacheDir()/goimports`, and never refreshes it itself.
  `gomodindex` rebuilds it after a `go get` (see [golang/go#80087](https://github.com/golang/go/issues/80087)).
  Without an index goimports still works, by scanning `GOMODCACHE` (seconds, not milliseconds).

## Development

```bash
npm install
npm test  # (integration tests; requires goimports + go)
npm run typecheck
```

## License

MIT
