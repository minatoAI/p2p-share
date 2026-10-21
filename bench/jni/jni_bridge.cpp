#include "peer.cpp"

#include <jni.h>
#include <string>
#include <thread>

extern "C" JNIEXPORT void JNICALL
Java_Bench_start(JNIEnv* env, jclass, jstring role, jstring url, jint megabytes, jboolean send) {
    const char* role_chars = env->GetStringUTFChars(role, nullptr);
    const char* url_chars = env->GetStringUTFChars(url, nullptr);
    Options options;
    options.role = role_chars ? role_chars : "answer";
    options.url = url_chars ? url_chars : "";
    options.megabytes = megabytes;
    options.send = send == JNI_TRUE;
    env->ReleaseStringUTFChars(role, role_chars);
    env->ReleaseStringUTFChars(url, url_chars);
    std::thread([options]() {
        rtc::Preload();
        run_peer(options);
        rtc::Cleanup();
    }).detach();
}
