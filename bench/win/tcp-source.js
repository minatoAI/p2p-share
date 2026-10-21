// TCP 发送端：向手机发指定 MB，统计耗时和吞吐。配合 Android 的 TcpBench recv 使用。
// 用法：node tcp-source.js <host> <port> <MB>
const net = require('net');

const host = process.argv[2];
const port = Number(process.argv[3] || 9000);
const total = Number(process.argv[4] || 100) * 1024 * 1024;
const chunk = Buffer.alloc(1024 * 1024, 0x61);

let sent = 0;
let t0 = 0;
const socket = net.connect(port, host, () => {
  t0 = Date.now();
  pump();
});

function pump() {
  while (sent < total) {
    const n = Math.min(chunk.length, total - sent);
    sent += n;
    if (!socket.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
      socket.once('drain', pump);
      return;
    }
  }
  socket.end();
}

socket.on('finish', () => {
  const seconds = (Date.now() - t0) / 1000;
  console.log(JSON.stringify({
    bytes: sent,
    seconds: Number(seconds.toFixed(2)),
    mibPerSecond: Number((sent / 1048576 / seconds).toFixed(1)),
  }));
});
socket.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
