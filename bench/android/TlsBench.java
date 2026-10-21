import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * TLS 1.3 + TCP 基准：验证“局域网直连 + TLS”这条备选传输的实际吞吐。
 * 需要把 key.pem / cert.pem 推到 /data/local/tmp/tls-key.pem、tls-cert.pem。
 */
public final class TlsBench {
    private static final int BUF = 1024 * 1024;

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: send <host> <port> <mb> | recv <port> <mb>");
            System.exit(2);
        }
        String mode = args[0];
        long bytes = Long.parseLong(args[args.length - 1]) * 1024L * 1024L;
        SSLContext context = mode.equals("recv") ? serverContext() : clientContext();
        if (mode.equals("recv")) {
            int port = Integer.parseInt(args[1]);
            SSLServerSocket server = (SSLServerSocket) context.getServerSocketFactory()
                .createServerSocket(port);
            server.setReuseAddress(true);
            System.out.println("listening " + port + " bytes=" + bytes);
            SSLSocket socket = (SSLSocket) server.accept();
            socket.setEnabledProtocols(new String[]{"TLSv1.3"});
            socket.setReceiveBufferSize(4 * 1024 * 1024);
            InputStream in = socket.getInputStream();
            byte[] buf = new byte[BUF];
            long total = 0, start = 0;
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
            String host = args[1];
            int port = Integer.parseInt(args[2]);
            SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket();
            socket.setEnabledProtocols(new String[]{"TLSv1.3"});
            socket.setSendBufferSize(4 * 1024 * 1024);
            socket.connect(new InetSocketAddress(host, port), 5000);
            OutputStream out = socket.getOutputStream();
            byte[] buf = new byte[BUF];
            long start = System.nanoTime();
            long sent = 0;
            while (sent < bytes) {
                int n = (int) Math.min(BUF, bytes - sent);
                out.write(buf, 0, n);
                sent += n;
            }
            out.flush();
            report(sent, start);
            socket.close();
        } else {
            System.err.println("unknown mode " + mode);
            System.exit(2);
        }
    }

    private static SSLContext clientContext() throws Exception {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{trustAll()}, null);
        return context;
    }

    private static SSLContext serverContext() throws Exception {
        String keyPem = new String(Files.readAllBytes(Paths.get("/data/local/tmp/tls-key.pem")),
                                    StandardCharsets.US_ASCII);
        String certPem = new String(Files.readAllBytes(Paths.get("/data/local/tmp/tls-cert.pem")),
                                    StandardCharsets.US_ASCII);
        byte[] key = Base64.getMimeDecoder().decode(strip(keyPem, "PRIVATE KEY"));
        byte[] certBytes = Base64.getMimeDecoder().decode(strip(certPem, "CERTIFICATE"));
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        Certificate cert = cf.generateCertificate(new java.io.ByteArrayInputStream(certBytes));
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        store.load(null, null);
        store.setKeyEntry("server", KeyFactory.getInstance("RSA")
            .generatePrivate(new PKCS8EncodedKeySpec(key)), new char[0], new Certificate[]{cert});
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(store, new char[0]);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(kmf.getKeyManagers(), new TrustManager[]{trustAll()}, null);
        return context;
    }

    private static String strip(String pem, String label) {
        return pem.replace("-----BEGIN " + label + "-----", "")
                  .replace("-----END " + label + "-----", "")
                  .replaceAll("\\s", "");
    }

    private static X509TrustManager trustAll() {
        return new X509TrustManager() {
            public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String auth) {}
            public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String auth) {}
            public java.security.cert.X509Certificate[] getAcceptedIssuers() {
                return new java.security.cert.X509Certificate[0];
            }
        };
    }

    private static void report(long bytes, long start) {
        double seconds = (System.nanoTime() - start) / 1e9;
        double mib = bytes / 1048576.0;
        System.out.printf("bytes=%d seconds=%.2f throughput=%.1f MiB/s%n", bytes, seconds, mib / seconds);
    }
}
