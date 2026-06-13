package com.roadsense.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.roadsense.data.AppDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class SyncWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    private val db = AppDatabase.getDatabase(appContext)
    private val api = RetrofitClient.apiService

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            val unsynced = db.telemetryDao().getUnsyncedReports()
            if (unsynced.isEmpty()) {
                return@withContext Result.success()
            }

            // Map database entities to the API request payload format
            val payload = unsynced.map { entity ->
                mapOf(
                    "lat" to entity.lat,
                    "lng" to entity.lng,
                    "speed" to entity.speedMs,
                    "vertical_power" to entity.verticalPower,
                    "samples" to entity.rawSamplesJson,
                    "timestamp" to entity.timestamp,
                    "device_id" to "android_native_device"
                )
            }

            val response = api.syncData(payload)
            if (response.isSuccessful) {
                val ids = unsynced.map { it.id }
                // Mark database entries as synced and clean up
                db.telemetryDao().markAsSynced(ids)
                db.telemetryDao().pruneSyncedReports()
                Result.success()
            } else {
                // Returns failure to prompt WorkManager to retry later
                Result.retry()
            }
        } catch (e: Exception) {
            Result.retry()
        }
    }
}
