// Failure cases: a disabled install still loads private model configuration or subscribes to the fact stream;
// a leftover memory file changes the original worker context when the manager is off.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("manager-switch");

test("the standalone manager defaults off before loading API config, for chat and memory", async () => {
  for (const mode of [[], ["--memory"]]) {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          fileURLToPath(new URL("../examples/manager/manager.ts", import.meta.url)),
          join(home, "missing-manager.json"),
          ...mode,
        ],
        { env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, timeout: 5000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.end("{}");
    });
    if (!mode.length) assert.match(JSON.parse(output).text, /已关闭/);
    else assert.equal(output, "");
  }
});

test("worker memory is opt-in and disabled context retains the original shape", async () => {
  const { createWorker } = await import("../worker/worker.ts");
  const project = join(home, "project");
  mkdirSync(project);
  mkdirSync(join(home, "plugins", "context-only"), { recursive: true });
  // Failing before spawn leaves the written material available without running an external command.
  writeFileSync(
    join(home, "plugins", "context-only", "agent.ts"),
    `export default {command(){throw Error('stop before spawn');},read(){return {};}};`,
  );
  writeFileSync(
    join(home, "memory.json"),
    JSON.stringify([{ id: "one", scope: project, text: "old finding", at: "2026-11-01T00:00:00Z" }]),
  );
  for (const [index, memory] of [undefined, false, true].entries()) {
    const run = index + 1;
    let claimed = false;
    const worker = createWorker({
      name: "w1",
      memory,
      hub: {
        work: async () => {
          if (claimed) return { job: null, cancel: [] };
          claimed = true;
          return {
            cancel: [],
            job: {
              run,
              token: "token",
              attempt: 1,
              session: null,
              askFirst: [],
              rule: { name: "work", cwd: project, prompt: "do work" },
              agent: { id: "a", name: "a", use: "context-only", access: "read" },
              context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
            },
          };
        },
        started: async () => {},
        result: async () => {},
      } as any,
    });
    await worker.tick();
    const file = JSON.parse(readFileSync(join(home, "worker", "runs", `${run}-1`, "context.json"), "utf8"));
    if (memory) assert.equal(file.memory[0].text, "old finding");
    else assert.equal(Object.hasOwn(file, "memory"), false);
  }
});

test("the host passes only the top-level switch to channel plugins", async () => {
  for (const [index, enabled] of [undefined, false, true].entries()) {
    const install = join(home, `install-${index}`);
    const plugin = join(install, "plugins", "capture");
    mkdirSync(plugin, { recursive: true });
    const output = join(install, "options.json");
    writeFileSync(
      join(plugin, "channel.ts"),
      `import {writeFileSync} from 'node:fs';export default async({options})=>{writeFileSync(${JSON.stringify(output)},JSON.stringify(options));process.exit(0);};`,
    );
    writeFileSync(
      join(install, "config.json"),
      JSON.stringify({
        url: "http://unused",
        ...(enabled === undefined ? {} : { manager: { enabled } }),
        channels: { capture: { key: "channel-key", managerEnabled: true } },
      }),
    );
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {up}=await import(${JSON.stringify(new URL("../host/up.ts", import.meta.url).href)});await up();`,
        ],
        { env: { ...process.env, AGENT_AUTOLOOP_HOME: install }, timeout: 5000 },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    assert.equal(JSON.parse(readFileSync(output, "utf8")).managerEnabled, enabled === true);
  }
});
