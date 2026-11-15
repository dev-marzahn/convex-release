// Runs one predeploy check module in a process of its own:
//
//   node predeploy-runner.mjs <module>
//
// started by the host in predeploy.ts with an IPC channel and an environment
// holding only PATH. It loads the module, reports its protocol, runs the one
// phase the host asks for and reports the result; the host then kills it.
//
// Node built-ins only, and only type syntax Node can strip: the tests run this
// file as TypeScript, the images as the built predeploy-runner.mjs.
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

interface CheckModule {
  protocol?: unknown;
  collect?: (ctx: object) => unknown;
  check?: (ctx: object) => unknown;
}

type HostMessage =
  | { type: 'run'; phase: 'collect' | 'check'; ctx: Record<string, unknown> }
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string; code?: string };

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
let nextId = 0;
let module: CheckModule | undefined;
let started = false;

// First, and never removed: an IPC child stays alive only while a 'message'
// listener is attached. A module that awaits forever while it is imported
// would otherwise let this process exit, and the host would see an exit
// instead of a timeout.
process.on('message', (message: HostMessage) => {
  if (message.type === 'reply') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(Object.assign(new Error(message.error), message.code ? { code: message.code } : {}));
  } else if (message.type === 'run' && !started) {
    started = true;
    void run(message.phase, message.ctx);
  }
});

const send = (message: object) => process.send?.(message);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Sends the last message after the module's output is flushed, so the host logs it first. */
async function finish(message: { type: 'done'; value: unknown } | { type: 'threw'; message: string }) {
  await new Promise((r) => process.stdout.write('', r));
  await new Promise((r) => process.stderr.write('', r));
  send(message);
}

function query(target: { componentPath?: string; path: string }, args?: object): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'query', id, target, args: args ?? {} });
  });
}

function log(message: unknown) {
  send({ type: 'log', message: String(message) });
}

/** Only the runner holds the original value: the IPC channel's JSON would hide a Date or a function. */
function isPlainJson(value: unknown): boolean {
  try {
    return isDeepStrictEqual(value, JSON.parse(JSON.stringify(value)));
  } catch {
    // A bare function or symbol (stringify gives undefined), a BigInt, a circular value.
    return false;
  }
}

async function run(phase: 'collect' | 'check', ctx: Record<string, unknown>) {
  try {
    if (phase === 'collect') {
      const facts = (await module!.collect!(ctx)) ?? null;
      if (!isPlainJson(facts)) return await finish({ type: 'threw', message: "collect() returned a value that isn't plain JSON" });
      return await finish({ type: 'done', value: facts });
    }
    await finish({ type: 'done', value: await module!.check!({ ...ctx, query, log }) });
  } catch (err) {
    await finish({ type: 'threw', message: messageOf(err) });
  }
}

try {
  module = (await import(pathToFileURL(process.argv[2]!).href)) as CheckModule;
  send({ type: 'loaded', protocol: module.protocol });
} catch (err) {
  await finish({ type: 'threw', message: messageOf(err) });
}
