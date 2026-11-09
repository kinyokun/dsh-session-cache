window.__ModuleLoader__.load({
	id: "dsh-session-cache",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		//#region lib/types/cache.js
		/**
		 * 最近会话的保活缓存。
		 *
		 * DSH 的客户端会话是引用计数的：视图卸载时最后一个引用释放，
		 * SessionManager 会 retire 这个会话作用域，已加载的历史页与跟随流失效；
		 * 下次切回来只能重新拉一整页历史（公网弱网下就是数 MB）。
		 *
		 * 这里在每次视图 retain 时额外持有一个 "cache" 引用，把最近 N 个会话留在内存里：
		 * 切回来直接复用已加载的历史与仍然连着的跟随流，只增量接收新事件。
		 * 超出 N 个按 LRU 释放；空闲超过 idleMs 也释放，避免长期占用内存与连接。
		 */
		var DEFAULTS = { max: 3, idleMs: 600000 };
		var PinCache = class {
			constructor(options) {
				this.retain = options.retain;
				this.max = Math.max(1, options.max || DEFAULTS.max);
				this.idleMs = Math.max(1000, options.idleMs || DEFAULTS.idleMs);
				this.now = options.now || (() => Date.now());
				this.setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
				this.clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
				this.onError = options.onError || (() => {});
				this.entries = new Map();
				this.disposed = false;
			}
			/** 视图每次 retain 会话时调用：保住它，并刷新最近使用时间。 */
			handleRetain(sessionId) {
				if (this.disposed || typeof sessionId !== "string" || sessionId.length === 0) return;
				var existing = this.entries.get(sessionId);
				if (existing !== undefined) {
					existing.lastUsed = this.now();
					if (existing.timer !== undefined) this.clearTimer(existing.timer);
					this.arm(sessionId, existing);
					return;
				}
				while (this.entries.size >= this.max) {
					var victim = this.oldest();
					if (victim === undefined) break;
					this.drop(victim);
				}
				this.pin(sessionId);
			}
			oldest() {
				var best;
				var bestAt = Infinity;
				for (var [id, entry] of this.entries) {
					if (entry.lastUsed < bestAt) {
						bestAt = entry.lastUsed;
						best = id;
					}
				}
				return best;
			}
			pin(sessionId) {
				var reference;
				try {
					reference = this.retain(sessionId, { source: "cache" });
				} catch (error) {
					this.onError(error);
					return;
				}
				var entry = {
					lastUsed: this.now(),
					timer: undefined,
					released: false,
					release: () => {
						if (entry.released) return;
						entry.released = true;
						try {
							reference.release();
						} catch (error) {
							this.onError(error);
						}
					},
				};
				this.entries.set(sessionId, entry);
				this.arm(sessionId, entry);
			}
			arm(sessionId, entry) {
				entry.timer = this.setTimer(() => {
					entry.timer = undefined;
					if (this.disposed) return;
					if (this.now() - entry.lastUsed >= this.idleMs) this.drop(sessionId);
				}, this.idleMs);
				if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
			}
			drop(sessionId) {
				var entry = this.entries.get(sessionId);
				if (entry === undefined) return;
				this.entries.delete(sessionId);
				if (entry.timer !== undefined) this.clearTimer(entry.timer);
				entry.release();
			}
			/** 已保活的会话 id（最近使用的在后）。 */
			ids() {
				return [...this.entries.keys()];
			}
			stats() {
				return { kept: this.entries.size, max: this.max, idleMs: this.idleMs, ids: this.ids() };
			}
			dispose() {
				this.disposed = true;
				for (var id of [...this.entries.keys()]) this.drop(id);
			}
		};
		//#endregion
		//#region lib/types/client/index.js
		/** 强依赖：会话控制器提供的 sessions 服务。 */
		var inject = ["sessions"];
		/**
		 * 包装 sessions.retain，让每个被视图打开过的会话额外持有一个短时引用。
		 * @param ctx - 客户端根 context。
		 */
		function apply(ctx) {
			var sessions = ctx.sessions;
			if (sessions === undefined || sessions === null) return;
			var options = (typeof window !== "undefined" && window.__DSH_SESSION_CACHE__) || {};
			// 保活引用必须走原始 retain：走包装后的方法会再次触发 handleRetain，形成递归。
			var originalRetain = sessions.retain.bind(sessions);
			var cache = new PinCache({
				max: options.max,
				idleMs: options.idleMs,
				retain: (id, retainOptions) => originalRetain(id, retainOptions),
				onError: (error) => console.warn("[dsh-session-cache]", error),
			});
			sessions.retain = function (target, retainOptions) {
				var reference = originalRetain(target, retainOptions);
				try {
					var id = typeof target === "string" ? target : target && target.childSessionId;
					cache.handleRetain(id);
				} catch (error) {
					console.warn("[dsh-session-cache]", error);
				}
				return reference;
			};
			if (typeof window !== "undefined") {
				window.__DSH_SESSION_CACHE_STATS__ = () => cache.stats();
				window.__DSH_SESSION_CACHE_CLEAR__ = () => cache.dispose();
			}
			var cleanup = () => {
				sessions.retain = originalRetain;
				cache.dispose();
			};
			if (typeof ctx.effect === "function") ctx.effect(() => cleanup);
			else if (typeof ctx.on === "function") ctx.on("dispose", cleanup);
			return cache;
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.__core = { PinCache: PinCache, DEFAULTS: DEFAULTS };
		return module.exports;
	}
});
