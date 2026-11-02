// Runs one untrusted bot inside a QuickJS (WebAssembly) VM.
//
// Security model: the VM is the boundary. It has no network, filesystem, clock
// or host objects — only what this file hands it (a JSON view string in, a JSON
// command string out). Limits are enforced by the runtime, not by a deny-list:
//   - memory  (setMemoryLimit)
//   - stack   (setMaxStackSize)
//   - "fuel"  (setInterruptHandler call counter, per tick and per match)
// Fuel counts interpreter work, not wall-clock time, so the same bot gets the
// same verdict on a fast and on a slow machine.
//
// Anything the bot does inside the VM (even tampering with its own globals) can
// only affect its own commands; the host re-validates every command it gets back.

import { newQuickJSWASMModule } from "quickjs-emscripten";
import { createApi } from "../engine/engine.js";
import { RULES } from "../engine/constants.js";

export const DEFAULT_LIMITS = {
  memoryBytes: 16 * 1024 * 1024,
  // Must stay well below the host's native WebAssembly stack: at 512 KB a deep
  // recursion overflowed the HOST before QuickJS caught it (crashing the runner,
  // which would have voided the match instead of scoring a loss). 192 KB keeps
  // the overflow inside the VM with margin across Node versions/platforms.
  stackBytes: 192 * 1024,
  fuelPerTick: 100, // interrupt-handler calls (each ≈ a few thousand VM ops)
  fuelPerMatch: 60000,
  maxOutputChars: 64 * 1024,
  maxCodeChars: 64 * 1024,
};

// Turn ES-module / CommonJS bot source into a plain script that registers `loop`.
export function toScript(code) {
  return (
    code
      .replace(/^﻿/, "")
      .replace(/\bexport\s*\{[^}]*\}\s*;?/g, "")
      .replace(/\bexport\s+default\s+/g, "module.exports.loop = ")
      .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g, "") +
    "\n;__arena.setLoop(" +
    "typeof loop === 'function' ? loop :" +
    " (module.exports && typeof module.exports.loop === 'function') ? module.exports.loop : null);\n"
  );
}

const prelude = (seed) => `
var module = { exports: {} };
var exports = module.exports;
var __arena = (function () {
  var parse = JSON.parse, stringify = JSON.stringify;
  var CAP = ${RULES.MAX_COMMANDS_PER_TICK};
  var cmds = [];
  var loopFn = null;
  var map = null;
  function push(c) { if (cmds.length < CAP) cmds.push(c); }
  var api = Object.freeze({
    spawnCreep: function () { push({ op: "spawn" }); },
    move: function (id, dir) { push({ op: "move", id: id, dir: dir }); },
    moveTo: function (id, x, y) { push({ op: "moveTo", id: id, x: x, y: y }); },
    harvest: function (id, source) { push({ op: "harvest", id: id, source: source }); },
    transfer: function (id) { push({ op: "transfer", id: id }); },
    build: function (id, kind, x, y) { push({ op: "build", id: id, kind: kind, x: x, y: y }); },
    attack: function (id, target) { push({ op: "attack", id: id, target: target }); }
  });
  return {
    setLoop: function (fn) { loopFn = fn; },
    hasLoop: function () { return typeof loopFn === "function"; },
    setMap: function (s) { map = parse(s); },
    run: function (viewStr) {
      cmds = [];
      var view = parse(viewStr);
      view.map = map;
      loopFn(view, api);
      return stringify(cmds);
    }
  };
})();
(function () {
  var s = (${seed >>> 0}) || 0x9e3779b9;
  Math.random = function () {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  var D = function () { throw new Error("Date is disabled in the arena"); };
  D.now = function () { return 0; };
  globalThis.Date = D;
})();
`;

// Classify a QuickJS error into a model-error kind (all of them forfeit).
function classify(err) {
  const msg = String(err?.message || err || "");
  if (/interrupted/.test(msg)) return "fuel_exhausted";
  if (/out of memory/.test(msg)) return "out_of_memory";
  if (/stack overflow/.test(msg)) return "stack_overflow";
  if (err?.name === "SyntaxError") return "syntax_error";
  return "runtime_error";
}

