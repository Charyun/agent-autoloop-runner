// What a run may be handed over from earlier ones in the same folder: a plain file beside the install, written by
// whoever distils finished runs (the manager, outside this repository). It is read here, before a job starts, and its
// entries go into the context file as material like the rest: never into the prompt, never across folders, and only
// while no later finding has pushed them down. The file is written by another process, so it may be missing or caught
// half-written; both mean "nothing remembered", not a job that can't start.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "../host/home.ts";

export type Memory = {
  id: string;
  scope: string;
  text: string;
  at: string;
  evidence?: { run: number };
  superseded_by?: string;
};

/** How many of a folder's memories one run is handed. */
const TOP = 5;
const FILE = path.join(HOME, "memory.json");

/** Rules write folders as the owner typed them (`~/code/app`), so both ends meet on the same path. */
const scopeOf = (folder: string) => path.resolve(folder.replace(/^~(?=\/|$)/, homedir()));

/** The folder's memories, newest first, within the limit. */
export function recall(folder: string): Memory[] {
  let all: unknown;
  try {
    all = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(all)) return [];
  const scope = scopeOf(folder);
  return all
    .filter((entry): entry is Memory => {
      const one = entry as Partial<Memory> | null;
      return (
        !!one &&
        typeof one === "object" &&
        typeof one.text === "string" &&
        typeof one.scope === "string" &&
        typeof one.id === "string" &&
        typeof one.at === "string" &&
        Number.isFinite(Date.parse(one.at)) &&
        !one.superseded_by
      );
    })
    .filter((entry) => scopeOf(entry.scope) === scope)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, TOP);
}
