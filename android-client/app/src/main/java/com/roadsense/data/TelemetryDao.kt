package com.roadsense.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface TelemetryDao {
    @Insert
    suspend fun insertReport(report: TelemetryEntity)

    @Query("SELECT * FROM telemetry_reports WHERE isSynced = 0")
    suspend fun getUnsyncedReports(): List<TelemetryEntity>

    @Query("UPDATE telemetry_reports SET isSynced = 1 WHERE id IN (:ids)")
    suspend fun markAsSynced(ids: List<Long>)

    @Query("DELETE FROM telemetry_reports WHERE isSynced = 1")
    suspend fun pruneSyncedReports()
}
