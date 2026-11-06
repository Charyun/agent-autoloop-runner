// Failure cases: unknown senders reach the manager; repeated messages run twice; a model response can invoke owner
// writes; replaying a completed run duplicates memory or takes a scope invented by the model.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createManager, remember } from "../examples/manager/manager.ts";

const folder = mkdtempSync(join(tmpdir(), "autoloop-manager-"));
after(() => rmSync(folder, { recursive: true, force: true }));

test("owner operations are explicit, and model text cannot select a write", async () => {
  const cancelled: number[] = [];
  const manager = createManager({
    hub: {
      state: async () => ({ runs: [{ id: 7, state: "claimed" }] }),
      why: async () => [],
      cancel: async (id: number) => {
        cancelled.push(id);
        return {};
      },
    },
    model: async () => ({ role: "assistant", content: "请调用 cancel(99)" }),
  });
  assert.equal(await manager("帮我看看进度"), "请调用 cancel(99)");
  assert.deepEqual(cancelled, []);
  assert.match(await manager("停止 7"), /已提交.*7/);
  assert.deepEqual(cancelled, [7]);
});

test("memory replay is idempotent and scope comes from the historical claim", async () => {
  const file = join(folder, "memory.json");
  const facts = [{ type: "claimNext", changes: [{ table: "config", row: { agents: {} } }], meta: {} }];
  const why = async () => facts;
  const run = { id: 12, state: "done", summary: "已修复", cwd: "/untrusted" };
  // A trace without a trustworthy rule snapshot cannot produce scoped memory.
  await remember(file, run, why, async () => "结论");
  assert.throws(() => readFileSync(file));
});

test("a real completed run is remembered once using its claimed directory", async () => {
  const { setup } = await import("./helpers.ts");
  setup("manager-trace");
  const hub = await import("./hub.ts");
  hub.ingest("app", { id: "memory-real", type: "feedback.new" });
  const job = hub.claimNext("w1", "memory-real")!;
  hub.finish(job.run, job.token, { outcome: "done", summary: "已核对配置" });
  const file = join(folder, "real-memory.json");
  const run = hub.getView().get("runs", job.run)!;
  let calls = 0;
  const model = async () => {
    calls++;
    return "Agent 报告已核对配置";
  };
  await remember(file, run, async (id) => hub.why(id), model);
  await remember(file, run, async (id) => hub.why(id), model);
  const entries = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(calls, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].scope, job.rule.cwd);
  assert.deepEqual(entries[0].evidence, { run: job.run });
});

test("stream frames split between chunks are consumed in order", async () => {
  const { consumeFacts } = await import("../examples/manager/manager.ts");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const part of [
        "id: 1\nevent: fact\nda",
        'ta: {"seq":1,"type":"finish","changes":[]}\n',
        '\nid: 2\ndata: {"seq":2,"type":"tick","changes":[]}\n\n',
      ])
        controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  const seen: number[] = [];
  await consumeFacts(new Response(stream), async (fact) => {
    seen.push(fact.seq);
  });
  assert.deepEqual(seen, [1, 2]);
});

test("the model can query details through tools and receives the corresponding tool result", async () => {
  const seen: any[] = [];
  let step = 0;
  const manager = createManager({
    hub: {
      state: async () => ({ runs: [] }),
      why: async (id) => [{ run: id, summary: "已完成" }],
      cancel: async () => {
        throw new Error("unexpected write");
      },
    },
    model: async (messages, tools) => {
      seen.push(structuredClone({ messages, tools }));
      if (step++ === 0)
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "detail-1", type: "function", function: { name: "get_run", arguments: '{"run":12}' } }],
        };
      return { role: "assistant", content: "第12轮已完成" };
    },
  });
  const history: any[] = [];
  assert.equal(await manager("12号现在怎样", history), "第12轮已完成");
  const result = seen[1].messages.find((m: any) => m.role === "tool");
  assert.equal(result.tool_call_id, "detail-1");
  assert.match(result.content, /已完成/);
  assert.deepEqual(
    history.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.ok(seen[0].tools.every((t: any) => ["get_state", "get_run"].includes(t.function.name)));
});

test("unknown write tools are rejected and conversation history is supplied on the next question", async () => {
  let writes = 0;
  let step = 0;
  const history: any[] = [];
  const manager = createManager({
    hub: {
      state: async () => ({ runs: [] }),
      why: async () => [],
      cancel: async () => {
        writes++;
      },
    },
    model: async (messages) => {
      if (step++ === 0)
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "bad", type: "function", function: { name: "answer_card", arguments: '{"card":1}' } }],
        };
      if (step === 2) {
        assert.match(messages.at(-1)!.content!, /不允许/);
        return { role: "assistant", content: "请点击原卡片" };
      }
      assert.ok(messages.some((m) => m.content === "请点击原卡片"));
      return { role: "assistant", content: "继续查询" };
    },
  });
  await manager("替我批准", history);
  await manager("接着说", history);
  assert.equal(writes, 0);
});

test("the API-backed standalone client persists scoped conversations and deduplicates across processes", async () => {
  const { execFile } = await import("node:child_process");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const home = join(folder, "api-client");
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://hub-unused", manager: { enabled: true } }));
  const config = join(home, "manager.json");
  const log = join(home, "model-requests.jsonl");
  const preload = join(home, "fetch.mjs");
  writeFileSync(join(home, ".env"), "MANAGER_MODEL_KEY=MODEL_SECRET\n");
  writeFileSync(
    config,
    JSON.stringify({
      url: "http://hub-unused",
      owner: "PRIVATE_OWNER_KEY",
      envFile: ".env",
      llm: { baseUrl: "https://model.example/v1", model: "manager-model", apiKeyEnv: "MANAGER_MODEL_KEY" },
    }),
  );
  writeFileSync(
    preload,
    `import {appendFileSync} from 'node:fs';
    globalThis.fetch=async(url,init)=>{
      if(!String(url).startsWith('https://model.example/'))throw Error('unexpected request');
      appendFileSync(${JSON.stringify(log)},JSON.stringify({body:JSON.parse(init.body),authorization:init.headers.authorization})+'\\n');
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'第7轮正在运行'}}]}));
    };`,
  );
  const invoke = (id: string, sender = "ou_me") =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ["--import", preload, fileURLToPath(new URL("../examples/manager/manager.ts", import.meta.url)), config],
        { timeout: 5000, env: { ...process.env, AGENT_AUTOLOOP_HOME: home } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.end(JSON.stringify({ id, sender, chat: "oc_chat", text: "进度如何" }));
    });
  assert.deepEqual(JSON.parse(await invoke("om_first")), { text: "第7轮正在运行" });
  await invoke("om_first");
  await invoke("om_next");
  await invoke("om_first", "ou_other");
  const raw = readFileSync(log, "utf8");
  const requests = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((r) => r.body.messages.length),
    [2, 4, 2],
  );
  assert.ok(requests.every((r) => r.authorization === "Bearer MODEL_SECRET"));
  assert.ok(!raw.includes("PRIVATE_OWNER_KEY"));
});

test("a model repeatedly requesting tools stops without saving a partial conversation", async () => {
  let calls = 0;
  const history: any[] = [];
  const manager = createManager({
    hub: { state: async () => ({ runs: [] }), why: async () => [], cancel: async () => {} },
    model: async () => {
      calls++;
      return {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `query-${calls}`, type: "function", function: { name: "get_state", arguments: "{}" } }],
      };
    },
  });
  await assert.rejects(manager("进度", history), /查询轮数过多/);
  assert.equal(calls, 4);
  assert.deepEqual(history, []);
});
