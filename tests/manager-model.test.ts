// Failure cases: model calls use an agent CLI or the hub credential; tool call IDs disappear between turns;
// invalid API output is treated as an answer; provider error bodies expose credentials in logs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModel } from "../examples/manager/model.ts";

test("the manager calls its own configured model API and preserves structured tool calls", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const model = createModel(
    { baseUrl: "https://model.example/v1/", model: "manager-model", apiKeyEnv: "MANAGER_KEY" },
    async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function: { name: "get_state", arguments: "{}" } }],
              },
            },
          ],
        }),
      );
    },
    { MANAGER_KEY: "MODEL_SECRET", OWNER_KEY: "OWNER_SECRET" },
  );
  const reply = await model([{ role: "user", content: "进度如何" }], []);
  assert.equal(calls[0].url, "https://model.example/v1/chat/completions");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer MODEL_SECRET");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "manager-model");
  assert.ok(!String(calls[0].init.body).includes("OWNER_SECRET"));
  assert.equal(reply.tool_calls![0].id, "call_1");
});

test("API failures do not print provider bodies and missing keys fail before a request", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return new Response("SECRET echoed by upstream", { status: 401 });
  };
  assert.throws(
    () => createModel({ baseUrl: "https://model.example/v1", model: "m", apiKeyEnv: "ABSENT" }, request, {}),
    /ABSENT/,
  );
  const model = createModel({ baseUrl: "https://model.example/v1", model: "m", apiKeyEnv: "KEY" }, request, {
    KEY: "SECRET",
  });
  await assert.rejects(
    model([{ role: "user", content: "hi" }]),
    (error) => String(error).includes("401") && !String(error).includes("SECRET"),
  );
  assert.equal(calls, 1);
});

test("an incomplete model reply cannot be recorded as a completed answer", async () => {
  const model = createModel(
    { baseUrl: "https://model.example/v1", model: "m", apiKeyEnv: "KEY" },
    async () =>
      new Response(
        JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "半句话" } }] }),
      ),
    { KEY: "secret" },
  );
  await assert.rejects(model([{ role: "user", content: "hi" }]), /完整/);
});

test("plain API replies may omit tool calls or mark them null", async () => {
  const model = createModel(
    { baseUrl: "https://model.example/v1", model: "m", apiKeyEnv: "KEY" },
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "你好", tool_calls: null } }],
        }),
      ),
    { KEY: "secret" },
  );
  assert.equal((await model([{ role: "user", content: "hi" }])).content, "你好");
});
