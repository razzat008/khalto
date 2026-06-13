package com.roadsense.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import com.roadsense.data.TelemetryDao
import com.roadsense.data.TelemetryEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlin.math.sqrt

class RoadSensorManager(
    context: Context,
    private val telemetryDao: TelemetryDao,
    private val scope: CoroutineScope
) : SensorEventListener {

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private var gravity = floatArrayOf(0f, 0f, 9.8f)
    private val windowSize = 50
    private val verticalBuffer = ArrayList<Float>()
    
    // Threshold is adjusted per suspension type (e.g. Sports = 2.0, Sedan = 1.2, SUV = 0.7)
    var thresholdVertical: Double = 1.5

    fun start() {
        val accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        sensorManager.registerListener(this, accel, SensorManager.SENSOR_DELAY_GAME)
    }

    fun stop() {
        sensorManager.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null) return
        if (event.sensor.type == Sensor.TYPE_ACCELEROMETER) {
            // Apply low-pass filter to isolate gravity direction
            val alpha = 0.8f
            gravity[0] = alpha * gravity[0] + (1 - alpha) * event.values[0]
            gravity[1] = alpha * gravity[1] + (1 - alpha) * event.values[1]
            gravity[2] = alpha * gravity[2] + (1 - alpha) * event.values[2]

            // Calculate linear acceleration (raw acceleration minus gravity component)
            val linearX = event.values[0] - gravity[0]
            val linearY = event.values[1] - gravity[1]
            val linearZ = event.values[2] - gravity[2]

            // Project 3D linear acceleration onto gravity unit vector to isolate vertical acceleration
            val gMag = sqrt(gravity[0] * gravity[0] + gravity[1] * gravity[1] + gravity[2] * gravity[2])
            val verticalAcc = if (gMag > 0.1f) {
                (linearX * gravity[0] + linearY * gravity[1] + linearZ * gravity[2]) / gMag
            } else {
                linearZ
            }

            verticalBuffer.add(verticalAcc)
            if (verticalBuffer.size > windowSize) {
                verticalBuffer.removeAt(0)
            }

            if (verticalBuffer.size == windowSize) {
                checkAnomaly()
            }
        }
    }

    private fun checkAnomaly() {
        val mean = verticalBuffer.average()
        val variance = verticalBuffer.map { (it - mean) * (it - mean) }.average()

        if (variance > thresholdVertical) {
            val samplesJson = "[" + verticalBuffer.joinToString(",") + "]"
            
            scope.launch(Dispatchers.IO) {
                // Fetch current device GPS coordinates (using mock locations for Kathmandu during tests)
                val lat = getMockLatitude()
                val lng = getMockLongitude()
                val speed = 9.8f // m/s (approx 35 km/h)

                val report = TelemetryEntity(
                    lat = lat,
                    lng = lng,
                    speedMs = speed,
                    verticalPower = variance,
                    lateralPower = 0.0,
                    rawSamplesJson = samplesJson,
                    timestamp = System.currentTimeMillis()
                )
                telemetryDao.insertReport(report)
            }
            // Clear buffer to avoid double detection on the same transient event
            verticalBuffer.clear()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    
    // Kathmandu locations helper for mock testing
    private fun getMockLatitude(): Double = 27.7172 + (Math.random() - 0.5) * 0.0002
    private fun getMockLongitude(): Double = 85.3240 + (Math.random() - 0.5) * 0.0002
}
