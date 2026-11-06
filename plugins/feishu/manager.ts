// The transport knows only an external command's JSON contract, never its owner key or model implementation.
import { execFile } from "node:child_process";

type Options = {
  command: string[];
  owner: string;
  signal: AbortSignal;
  send: (message: string, text: string) => Promise<void>;
};
export function createTextHandler({ command, owner, signal, send }: Options) {
  if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || !arg)) {
    throw new Error("飞书 manager 要写成命令参数数组");
  }
  let queue = Promise.resolve();
  const completed = new Set<string>();
  return (event: any) => {
    if (
      event?.sender_id !== owner ||
      event.sender_type !== "user" ||
      event.chat_type !== "p2p" ||
      event.message_type !== "text" ||
      typeof event.message_id !== "string" ||
      !event.message_id ||
      typeof event.chat_id !== "string" ||
      typeof event.content !== "string" ||
      !event.content.trim() ||
      event.content.length > 4000
    )
      return Promise.resolve();
    const work = queue.then(async () => {
      if (signal.aborted || completed.has(event.message_id)) return;
      const text = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          command[0],
          command.slice(1),
          { signal, timeout: 180_000, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (error) return reject(new Error("管理者执行失败，请检查管理者配置和日志"));
            try {
              const reply = JSON.parse(stdout);
              if (typeof reply.text !== "string" || !reply.text.trim() || reply.text.length > 4000) {
                throw new Error("管理者回复为空或超过 4000 字");
              }
              resolve(reply.text);
            } catch (error) {
              reject(error);
            }
          },
        );
        child.stdin!.on("error", reject);
        child.stdin!.end(
          JSON.stringify({ id: event.message_id, sender: event.sender_id, chat: event.chat_id, text: event.content }),
        );
      });
      await send(event.message_id, text);
      completed.add(event.message_id);
    });
    queue = work.catch(() => {});
    return work;
  };
}
