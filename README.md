# dsh-session-cache

DSH（DeepSeek Harness）客户端插件：把**最近看过的会话留在内存里**，在不同会话之间来回切换时
复用已经加载好的历史与仍然连着的跟随流，不再每次都重新拉一整页对话历史。

> A DSH client plugin that keeps recently viewed sessions resident, so switching between
> conversations reuses the loaded transcript instead of refetching it.

## 解决什么问题

DSH 的客户端会话是**引用计数**的（`sessions.retain / release`）。会话视图卸载时最后一个引用释放，
`SessionManager` 会 retire 这个会话作用域：已加载的历史页被丢弃、跟随流断开。下次切回来，
客户端只能重新请求一整页历史。

对一个真实的会话日志（`session.jsonl.zstd`）实测：

| 指标 | 数值 |
| --- | --- |
| 磁盘压缩后 | 7.5 MB |
| 解压后原始 JSONL | 16.2 MB |
| 首次打开（冷启动） | 客户端按页拉取投影后的历史，公网弱网下是主要等待 |
| 靠缓存切回（本插件） | 0 字节历史重传，只补这期间新增的事件 |

本插件在每次视图 `retain` 会话时额外持有一个 `source: "cache"` 引用，把最近 N 个会话
留在内存里：切回来直接复用已加载的历史与跟随流，只增量接收新事件。

## 行为

- **LRU 上限**：默认保留最近 **5** 个会话，超出按最近使用时间释放；
- **空闲释放**：默认 **24 小时**没再打开就释放，避免长期占用内存与 WebSocket 流；
- **可运行期调整**：控制台命令 `__DSH_SESSION_CACHE_CONFIGURE__({ max, idleMs })`，默认写入 localStorage，刷新后仍生效；
- **不干扰视图自己的引用**：只释放自己持有的那一份，视图的生命周期仍由 UI 决定；
- **失败安全**：`sessions` 服务缺失、`retain` 抛错、DOM 环境异常都只记一条 warning，不影响页面；
- **零网络请求**：插件只在浏览器内存里工作，不发请求、不写磁盘。

## 安装

### 1. 放进 profile

```bash
PROFILE_DIR=~/.dsh/profiles/web      # 或 desktop（DSH NEXT 桌面版）
mkdir -p "$PROFILE_DIR/node_modules/dsh-session-cache"
cp package.json host.js client.js "$PROFILE_DIR/node_modules/dsh-session-cache/"
```

### 2. 在 profile 的 cordis.patch.yml 追加

```yaml
- insert:
    - id: dsh-session-cache
      name: dsh-session-cache
```

### 3. 生效

- DSH NEXT（桌面版）：宿主会热加载 patch，**刷新页面**即可；
- `dsh web`：重启进程，刷新页面。

安装后用浏览器控制台确认：

```js
__DSH_SESSION_CACHE_STATS__()   // { kept: 1, max: 5, idleMs: 86400000, ids: ["session-..."] }
```

## 配置

默认 **5 个会话 / 24 小时**。运行期用控制台命令改，改完立即生效并写入 localStorage：

```js
// 同时改两个
__DSH_SESSION_CACHE_CONFIGURE__({ max: 8, idleMs: 3600000 })

// 只缩短空闲时间，不持久化（只影响当前页面）
__DSH_SESSION_CACHE_CONFIGURE__({ idleMs: 600000, persist: false })

// 回到默认
__DSH_SESSION_CACHE_CONFIGURE__({ max: 5, idleMs: 86400000 })
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `max` | 5 | 最多同时保活几个会话（最小 1） |
| `idleMs` | 86400000 | 空闲多久释放（毫秒，最小 1000） |
| `persist` | true | 是否写入 localStorage（`dsh.session-cache`） |

配置优先级：`window.__DSH_SESSION_CACHE__`（页面内临时覆盖） > localStorage > 默认值。

其它调试全局：

- `__DSH_SESSION_CACHE_STATS__()`：当前保活的会话；
- `__DSH_SESSION_CACHE_CLEAR__()`：立即释放全部（不影响已保存的配置）。

## 为什么不做成 Service Worker / HTTP 缓存

对话历史走的是 DSH 的 RPC 连接（WebSocket + 多路复用流），不是可缓存的 HTTP 资源，
Service Worker 拦不到。真正的成本是「会话作用域被回收后重新拉历史」，所以修复点在客户端的
会话引用计数上。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| 验证版本 | `@deepseek-ai/dsh 0.2.2-rc.1`（客户端模块系统 `dsh-client-modules`） |
| 使用的客户端 API | `sessions.retain(target, { source })` + 引用上的 `release()`；`sessions` 服务 |
| 失效表现 | 客户端 API 变化时插件要么不生效（`sessions` 不存在直接返回），要么在控制台留下 warning，不会阻塞页面 |
| 打包格式 | 手写 `window.__ModuleLoader__.load` 客户端 bundle，无构建步骤 |

## 测试

```bash
npm test
```

7 项单元测试：首次保活、LRU 淘汰、空闲释放、重复打开刷新计时、dispose 全释放、
`retain` 抛错兜底、`apply` 包装与还原。

## 基准测试

见 [docs/benchmark.md](docs/benchmark.md)。

## License

[MIT](LICENSE) © 2026 kinyokun
