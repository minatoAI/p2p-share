plugins {
    id("com.android.application") version "9.4.1" apply false
    // AGP 9 内置 Kotlin，版本跟它带的 KGP 对齐
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.2.10" apply false
}
