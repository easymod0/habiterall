// Top-level build file. Plugin versions are declared here and applied,
// without version, in app/build.gradle.kts.
//
// There is no Kotlin plugin in this list, and its absence is the shape of the
// whole AGP 9 upgrade: from 9.0 Kotlin is BUILT IN, and applying
// `org.jetbrains.kotlin.android` alongside it is a build failure rather than a
// deprecation — two `kotlin` extensions on one project.
//
// What that does NOT mean, and this file said otherwise for two releases: AGP
// does not pin the Kotlin version the way it pins the Gradle one. It ships a
// DEFAULT, and the two compiler plugins below override it — a Kotlin Gradle
// plugin declares the compiler through the Build Tools API, so asking for
// 2.4.10 here resolves `kotlin-build-tools-impl:2.4.10` and that is what
// compiles the app. The old note said a compiler plugin "has to match the
// compiler it plugs into", which is true and was read backwards: the plugin
// chooses the compiler rather than being constrained by one.
//
// So these two are ordinary version bumps, they must agree with EACH OTHER, and
// the ceiling they set is on the runtime libraries below them — a class compiled
// by a later Kotlin cannot be read by an earlier compiler, which is a real rule
// that simply was not binding at 2.2.10. Both were verified by building at both
// versions rather than from AGP's pom.
plugins {
    id("com.android.application") version "9.3.2" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.10" apply false
    // From Kotlin 2.0 the Compose compiler ships with Kotlin and is applied as
    // its own plugin. The old `composeOptions.kotlinCompilerExtensionVersion`
    // is not just deprecated but fatal: configuring :app fails outright with
    // "the Compose Compiler Gradle plugin is required when compose is enabled".
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
}
