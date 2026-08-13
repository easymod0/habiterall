// Top-level build file. Plugin versions are declared here and applied,
// without version, in app/build.gradle.kts.
// AGP 8.x deliberately, not 9.x: AGP is what caps the Gradle version, and
// staying on 8 keeps us clear of AGP 9's breaking DSL changes while still
// being current.
plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.20" apply false
    // From Kotlin 2.0 the Compose compiler ships with Kotlin and is applied as
    // its own plugin. The old `composeOptions.kotlinCompilerExtensionVersion`
    // is not just deprecated but fatal: configuring :app fails outright with
    // "the Compose Compiler Gradle plugin is required when compose is enabled".
    // Its version must track the Kotlin version exactly.
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false
}
