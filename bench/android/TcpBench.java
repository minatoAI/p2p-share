import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 纯 TCP 基准，不经过 App、WebRTC 或任何业务协议，用来量当前 WiFi 的物理上限。
 *
 * 用法（在 Android 上用 app_process 跑）：
 *   send  <host> <port> <MB>   手机发，电脑收
 *   send4 <host> <port> <MB>   4 条 TCP 并发发，看单流是否被窗口限制
 *   recv  <port> <MB>          手机收，电脑发
 *
 * 编译和推送见同目录 build.sh。
 */
public final class TcpBench {
    private static final int BUF = 1024 * 1024;

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: send <host> <port> <mb> | send4 <host> <port> <mb> | recv <port> <mb>");
            System.exit(2);
        }
        String mode = args[0];
        long bytes = Long.parseLong(args[args.length - 1]) * 1024L * 1024L;
        if (mode.equals("recv")) {
            int port = Integer.parseInt(args[1]);
            ServerSocket server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(port));
            System.out.println("listening " + port + " bytes=" + bytes);
            Socket socket = server.accept();
            socket.setReceiveBufferSize(4 * 1024 * 1024);
            InputStream in = socket.getInputStream();
            byte[] buf = new byte[BUF];
            long total = 0;
            long start = 0;
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (total == 0) start = System.nanoTime();
                total += n;
                if (total >= bytes) break;
            }
            report(total, start);
            socket.close();
            server.close();
        } else if (mode.equals("send")) {
            long start = System.nanoTime();
            long sent = sendOne(args[1], Integer.parseInt(args[2]), bytes);
            report(sent, start);
        } else if (mode.equals("send4")) {
            String host = args[1];
            int port = Integer.parseInt(args[2]);
            int streams = 4;
            long per = bytes / streams;
            AtomicLong total = new AtomicLong();
            CountDownLatch start = new CountDownLatch(1);
            CountDownLatch done = new CountDownLatch(streams);
            for (int i = 0; i < streams; i++) {
                new Thread(() -> {
                    try {
                        start.await();
                        total.addAndGet(sendOne(host, port, per));
                    } catch (Exception e) {
                        e.printStackTrace();
                    } finally {
                        done.countDown();
                    }
                }).start();
            }
            long t0 = System.nanoTime();
            start.countDown();
            done.await();
            report(total.get(), t0);
        } else {
            System.err.println("unknown mode " + mode);
            System.exit(2);
        }
    }

    private static long sendOne(String host, int port, long bytes) throws Exception {
        Socket socket = new Socket();
        socket.setSendBufferSize(4 * 1024 * 1024);
        socket.connect(new InetSocketAddress(host, port), 5000);
        OutputStream out = socket.getOutputStream();
        byte[] buf = new byte[BUF];
        long sent = 0;
        while (sent < bytes) {
            int n = (int) Math.min(BUF, bytes - sent);
            out.write(buf, 0, n);
            sent += n;
        }
        out.flush();
        socket.shutdownOutput();
        socket.close();
        return sent;
    }

    private static void report(long bytes, long start) {
        double seconds = (System.nanoTime() - start) / 1e9;
        double mib = bytes / 1048576.0;
        System.out.printf("bytes=%d seconds=%.2f throughput=%.1f MiB/s%n", bytes, seconds, mib / seconds);
    }
}
