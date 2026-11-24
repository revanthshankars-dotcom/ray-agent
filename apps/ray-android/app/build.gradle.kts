plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.ray.phone"
    compileSdk = 34
    defaultConfig {
        applicationId = "app.ray.phone"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        // Phones only (keeps the APK small); -Pemu adds x86_64 for testing in the emulator.
        ndk { abiFilters += if (project.hasProperty("emu")) listOf("arm64-v8a", "x86_64") else listOf("arm64-v8a") }
    }
    signingConfigs {
        // One fixed key so each new RAY app version installs over the old one (sideloaded). The key is
        // never committed: point RAY_ANDROID_KEYSTORE at it, or keep sideload.jks next to this project.
        create("sideload") {
            val ks = System.getenv("RAY_ANDROID_KEYSTORE")?.let { file(it) } ?: rootProject.file("sideload.jks")
            if (ks.exists()) {
                storeFile = ks
                storePassword = System.getenv("RAY_ANDROID_KEYSTORE_PASSWORD") ?: "ray-sideload"
                keyAlias = "ray"
                keyPassword = System.getenv("RAY_ANDROID_KEYSTORE_PASSWORD") ?: "ray-sideload"
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            val sl = signingConfigs.getByName("sideload")
            signingConfig = if (sl.storeFile != null) sl else signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { jniLibs { useLegacyPackaging = true } }
}

kotlin { jvmToolchain(21); compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.19.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}
