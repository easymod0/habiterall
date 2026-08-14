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

# And WorkManager's own database the same way, which is what made every release
# APK die before the first frame:
#
#   Unable to get provider androidx.startup.InitializationProvider:
#   NoSuchMethodException: androidx.work.impl.WorkDatabase_Impl.<init> []
#
# Room reaches its generated `*_Impl` class through
# `Class.getDeclaredConstructor()`, so nothing in the bytecode refers to that
# constructor and R8 removes it. The rule room-runtime ships as a consumer rule
# is `-keep class * extends androidx.room.RoomDatabase` with NO member
# specification, which keeps the class and lets its members go — so the failure
# names a class that is present and a constructor that is not, and the two
# together read like a corrupt artifact rather than shrinking.
#
# It is WorkManager's database rather than one of ours, which is why nothing in
# this app's source has to mention Room for the rule to be needed, and why a
# debug build could never show it: `androidx.startup` runs this before
# `Application.onCreate`, so the crash lands ahead of every line the app owns.
#
# Verified by building `assembleRelease`, installing it, and reading
# `mapping/release/usage.txt`, which listed the removal by name.
-keep class * extends androidx.room.RoomDatabase { <init>(); }