// Host-side re-validation: rebuild commands through the engine's own API guards.
const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 32;
export function sanitizeCommands(raw) {
  const api = createApi(null, 0);
  if (!Array.isArray(raw)) return api.cmds;
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    switch (c.op) {
      case "spawn":
        api.spawnCreep();
        break;
      case "move":
        if (isId(c.id)) api.move(c.id, c.dir);
        break;
      case "moveTo":
        if (isId(c.id)) api.moveTo(c.id, c.x, c.y);
        break;
      case "harvest":
        if (isId(c.id) && isId(c.source)) api.harvest(c.id, c.source);
        break;
      case "transfer":
        if (isId(c.id)) api.transfer(c.id);
        break;
      case "build":
        if (isId(c.id)) api.build(c.id, c.kind, c.x, c.y);
        break;
      case "attack":
        if (isId(c.id) && isId(c.target)) api.attack(c.id, c.target);
        break;
      default:
        break;
    }
  }
  return api.cmds;
}

/**
 * Create a sandboxed bot. Returns { ok:true, tick(view), stats(), dispose() }
 * or { ok:false, error:{ kind, message } } if the code cannot even load.
 */
export async function createBotSandbox(code, { seed = 1, limits = {}, map = null } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (typeof code !== "string" || code.trim() === "")
    return { ok: false, error: { kind: "no_code", message: "Empty bot source." } };
  if (code.length > L.maxCodeChars)
    return { ok: false, error: { kind: "too_large", message: "Bot source exceeds size limit." } };

  // A fresh WebAssembly module per bot: if one bot ever corrupts its module, the
  // opponent's VM (and later matches) are unaffected.
  const QuickJS = await newQuickJSWASMModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(L.memoryBytes);
  runtime.setMaxStackSize(L.stackBytes);
  let tickFuel = 0;
  let matchFuel = 0;
  runtime.setInterruptHandler(() => {
    tickFuel++;
    matchFuel++;
    return tickFuel > L.fuelPerTick || matchFuel > L.fuelPerMatch;
  });
  const vm = runtime.newContext();
  let disposed = false;
  let tainted = false; // a host-level exception escaped the VM; module is suspect
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (tainted) return; // don't touch a possibly corrupted module; let GC drop it
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      /* best effort */
    }
  };

  const evalOrError = (src, file) => {
    if (tainted) return { error: { kind: "runtime_error", message: "Sandbox is no longer usable." } };
    try {
      const r = vm.evalCode(src, file);
      if (r.error) {
        const err = vm.dump(r.error);
        r.error.dispose();
        return { error: { kind: classify(err), message: String(err?.message || err).slice(0, 300) } };
      }
      const value = vm.dump(r.value);
      r.value.dispose();
      return { value };
    } catch (e) {
      // Last line of defence: anything the bot triggers that escapes the VM is
      // still the bot's fault — a model error (loss), never a runner crash.
      tainted = true;
      const kind = e instanceof RangeError ? "stack_overflow" : "runtime_error";
      return { error: { kind, message: `Escaped VM: ${String(e?.message || e).slice(0, 200)}` } };
    }
  };

  const pre = evalOrError(prelude(seed), "prelude.js");
  if (pre.error) {
    dispose();
    return { ok: false, error: { kind: "internal", message: pre.error.message } };
  }

  tickFuel = 0;
  const loaded = evalOrError(toScript(code), "bot.js");
  if (loaded.error) {
    dispose();
    return { ok: false, error: loaded.error };
  }
  const has = evalOrError("__arena.hasLoop()", "check.js");
  if (has.error || has.value !== true) {
    dispose();
    return { ok: false, error: { kind: "no_loop", message: "Bot does not export a loop(state, api) function." } };
  }

  if (map) {
    const handle = vm.newString(JSON.stringify(map));
    vm.setProp(vm.global, "__mapStr", handle);
    handle.dispose();
    const m = evalOrError("__arena.setMap(__mapStr)", "map.js");
    if (m.error) {
      dispose();
      return { ok: false, error: { kind: "internal", message: m.error.message } };
    }
  }

  return {
    ok: true,
    tick(view) {
      if (disposed) return { error: { kind: "internal", message: "Sandbox disposed." } };
      tickFuel = 0;
      // The static map is sent once at creation; omit it from every tick.
      const { map: _omit, ...rest } = view;
      const handle = vm.newString(JSON.stringify(rest));
      vm.setProp(vm.global, "__viewStr", handle);
      handle.dispose();
      const r = evalOrError("__arena.run(__viewStr)", "tick.js");
      if (r.error) return { error: r.error };
      if (typeof r.value !== "string" || r.value.length > L.maxOutputChars)
        return { error: { kind: "bad_output", message: "Bot produced invalid or oversized output." } };
      let raw;
      try {
        raw = JSON.parse(r.value);
      } catch {
        return { error: { kind: "bad_output", message: "Bot output is not valid JSON." } };
      }
      return { cmds: sanitizeCommands(raw) };
    },
    stats: () => ({ matchFuel }),
    dispose,
  };
}
