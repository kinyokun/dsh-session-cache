import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/** 以浏览器模块加载器的形状执行 client.js，取回 factory 产物。 */
function loadBundle() {
  const code = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  let definition;
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value; } }, localStorage },
    localStorage,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(code, sandbox);
  assert.equal(definition.id, "dsh-session-cache");
  const exports = definition.factory(() => {
    throw new Error("the bundle must not require other packages");
  });
  return { exports, sandbox, store };
}

/** 可控时钟：setTimer 只在 advance 时触发。 */
function makeClock() {
  let now = 0;
  let sequence = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = sequence++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

function makeSessions() {
  const refs = [];
  return {
    refs,
    retain(id, options) {
      const reference = {
        id,
        options,
        released: false,
        release() {
          this.released = true;
        },
      };
      refs.push(reference);
      return reference;
    },
  };
}

function makeCache(overrides = {}) {
  const { exports } = loadBundle();
  const clock = makeClock();
  const sessions = makeSessions();
  const cache = new exports.__core.PinCache({
    retain: (id, options) => sessions.retain(id, options),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  });
  return { cache, clock, sessions };
}

test("首次打开会话时保活一次，重复打开不重复持有", () => {
  const { cache, sessions } = makeCache();
  cache.handleRetain("s1");
  cache.handleRetain("s1");
  assert.equal(sessions.refs.length, 1);
  assert.deepEqual([...cache.ids()], ["s1"]);
});

test("超过上限时按 LRU 释放最久未用的会话", () => {
  const { cache, clock, sessions } = makeCache({ max: 2 });
  cache.handleRetain("s1");
  clock.advance(10);
  cache.handleRetain("s2");
  clock.advance(10);
  cache.handleRetain("s1");
  clock.advance(10);
  cache.handleRetain("s3");
  assert.deepEqual([...cache.ids()], ["s1", "s3"]);
  const evicted = sessions.refs.find((r) => r.id === "s2");
  assert.equal(evicted.released, true);
  assert.equal(sessions.refs.find((r) => r.id === "s1").released, false);
});

test("空闲超过 idleMs 自动释放", () => {
  const { cache, clock, sessions } = makeCache({ idleMs: 5000 });
  cache.handleRetain("s1");
  clock.advance(4999);
  assert.equal(sessions.refs[0].released, false);
  clock.advance(1);
  assert.equal(sessions.refs[0].released, true);
  assert.deepEqual([...cache.ids()], []);
});

test("重复打开会刷新空闲计时", () => {
  const { cache, clock, sessions } = makeCache({ idleMs: 5000 });
  cache.handleRetain("s1");
  clock.advance(4000);
  cache.handleRetain("s1");
  clock.advance(4000);
  assert.equal(sessions.refs[0].released, false);
  clock.advance(1000);
  assert.equal(sessions.refs[0].released, true);
});

test("dispose 释放全部并停止响应后续打开", () => {
  const { cache, clock, sessions } = makeCache();
  cache.handleRetain("s1");
  cache.handleRetain("s2");
  cache.dispose();
  assert.deepEqual([...cache.ids()], []);
  assert.equal(sessions.refs.every((r) => r.released), true);
  assert.equal(clock.pending(), 0);
  cache.handleRetain("s3");
  assert.equal(sessions.refs.length, 2);
});

test("retain 抛错不会破坏缓存", () => {
  const errors = [];
  const { cache } = makeCache({
    retain: () => {
      throw new Error("unknown session");
    },
    onError: (error) => errors.push(error),
  });
  cache.handleRetain("ghost");
  assert.deepEqual([...cache.ids()], []);
  assert.equal(errors.length, 1);
});

test("默认值：5 个会话 / 24 小时空闲", () => {
  const { exports } = loadBundle();
  assert.equal(exports.__core.DEFAULTS.max, 5);
  assert.equal(exports.__core.DEFAULTS.idleMs, 24 * 60 * 60 * 1000);
});

test("configure 缩小上限时立即淘汰超额会话", () => {
  const { cache, clock, sessions } = makeCache({ max: 5 });
  for (const id of ["a", "b", "c", "d"]) {
    cache.handleRetain(id);
    clock.advance(10);
  }
  const applied = cache.configure({ max: 2 });
  assert.equal(applied.max, 2);
  assert.deepEqual([...cache.ids()], ["c", "d"]);
  assert.equal(sessions.refs.filter((r) => r.released).length, 2);
});

test("configure 修改空闲时间会重排现有计时", () => {
  const { cache, clock, sessions } = makeCache({ idleMs: 60000 });
  cache.handleRetain("a");
  cache.configure({ idleMs: 1000 });
  clock.advance(999);
  assert.equal(sessions.refs[0].released, false);
  clock.advance(1);
  assert.equal(sessions.refs[0].released, true);
});

test("控制台命令改配置并持久化到 localStorage", () => {
  const { exports, sandbox, store } = loadBundle();
  let cleanup;
  const sessions = makeSessions();
  const ctx = { sessions, effect: (callback) => { cleanup = callback(); } };
  const cache = exports.apply(ctx);
  const stats = sandbox.window.__DSH_SESSION_CACHE_CONFIGURE__({ max: 8, idleMs: 7200000 });
  assert.equal(stats.max, 8);
  assert.equal(stats.idleMs, 7200000);
  assert.deepEqual(JSON.parse(store.get("dsh.session-cache")), { max: 8, idleMs: 7200000 });
  cleanup();
  assert.equal(cache.stats().kept, 0);
});

test("持久化配置在下次 apply 时生效", () => {
  const first = loadBundle();
  const store = first.store;
  store.set("dsh.session-cache", JSON.stringify({ max: 2, idleMs: 5000 }));
  const sessions = makeSessions();
  const ctx = { sessions, effect: () => {} };
  const cache = first.exports.apply(ctx);
  assert.equal(cache.stats().max, 2);
  assert.equal(cache.stats().idleMs, 5000);
});

test("apply 包装 sessions.retain 并在清理时还原", () => {
  const { exports, sandbox } = loadBundle();
  const sessions = makeSessions();
  let effectCleanup;
  const ctx = {
    sessions,
    effect: (callback) => {
      effectCleanup = callback();
    },
  };
  sandbox.window.__DSH_SESSION_CACHE__ = { max: 2, idleMs: 60000 };
  const cache = exports.apply(ctx);
  const reference = sessions.retain("s9");
  assert.equal(sessions.refs.length, 2, "view retain + cache retain");
  assert.equal(reference.id, "s9");
  assert.deepEqual([...cache.ids()], ["s9"]);
  assert.equal(typeof sandbox.window.__DSH_SESSION_CACHE_STATS__, "function");
  effectCleanup();
  assert.equal(sessions.refs[0].released, false, "the view's own reference is not ours to release");
  assert.equal(sessions.refs[1].released, true, "cache pin released on cleanup");
  const after = sessions.retain("s10");
  assert.equal(sessions.refs.length, 3, "wrapping removed");
  assert.equal(after.released, false);
});
