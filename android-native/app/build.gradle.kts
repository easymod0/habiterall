plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.habiterall.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.habiterall.app"
        // API 26: notification channels and setExactAndAllowWhileIdle, both of
        // which the reminder scheduling relies on.
        minSdk = 26
        targetSdk = 36
        // Stamped by the release workflow from the git tag:
        //   ./gradlew assembleRelease -PversionName=1.4.0 -PversionCode=140
        // The defaults are what a local or PR build gets, so nothing has to be
        // passed to build the app — but a released APK is never version 1 twice,
        // which is the one thing Android will not let you fix afterwards: a
        // versionCode that does not increase cannot install over its predecessor.
        versionCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "0.1.0-dev"
    }

    signingConfigs {
        create("release") {
            // Supplied by CI (or a local keystore.properties). Left unset for
            // a debug-only build, which Gradle handles by falling back below.
            val storePath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (storePath != null) {
                storeFile = file(storePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Only sign when a keystore was actually provided; otherwise the
            // build still succeeds and produces an unsigned APK.
            signingConfig = if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {
                signingConfigs.getByName("release")
            } else {
                null
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // No composeOptions block: from Kotlin 2.0 the Compose compiler version is
    // determined by the org.jetbrains.kotlin.plugin.compose plugin, and
    // `kotlinCompilerExtensionVersion` is both ignored and a configuration
    // error alongside it.
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

// The `kotlinOptions` block inside `android {}` is deprecated and slated for
// removal in Gradle 10; this is its replacement.
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.04.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    // LocalLifecycleOwner and repeatOnLifecycle from a composable. The
    // -ktx artifact above does not provide them; Compose UI has its own
    // deprecated LocalLifecycleOwner, and using that instead is how you end
    // up with two lifecycle owners in one tree.
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Stats and the calendar are the server's own web UI, shown in a Custom
    // Tab so there is one implementation of the charts rather than two.
    implementation("androidx.browser:browser:1.8.0")

    // Retries a queued check-off when connectivity returns.
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    // Preferences: server URL and the last sync.
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
