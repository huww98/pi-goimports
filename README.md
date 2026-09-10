# pi-goimports

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that runs
`goimports` automatically after every `write`/`edit` to a `*.go` file, writes
the formatted result back, and appends a standard unified diff to the tool
result so the next turn sees the actual import/format changes. It also
appends a standing rule to the system prompt once per agent run telling the
model to write the code body first and let goimports manage resolvable
imports.

## What it does

- **`before_agent_start`** — appends a constant rule to the system prompt once
  per agent run (cache-safe): write the body first, let goimports add the
  imports it can resolve, only add non-resolvable imports manually after
  goimports has run. Also tells the model how to recover from a stale module
  cache index (run `gomodindex`), and notes that edits via the `bash` tool are
  not processed automatically.
- **`tool_result`** for `write`/`edit` on `*.go` — runs `goimports` (no
  `-w`/`-d`), which prints the formatted result to stdout without touching the
  file; writes it back itself and appends a standard unified diff to the tool
  result for the model. No-op when goimports changes nothing. When it does
  make changes, a compact marker (`◆ goimports <path> +N -M`) is appended to
  the chat transcript right after the tool call, so the cue persists in scrollback.
  Expand (`ctrl+o`) to see the full diff.

## Binary lookup (cached per session)

goimports is resolved once at session start — on PATH, or via `go env
GOBIN`/`GOPATH` if installed off-PATH. If it can't be found (or `go` is
missing), a warning is shown at startup with install steps; install it and
`/reload` to activate. The result is stable for the session so the
system-prompt rule doesn't flip mid-run.

## Install

```bash
pi install npm:pi-goimports
# or pin a version
pi install npm:pi-goimports@0.2.1

# alternative — from git
pi install git:github.com/huww98/pi-goimports
pi install git:github.com/huww98/pi-goimports@v0.2.1
```

To try without installing: `pi -e npm:pi-goimports`.

## Configuration

- `PI_GOIMPORTS_ARGS` — extra args appended to the `goimports` invocation
  (e.g. `-local github.com/myorg` for local import grouping).

## Requirements

- `goimports` on PATH or in `$GOBIN`/`GOPATH/bin` (install with
  `go install golang.org/x/tools/cmd/goimports@latest`).
- `go` on PATH (goimports shells out to `go` for env context).
- Optional: `gomodindex` — rebuilds the module-cache index goimports uses to
  resolve imports. Run it after `go get` if a newly-added import isn't being
  resolved (goimports never refreshes the index itself, see [golang/go#80087](https://github.com/golang/go/issues/80087)).
  Without it goimports still works, by scanning `GOMODCACHE` directly (slower).
  `go install golang.org/x/tools/internal/modindex/gomodindex@latest`.

## Development

```bash
npm install
npm test  # (integration tests; requires goimports + go)
npm run typecheck
```

## License

MIT
