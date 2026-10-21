// TCP 接收端：统计收到指定字节数的时间和吞吐。配合 Android 的 TcpBench send 使用。
// 用法：node tcp-sink.js <port> [connections]
const net = require('net');

const port = Number(process.argv[2] || 9000);
const want = Number(process.argv[3] || 1);
let total = 0;
let t0 = 0;
let ended = 0;
const server = net.createServer((socket) => {
  socket.on('data', (chunk) => {
    if (!t0) t0 = Date.now();
    total += chunk.length;
  });
  socket.on('end', () => {
    ended += 1;
    if (ended >= want) {
      const seconds = (Date.now() - t0) / 1000;
      console.log(JSON.stringify({
        bytes: total,
        seconds: Number(seconds.toFixed(2)),
        mibPerSecond: Number((total / 1048576 / seconds).toFixed(1)),
      }));
      server.close();
    }
  });
});
server.listen(port, '0.0.0.0', () => console.log(`listening ${port}`));
setTimeout(() => {
  console.log(JSON.stringify({ timeout: true, total, ended }));
  process.exit(2);
}, 120000);
