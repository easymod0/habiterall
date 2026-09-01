plugins {
    // No `org.jetbrains.kotlin.android`: AGP 9 compiles Kotlin itself, and
    // applying that plugin as well is a build failure. See the root build file.
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.habiterall.app"
    compileSdk = 37

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
    testOptions {
        unitTests {
            // Robolectric needs the merged resources to inflate anything, and
            // the strings the notification's buttons are labelled with are
            // resources.
            isIncludeAndroidResources = true
        }
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
    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    // The same BOM for the JVM tests, so a composable is rendered by exactly the
    // Compose the app ships. A test artifact resolved independently is a second
    // Compose in the test classpath, and the runtime it links against is then
    // not the one under test.
    testImplementation(composeBom)

    // 1.19.0 declares `minCompileSdk=37`, which is why `compileSdk` above moved
    // and `targetSdk` did not. AGP's AAR metadata check is what refuses the
    // mismatch, and it names the dependency, so the failure is at least loud:
    // "requires libraries and applications that depend on it to compile against
    // version 37 or later". Compiling against 37 only changes which APIs are
    // available to compile against; `targetSdk` is the opt-in to new RUNTIME
    // behaviour, and that is a separate decision with its own testing.
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

    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    // This was pinned at 1.9.0 against a ceiling that turns out not to exist,
    // and the correction is worth keeping because the reasoning sounded right.
    // A class compiled by a later Kotlin cannot be read by an earlier compiler,
    // so 1.10+ — built by Kotlin 2.3 — was held below the 2.2.10 that AGP 9 was
    // believed to fix. AGP does not fix it. The Kotlin Gradle plugins in the
    // root build file SELECT the compiler through the Build Tools API: asking
    // for 2.4.10 resolves `kotlin-build-tools-impl:2.4.10`, and that is what
    // does the compiling. So the ceiling moves with the plugin version, not with
    // AGP — and measured both ways before this line changed, 1.11.0 compiles
    // under 2.4.10 and under 2.2.10 alike.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    testImplementation("junit:junit:4.13.2")
    // Real Intents, real PendingIntents, a real AlarmManager and a real
    // Notification, on the JVM. Added because the plumbing between a decision
    // and its effect is where every bug in this package has been, and a pure
    // function cannot reach it: `alarmUri` returning the right string does not
    // prove the snooze intent uses it.
    testImplementation("org.robolectric:robolectric:4.16.1")
    // Lets a test ask what work a receiver enqueued, which is the only way to
    // see the difference between a snoozed delivery and a daily one.
    testImplementation("androidx.work:work-testing:2.10.0")
    // Renders a composable on the JVM, under Robolectric. Every rule that lives
    // in a @Composable was otherwise verified by a person on an emulator once
    // and never again — see issue #110. Version from the BOM above.
    testImplementation("androidx.compose.ui:ui-test-junit4")
    // `createComposeRule` launches a ComponentActivity, and this is the artifact
    // that declares one in the manifest. Without it the rule fails at
    // `ActivityNotFoundException` rather than at anything a test wrote.
    // `debugImplementation` and not `testImplementation`: it contributes a
    // MANIFEST entry, and only the app variant's manifest is merged into what
    // the unit tests inflate.
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}
