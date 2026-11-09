/**
 * dsh-session-cache — 宿主侧占位插件。
 *
 * 真正的逻辑在 client.js：它是 DSH 客户端模块（dsh.client）里运行的一段浏览器代码。
 * 宿主侧只需要一个可被 Loader 装载的条目，让客户端模块注册表（dsh-client-modules）
 * 扫描到这个包并把它注入页面。
 */
export const name = "dsh-session-cache";

/** 无宿主副作用；保留空 apply 以便作为 cordis 插件装载。 */
export function apply() {}
