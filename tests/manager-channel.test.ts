// Failure cases: bot/group/other-user messages reach owner operations; duplicate deliveries repeat a model call;
// a slow manager holds up card clicks; CLI text is wrongly decoded as JSON.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createTextHandler } from "../plugins/feishu/manager.ts";
const folder = mkdtempSync(join(tmpdir(), "autoloop-manager-channel-"));
after(() => rmSync(folder, { recursive: true, force: true }));

test("only the configured user's private text reaches the manager, and duplicates reuse the reply", async () => {
  const file = join(folder, "calls");
  const script = join(folder, "manager.cjs");
  writeFileSync(
    script,
    `let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
    require('node:fs').appendFileSync(${JSON.stringify(file)}, input+'\\n');
    console.log(JSON.stringify({text:'管理者的回复'}));});`,
  );
  const sent: unknown[] = [];
  const handle = createTextHandler({
    command: [process.execPath, script],
    owner: "ou_me",
    signal: new AbortController().signal,
    send: async (...args) => {
      sent.push(args);
    },
  });
  const event = {
    sender_id: "ou_me",
    sender_type: "user",
    chat_type: "p2p",
    chat_id: "oc_me",
    message_type: "text",
    message_id: "om_text",
    content: '{"text":"这是用户原文"}',
  };
  for (const over of [
    { sender_id: "ou_other" },
    { sender_type: "app" },
    { chat_type: "group" },
    { message_type: "interactive" },
  ]) {
    await handle({ ...event, ...over });
  }
  assert.equal(sent.length, 0);
  await Promise.all([handle(event), handle(event)]);
  const calls = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, event.content);
  assert.deepEqual(sent, [["om_text", "管理者的回复"]]);
});

test("card callbacks keep working beside the manager's text listener", { timeout: 5000 }, async () => {
  const { default: feishu } = await import("../plugins/feishu/channel.ts");
  const lark = join(folder, "lark.cjs");
  const manager = join(folder, "reply.cjs");
  const sentFile = join(folder, "sent.json");
  writeFileSync(
    manager,
    `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({text:'当前有一轮在运行'})));`,
  );
  writeFileSync(
    lark,
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='event') {
  if(args[2]==='card.action.trigger') console.log(JSON.stringify({action_value:JSON.stringify({card:5,choice:1}),operator_id:'ou_me',message_id:'om_card'}));
  else console.log(JSON.stringify({sender_id:'ou_me',sender_type:'user',chat_type:'p2p',chat_id:'oc_me',message_type:'text',message_id:'om_12345678901234567890123456789012',content:'进度如何'}));
  process.stdin.resume();
} else {let body='';process.stdin.on('data',s=>body+=s);process.stdin.on('end',()=>{
  require('node:fs').appendFileSync(${JSON.stringify(sentFile)},JSON.stringify({args,body})+'\\n');
  console.log(JSON.stringify({ok:true,data:{message_id:'om_reply'}}));});}
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  let answered = false;
  const running = feishu({
    options: { user: "ou_me", lark, managerEnabled: true, manager: [process.execPath, manager] },
    log: () => {},
    signal: stop.signal,
    hub: {
      async nextCard() {
        await new Promise((r) => setTimeout(r, 20));
        if (
          answered &&
          (() => {
            try {
              return readFileSync(sentFile, "utf8").includes("--idempotency-key");
            } catch {
              return false;
            }
          })()
        )
          stop.abort();
        return { card: null };
      },
      async answer(id: number, body: any) {
        assert.equal(id, 5);
        assert.equal(body.choice, 1);
        answered = true;
        return { changed: true };
      },
    } as any,
  });
  try {
    await running;
  } finally {
    stop.abort();
  }
  assert.ok(answered);
  const sent = readFileSync(sentFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const call of sent) {
    const key = call.args[call.args.indexOf("--idempotency-key") + 1];
    assert.ok(key.length <= 50, "the platform caps idempotency keys at 50 characters");
  }
  assert.ok(sent.some((call) => call.args.includes("text") && JSON.parse(call.body).text === "当前有一轮在运行"));
});

test(
  "disabled and omitted manager switches preserve card delivery without starting text or model commands",
  { timeout: 5000 },
  async () => {
    const { default: feishu } = await import("../plugins/feishu/channel.ts");
    for (const managerEnabled of [undefined, false]) {
      const calls = join(folder, `disabled-${managerEnabled}.jsonl`);
      const lark = join(folder, `disabled-${managerEnabled}.cjs`);
      writeFileSync(
        lark,
        `#!${process.execPath}
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv[2]==='event'){console.log(JSON.stringify({action_value:JSON.stringify({card:5,choice:1}),operator_id:'ou_me',message_id:'om_card'}));process.stdin.resume();}
else{process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,data:{message_id:'om_card'}})));}
`,
        { mode: 0o755 },
      );
      const stop = new AbortController();
      let delivered = false,
        answered = false,
        issued = false;
      const timeout = setTimeout(() => stop.abort(), 4000);
      try {
        await feishu({
          options: { user: "ou_me", lark, managerEnabled, manager: 42 },
          signal: stop.signal,
          log: () => {},
          hub: {
            async nextCard() {
              if (!issued) {
                issued = true;
                return {
                  card: {
                    id: 5,
                    version: 1,
                    ref: null,
                    kind: "ask",
                    state: "open",
                    title: "继续吗",
                    text: "",
                    options: ["否", "是"],
                    recommend: 1,
                    choice: null,
                    answer: null,
                    result: null,
                    link: null,
                  },
                };
              }
              await new Promise((r) => setTimeout(r, 20));
              if (delivered && answered) stop.abort();
              return { card: null };
            },
            async delivered() {
              delivered = true;
            },
            async failed() {
              assert.fail("card delivery failed");
            },
            async answer() {
              answered = true;
              return { changed: true };
            },
          } as any,
        });
      } finally {
        clearTimeout(timeout);
        stop.abort();
      }
      assert.ok(delivered && answered);
      const args = readFileSync(calls, "utf8");
      assert.ok(args.includes("card.action.trigger"));
      assert.ok(!args.includes("im.message.receive_v1"));
    }
  },
);
