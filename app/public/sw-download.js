/*
 * 把收到的文件直接流进浏览器的下载管理器。
 *
 * 页面先把这次下载登记进来，拿到一个 /__download/<id> 的地址，再用一个隐藏的
 * iframe 打开它。浏览器为这个地址发起的 fetch 由这里接管，响应体就是一条
 * ReadableStream——页面收到一块就塞一块，浏览器自己往磁盘写。整个过程内存里
 * 只留一两个分片，不再需要把整个文件攒起来。
 *
 * 这个 worker 只碰 /__download/ 开头的地址，其他请求一律不管。
 */

const sessions = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'prepare' || !event.ports[0]) return;

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const port = event.ports[0];
  let controller = null;

  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      sessions.delete(id);
    },
  });

  sessions.set(id, {
    stream,
    controller,
    port,
    name: msg.name || 'download',
    mime: msg.mime || 'application/octet-stream',
    size: Number(msg.size) || 0,
  });

  const session = sessions.get(id);

  // 注意：这里用闭包里的 session，不要再去表里查。
  // 下载一开始，fetch 那侧就把这个 id 标成"已经开始"，查表会查不到。
  port.onmessage = (ev) => {
    const data = ev.data;
    if (data.type === 'chunk') {
      try {
        session.controller.enqueue(new Uint8Array(data.chunk));
      } catch {
        /* 浏览器那边已经取消了这个下载 */
        return;
      }
      session.port.postMessage({ type: 'ack' });
      return;
    }
    if (data.type === 'end') {
      try {
        session.controller.close();
      } catch {
        /* 已经关了 */
      }
      sessions.delete(id);
      return;
    }
    if (data.type === 'abort') {
      try {
        session.controller.error(new Error('aborted'));
      } catch {
        /* 已经关了 */
      }
      sessions.delete(id);
    }
  };
  port.start();

  port.postMessage({ type: 'ready', id });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/__download/')) return;

  const id = url.pathname.slice('/__download/'.length);
  const session = sessions.get(id);
  if (!session) {
    event.respondWith(new Response('这个下载已经结束了', { status: 404 }));
    return;
  }
  // 一次下载只服务一次请求
  if (session.started) {
    event.respondWith(new Response('这个下载已经开始了', { status: 409 }));
    return;
  }
  session.started = true;

  const headers = {
    'content-type': session.mime,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(session.name)}`,
    'cache-control': 'no-store',
  };
  if (session.size > 0) headers['content-length'] = String(session.size);

  session.port.postMessage({ type: 'started' });
  event.respondWith(new Response(session.stream, { headers }));
});
