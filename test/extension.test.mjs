import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.resolve(__dirname, "..", "goimports.ts");

async function loadExtension() {
  return import(pathToFileURL(extPath).href);
}

function makeStubPi() {
  const handlers = new Map();
  const entries = [];
  const pi = {
    on(event, handler) {
      (handlers.get(event) ?? handlers.set(event, []).get(event)).push(handler);
    },
    registerEntryRenderer(_type, _renderer) {},
    appendEntry(type, data) {
      entries.push({ type, data });
    },
  };
  return { pi, handlers, entries };
}

function makeCtx() {
  const notifications = [];
  return {
    notifications,
    ctx: {
      hasUI: true,
      signal: undefined,
      cwd: process.cwd(),
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    },
  };
}

function hasBinary(name) {
  try {
    execFileSync("which", [name]);
    return true;
  } catch {
    return false;
  }
}

const goBinDir = path.join(os.homedir(), "go", "bin");
const goimportsInGoBin = fs.existsSync(path.join(goBinDir, "goimports"));
const goimportsAvailable = hasBinary("goimports") || goimportsInGoBin;
const goAvailable = hasBinary("go");

// A fake write tool_result event for a .go file.
function writeEvent(filePath) {
  return {
    type: "tool_result",
    toolName: "write",
    toolCallId: "test",
    input: { path: filePath },
    content: [{ type: "text", text: "ok" }],
    isError: false,
  };
}

const UNFORMATTED = 'package x\n\nfunc main(){fmt.Println("hi")}\n';

test("goimports extension", async (t) => {
  if (!goimportsAvailable || !goAvailable) {
    t.skip("goimports and go must be installed");
    return;
  }

  const mod = await loadExtension();
  const { pi, handlers, entries } = makeStubPi();
  await mod.default(pi);

  const savedPath = process.env.PATH;
  t.afterEach(() => {
    process.env.PATH = savedPath;
  });

  await t.test("on PATH: resolves, no notify, rule appended, diff injected", async () => {
    process.env.PATH = savedPath;
    const { notifications, ctx } = makeCtx();
    await handlers.get("session_start")[0]({}, ctx);
    assert.equal(notifications.length, 0, "no notify when goimports is on PATH");

    const bres = await handlers.get("before_agent_start")[0](
      { systemPrompt: "BASE" },
      { ...ctx, hasUI: false },
    );
    assert.match(bres?.systemPrompt ?? "", /Go import handling/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gi-"));
    const file = path.join(dir, "x.go");
    fs.writeFileSync(file, UNFORMATTED);
    entries.length = 0;
    try {
      const res = await handlers.get("tool_result")[0](writeEvent(file), ctx);
      const diff = res?.content?.find((c) => c.text?.startsWith("goimports applied"));
      assert.ok(diff, "diff appended to tool result");
      // Model-facing diff is a standard unified diff (familiar format).
      assert.match(diff.text, /--- [^\n]+\n\+\+\+ [^\n]+\n@@ /, "unified diff headers");
      assert.match(diff.text, /import "fmt"/);
      assert.match(
        fs.readFileSync(file, "utf-8"),
        /import "fmt"/,
        "file applied",
      );
      assert.equal(entries.length, 1, "transcript entry appended");
      assert.equal(entries[0].type, "goimports");
      assert.match(
        entries[0].data.summary,
        /^goimports \S+ \+\d+ -\d+$/,
        "entry summary reflects the diff",
      );
      // Entry diff is the line-numbered display format (for renderDiff),
      // distinct from the unified diff sent to the model.
      assert.match(entries[0].data.diff, /^\+\d+ /m, "line-numbered display diff");
      assert.notEqual(entries[0].data.diff, diff.text.slice("goimports applied:\n\n".length));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("no diff: no transcript entry", async () => {
    process.env.PATH = savedPath;
    const { ctx } = makeCtx();
    await handlers.get("session_start")[0]({}, ctx);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gi-"));
    const file = path.join(dir, "x.go");
    // Already formatted + imports resolved — goimports is a no-op.
    const clean = 'package x\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n';
    fs.writeFileSync(file, clean);
    entries.length = 0;
    try {
      const res = await handlers.get("tool_result")[0](writeEvent(file), ctx);
      assert.equal(res, undefined, "no content added when no diff");
      assert.equal(entries.length, 0, "no entry appended when no diff");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("headless (hasUI=false): no transcript entry", async () => {
    process.env.PATH = savedPath;
    const { ctx } = makeCtx();
    await handlers.get("session_start")[0]({}, ctx);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gi-"));
    const file = path.join(dir, "x.go");
    fs.writeFileSync(file, UNFORMATTED);
    entries.length = 0;
    try {
      await handlers.get("tool_result")[0](
        writeEvent(file),
        { ...ctx, hasUI: false },
      );
      assert.equal(entries.length, 0, "no entry in headless mode");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("off-PATH: found via ~/go/bin fallback, diff injected", async () => {
    process.env.PATH = savedPath
      .split(path.delimiter)
      .filter((d) => d !== goBinDir)
      .join(path.delimiter);
    const { notifications, ctx } = makeCtx();
    await handlers.get("session_start")[0]({}, ctx);
    assert.equal(notifications.length, 0, "found via fallback, no notify");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gi-"));
    const file = path.join(dir, "x.go");
    fs.writeFileSync(file, UNFORMATTED);
    try {
      const res = await handlers.get("tool_result")[0](writeEvent(file), ctx);
      assert.ok(
        res?.content?.find((c) => c.text?.startsWith("goimports applied")),
        "diff appended via resolved absolute path",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("go off-PATH: notify surfaces the go env error", async () => {
    process.env.PATH = "/nonexistent";
    const { notifications, ctx } = makeCtx();
    await handlers.get("session_start")[0]({}, ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /cannot resolve goimports/);
    assert.match(notifications[0].message, /ENOENT/);
  });

  await t.test("goimports on PATH but go missing: clean goimports stderr (no 'Command failed' prefix)", async () => {
    process.env.PATH = goBinDir; // goimports present, go absent
    const { notifications, ctx } = makeCtx();
    await handlers.get("session_start")[0]({}, ctx);
    assert.equal(notifications.length, 1);
    const msg = notifications[0].message;
    assert.match(msg, /cannot resolve goimports/);
    assert.doesNotMatch(
      msg,
      /Command failed/,
      "should surface clean goimports stderr, not the 'Command failed' wrapper",
    );
    assert.match(msg, /go command required/);
  });
});
