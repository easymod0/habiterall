# kotlinx.serialization generates serializer() companions and relies on the
# @Serializable annotation surviving; R8 strips both without these rules and
# every API response fails to parse in the release build only.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers class com.habiterall.app.data.** {
    *** Companion;
}
-keepclasseswithmembers class com.habiterall.app.data.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.habiterall.app.data.**$$serializer { *; }

# OkHttp references these only on platforms we do not target; without the rule
# R8 emits warnings that fail the build.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# WorkManager instantiates workers reflectively by class name.
-keep class * extends androidx.work.ListenableWorker { <init>(...); }
