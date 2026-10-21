/**
 * JNI 驱动：在 Android 上跑 libdatachannel 对端。
 * 先 adb push libjni_bench.so /data/local/tmp/，再用 app_process 运行。
 */
public final class Bench {
    static {
        System.load("/data/local/tmp/libjni_bench.so");
    }

    private static native void start(String role, String url, int megabytes, boolean send);

    public static void main(String[] args) throws Exception {
        if (args.length < 4) {
            System.err.println("usage: Bench <offer|answer> <ws://host:port> <mb> <send|recv>");
            System.exit(2);
        }
        start(args[0], args[1], Integer.parseInt(args[2]), args[3].equals("send"));
        // native 线程会一直跑到完成；这里只负责保持进程
        Thread.sleep(150_000);
    }
}
