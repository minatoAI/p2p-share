// 最小 WebSocket 信令中继：只转发给另一个客户端。
// 用法：NODE_PATH=<app>/node_modules node relay.js 9600
const { WebSocketServer } = require('ws');

const port = Number(process.argv[2] || 9600);
const wss = new WebSocketServer({ port, host: '0.0.0.0' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`client connected (${clients.size})`);
  ws.on('message', (data) => {
    for (const other of clients) {
      if (other !== ws && other.readyState === 1) other.send(data.toString());
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`client closed (${clients.size})`);
  });
});
console.log(`relay listening ${port}`);
