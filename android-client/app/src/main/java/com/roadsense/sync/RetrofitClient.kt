package com.roadsense.sync

import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.POST

interface ApiService {
    @POST("api/sync")
    suspend fun syncData(@Body data: List<Map<String, Any>>): Response<Map<String, Any>>
}

object RetrofitClient {
    private const val BASE_URL = "http://10.0.2.2:5000/" // Default emulator gateway to host machine port 5000

    val apiService: ApiService by lazy {
        Retrofit.Builder()
            .baseUrl(BASE_URL)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
    }
}
