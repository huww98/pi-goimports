/**
 * goimports extension
 *
 * - Appends a standing rule to the system prompt once per agent run: the model
 *   should write the code body first and let goimports manage resolvable imports.
 * - After every write/edit to a *.go file, runs `goimports -d -w` (prints the
 *   diff to stdout and applies it in one call) and appends the diff to the tool
 *   result so the next turn sees the actual import/format changes.
 *
 * Binary lookup (cached per session): a bare execFile probe on PATH confirms
 * goimports is on PATH AND actually runs; if that fails, the `go env GOBIN`/
 * `GOPATH` candidate is probed (so `go install` into a GOBIN not on PATH is
 * still found after /reload). Errors (probe stderr, `go env` failures) are
 * propagated unmodified into the session_start notify. If still missing,
 * notifies with install steps.
 *
 * Env:
 *   PI_GOIMPORTS_ARGS - extra args appended to `goimports -d -w`
 *                       (e.g. "-local github.com/myorg")
 */

import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import {
  isEditToolResult,
  isWriteToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const execFileP = promisify(execFile);

const RULE = `

## Go import handling

goimports runs automatically after every \`write\`/\`edit\` tool call on *.go files.
It inserts missing resolvable imports, removes unused ones, and formats the file.
The diff is appended to the tool result so you can see what changed.

Write the code body first; let goimports add the imports it can resolve.
Do not add import lines before writing the code that uses them.
Some imports are not auto-resolvable (ambiguous package names, vendored paths, modules absent from go.mod).
Add those manually only after goimports has run and left them out.

Edits made through the \`bash\` tool are not processed automatically.
If you modify a *.go file via bash, run \`goimports -w <file>\` yourself.
`;

// Resolved once at session_start; null = not found. Stable for the whole
// session so the system-prompt rule doesn't flip mid-session. Install
// goimports mid-session and /reload to (de)activate the rule.
let resolvedPath: string | null = null;

function extraArgs(): string[] {
  const raw = process.env.PI_GOIMPORTS_ARGS?.trim();
  return raw ? raw.split(/\s+/) : [];
}

function errMsg(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr ?? "").trim() || err.message || String(e);
}

// Probe that `bin` actually runs (not just present+executable). Feeds
// `package x` (valid Go) on stdin via execFileP's `.child` handle; exit 0 =>
// true. ENOENT (binary not found / not on PATH) => false — the only expected
// "not runnable" case, so it falls through to the lookup chain. Anything else
// (non-zero exit, EACCES, signal, …) rejects with the error, whose `.stderr`
// the custom promisify attaches (same shape as tool_result's execFileP), so
// errMsg surfaces the clean goimports stderr.
function probeRuns(bin: string): Promise<boolean> {
  const p = execFileP(bin, [], { encoding: "utf8" });
  p.child.stdin?.on("error", () => {}); // EPIPE if child exits before reading
  p.child.stdin?.end("package x\n");
  return p.then(
    () => true,
    (err: unknown) => {
      if ((err as { code?: number | string }).code === "ENOENT") return false;
      throw err;
    },
  );
}

async function resolveGoimportsPath(): Promise<string | null> {
  // 1. PATH (fast path): bare execFile probe confirms on-PATH AND that it runs.
  if (await probeRuns("goimports")) return "goimports";

  // 2. Off-PATH: `go env GOBIN`/`GOPATH` covers `go install` into a GOBIN that
  //    isn't on PATH. Let `go`-missing propagate — goimports can't run
  //    without `go` anyway; session_start surfaces it.
  const { stdout } = await execFileP("go", ["env", "GOBIN", "GOPATH"]);
  const [goBin, goPath] = stdout.split("\n").map((s) => s.trim());
  let candidate: string | null = null;
  if (goBin) {
    candidate = join(goBin, "goimports");
  } else if (goPath) {
    const first = goPath.split(delimiter).filter(Boolean)[0] ?? goPath;
    candidate = join(first, "bin", "goimports");
  }
  if (candidate && await probeRuns(candidate)) return candidate;
  return null;
}

export default function (pi: ExtensionAPI) {
  // Resolve once per session. Stable for the whole session so the system-prompt
  // rule doesn't flip mid-session; install goimports and /reload to activate.
  // probe/go-env errors propagate here and surface in the notify.
  pi.on("session_start", async (_event, ctx) => {
    let path: string | null = null;
    let detail: string | undefined;
    try {
      path = await resolveGoimportsPath();
    } catch (e) {
      detail = errMsg(e);
    }
    resolvedPath = path;
    if (!path && ctx.hasUI) {
      const note = detail ? `cannot resolve goimports: ${detail}` : `goimports not found. Install: go install golang.org/x/tools/cmd/goimports@latest, then /reload`;
      ctx.ui.notify(note, "warning");
    }
  });

  // One-time per agent run: append the rule if goimports was found at
  // session_start. Constant string => cache-safe.
  pi.on("before_agent_start", async (event) => {
    if (!resolvedPath) return;
    return { systemPrompt: event.systemPrompt + RULE };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (!isWriteToolResult(event) && !isEditToolResult(event)) return;
    const path = event.input.path;
    if (typeof path !== "string" || !path.endsWith(".go")) return;
    // Synchronous: resolved by session_start / before_agent_start.
    const bin = resolvedPath;
    if (!bin) return;

    // -d prints the diff to stdout, -w applies it — one call, no race window.
    let diff: string;
    try {
      const { stdout } = await execFileP(
        bin,
        ["-d", "-w", ...extraArgs(), path],
        { signal: ctx.signal },
      );
      diff = stdout.trim();
    } catch (e: unknown) {
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `goimports failed: ${errMsg(e)}` },
        ],
      };
    }

    if (!diff) return; // no changes

    return {
      content: [
        ...event.content,
        { type: "text" as const, text: `goimports applied:\n\n${diff}` },
      ],
    };
  });
}
