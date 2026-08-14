// Top-level build file. Plugin versions are declared here and applied,
// without version, in app/build.gradle.kts.
//
// There is no Kotlin plugin in this list, and its absence is the shape of the
// whole AGP 9 upgrade: from 9.0 Kotlin is BUILT IN, and applying
// `org.jetbrains.kotlin.android` alongside it is a build failure rather than a
// deprecation — two `kotlin` extensions on one project. So AGP now pins the
// Kotlin version as well as the Gradle one, and 9.3.1 carries Kotlin 2.2.10.
//
// That is why the two compiler plugins below say 2.2.10 rather than the newest
// Kotlin published: a compiler plugin has to match the compiler it plugs into,
// and with built-in Kotlin nothing here can raise that compiler on its own.
// Read AGP's own pom for the number when this moves — Dependabot bumps these
// two to the latest Kotlin, which is the one version they must not have.
//
// Runtime libraries are held to the same ceiling for a different reason: a
// class compiled by Kotlin 2.3 cannot be READ by the 2.2 compiler. See the
// kotlinx-serialization pin in app/build.gradle.kts.
plugins {
    id("com.android.application") version "9.3.1" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.10" apply false
    // From Kotlin 2.0 the Compose compiler ships with Kotlin and is applied as
    // its own plugin. The old `composeOptions.kotlinCompilerExtensionVersion`
    // is not just deprecated but fatal: configuring :app fails outright with
    // "the Compose Compiler Gradle plugin is required when compose is enabled".
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
}
