package com.brclio.toolbox

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/** Handles only the system-protected broadcast for replacement of our own package. */
class UpdateRelaunchReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val pending = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val target = pending.getLong(TARGET_VERSION, 0)
        val requestedAt = pending.getLong(REQUESTED_AT, 0)
        // Consume before trying to start: stale/repeated broadcasts must not keep reopening Brclio.
        if (!pending.edit().clear().commit()) {
            Log.w(TAG, "Could not consume pending update; keeping the installer Open button as fallback")
            return
        }
        @Suppress("DEPRECATION")
        val installed = context.packageManager.getPackageInfo(context.packageName, 0).let {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) it.longVersionCode else it.versionCode.toLong()
        }
        if (!UpdateRelaunchPolicy.accepts(target, installed, requestedAt, System.currentTimeMillis())) return

        try {
            context.startActivity(Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            })
            // startActivity returning does not prove visibility: Android/OEM BAL policy can block it.
            Log.i(TAG, "Requested return to Brclio after user-initiated update to versionCode=$installed")
        } catch (exception: RuntimeException) {
            Log.w(TAG, "Android did not allow returning to Brclio; use the installer Open button", exception)
        }
    }

    companion object {
        private const val TAG = "BrclioUpdate"
        private const val PREFERENCES = "brclio-pending-install"
        private const val TARGET_VERSION = "targetVersionCode"
        private const val REQUESTED_AT = "requestedAt"

        fun remember(context: Context, targetVersionCode: Long) {
            check(context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                .putLong(TARGET_VERSION, targetVersionCode)
                .putLong(REQUESTED_AT, System.currentTimeMillis()).commit()) { "无法保存更新安装状态，请重试。" }
        }

        fun clear(context: Context) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }
}
