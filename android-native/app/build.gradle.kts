plugins {
    // No `org.jetbrains.kotlin.android`: AGP 9 compiles Kotlin itself, and
    // applying that plugin as well is a build failure. See the root build file.
    id("com.android.application")
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
            // Supplied by CI (or a local keystore.properties). Absent for an
            // unsigned build, which is a supported outcome — a release with no
            // keystore configured still produces a sideloadable APK.
            //
            // `takeIf { isNotBlank() }`, not just a null check: a workflow that
            // computes this value with a ternary passes an EMPTY STRING when
            // there is no keystore, and `System.getenv` hands back "" rather
            // than null. That read as "signing is configured", so the build set
            // `storeFile = file("")` — the project directory — and then failed
            // trying to sign with it. Blank and absent mean the same thing here.
            val storePath = System.getenv("ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }
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
            // Same rule as above: blank is absent, and an unsigned APK is a
            // supported outcome rather than a failure.
            signingConfig = if (System.getenv("ANDROID_KEYSTORE_PATH").isNullOrBlank()) {
                null
            } else {
                signingConfigs.getByName("release")
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

// No `kotlinOptions` and no `kotlin { compilerOptions { jvmTarget } }` either.
// Under AGP's built-in Kotlin the JVM target DEFAULTS to
// `compileOptions.targetCompatibility` above, so stating it again is a second
// place for the two to disagree — and naming `JvmTarget` here would put a
// Kotlin Gradle plugin class in a build script that no longer applies that
// plugin.

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.04.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    // 1.18.0 and not 1.19.0: from 1.19.0 androidx.core declares
    // `minCompileSdk=37`, and raising `compileSdk` is a decision of its own —
    // it changes which APIs compile and what lint has an opinion about, none of
    // which belongs in a toolchain upgrade. The failure is at least loud: AGP
    // checks AAR metadata and names the dependency. `activity-compose` and
    // `browser` below are current; they still ask for 36.
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    // LocalLifecycleOwner and repeatOnLifecycle from a composable. The
    // -ktx artifact above does not provide them; Compose UI has its own
    // deprecated LocalLifecycleOwner, and using that instead is how you end
    // up with two lifecycle owners in one tree.
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.activity:activity-compose:1.13.0")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Stats and the calendar are the server's own web UI, shown in a Custom
    // Tab so there is one implementation of the charts rather than two.
    implementation("androidx.browser:browser:1.10.0")

    // Retries a queued check-off when connectivity returns.
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    // Preferences: server URL and the last sync.
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    // NOT 1.10 or later, and this is the ceiling AGP's built-in Kotlin sets
    // rather than a preference: those are compiled by Kotlin 2.3, and a class
    // compiled by 2.3 cannot be read by the 2.2.10 compiler AGP 9.3.1 carries.
    // It fails as "compiled with an incompatible version of Kotlin", which
    // reads like a corrupt artifact and is really a version ceiling. The
    // coroutines line below is fine at 1.11.0 — it is built against 2.2.20,
    // the same metadata generation as ours.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}
