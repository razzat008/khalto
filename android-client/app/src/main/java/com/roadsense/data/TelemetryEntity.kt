package com.roadsense.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "telemetry_reports")
data class TelemetryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val lat: Double,
    val lng: Double,
    val speedMs: Float,
    val verticalPower: Double,
    val lateralPower: Double,
    val rawSamplesJson: String,      // JSON string representation of FloatArray vertical acceleration
    val timestamp: Long,
    val isSynced: Boolean = false
)
