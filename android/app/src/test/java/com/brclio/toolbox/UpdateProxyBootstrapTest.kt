package com.brclio.toolbox

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.URL
import java.security.Principal
import java.security.cert.Certificate
import javax.net.ssl.HttpsURLConnection

class UpdateProxyBootstrapTest {
    private val json="""{"version":1,"ttlSeconds":600,"nodes":[{"uuid":"11111111-2222-4333-8444-555555555555","host":"node.example.com","port":443,"path":"/","servername":"node.example.com","wsHost":"node.example.com","dialAddress":"1.1.1.1"}]}"""
    private class Response(private val status:Int=200,private val header:String?=null,private val json:String="",private val failure:IOException?=null,private val beforeStatus:()->Unit={}):HttpsURLConnection(URL(UpdateProxyConfig.ADDRESS)){
        var disconnected=false
        override fun getResponseCode():Int{beforeStatus();failure?.let{throw it};return status}
        override fun getHeaderField(name:String)=if(name=="cf-mitigated")header else null
        override fun getInputStream()=ByteArrayInputStream(json.toByteArray())
        override fun disconnect(){disconnected=true}
        override fun usingProxy()=false
        override fun connect(){}
        override fun getCipherSuite()="TLS_FIXTURE"
        override fun getLocalCertificates():Array<Certificate>?=null
        override fun getServerCertificates():Array<Certificate> = emptyArray()
        override fun getPeerPrincipal():Principal?=null
        override fun getLocalPrincipal():Principal?=null
    }
    @Test fun refreshesEveryOperationWithoutClientCacheAndUsesOnlyFixedOrigins(){
        val addresses=mutableListOf<String>();val responses=mutableListOf<Response>()
        repeat(2){UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){address->addresses.add(address);Response(json=json).also{responses.add(it)}}.use{assertEquals(1,it.fetch().size)}}
        assertEquals(listOf(UpdateProxyConfig.ADDRESS,UpdateProxyConfig.ADDRESS),addresses)
        assertTrue(responses.all{!it.useCaches && !it.instanceFollowRedirects && it.disconnected && it.getRequestProperty("Cache-Control")=="no-store, no-cache"})
    }
    @Test fun networkFailureOrExplicit403ChallengeMayUseAliasExactlyOnce(){
        for(first in listOf(Response(failure=IOException("fixture transport private detail")),Response(403," Challenge "))){
            val addresses=mutableListOf<String>()
            UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){address->addresses.add(address);if(addresses.size==1)first else Response(json=json)}.use{assertEquals(1,it.fetch().size)}
            assertEquals(listOf(UpdateProxyConfig.ADDRESS,UpdateProxyConfig.FALLBACK_ADDRESS),addresses);assertTrue(first.disconnected)
        }
    }
    @Test fun denialRateLimitServerErrorRedirectInvalidSchemaAndNon403ChallengeNeverFallback(){
        for(response in listOf(Response(403),Response(429),Response(502),Response(302),Response(200,"challenge"),Response(200,json="{}"),Response(200,json="not-json"))){
            var count=0
            UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){count++;response}.use{assertTrue(runCatching{it.fetch()}.isFailure)}
            assertEquals(1,count);assertTrue(response.disconnected)
        }
    }
    @Test fun cancelledOrExpiredOperationNeverRequestsAnotherOrigin(){
        var count=0;var cancelled=false
        val loader=UpdateProxyBootstrap(System.currentTimeMillis()+1000,{cancelled}){count++;cancelled=true;Response(failure=IOException("fixture transport private detail"))}
        assertTrue(runCatching{loader.fetch()}.isFailure);assertEquals(1,count);loader.close()
        val expired=UpdateProxyBootstrap(System.currentTimeMillis()-1,{false}){count++;Response(json=json)}
        assertTrue(runCatching{expired.fetch()}.isFailure);assertEquals(1,count);expired.close()
    }
    @Test fun realSocketTimeoutMayFallbackOnlyWhileTheSharedOperationBudgetRemains() {
        var calls=0
        UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){calls++;if(calls==1)Response(failure=java.net.SocketTimeoutException("fixture connect timeout"))else Response(json=json)}.use{assertEquals(1,it.fetch().size)}
        assertEquals(2,calls)
        calls=0
        val loader=UpdateProxyBootstrap(System.currentTimeMillis()+30,{false}){calls++;Response(failure=java.net.SocketTimeoutException("fixture read timeout"),beforeStatus={Thread.sleep(60)})}
        assertTrue(runCatching{loader.fetch()}.isFailure);assertEquals(1,calls);loader.close()
    }
    @Test fun aliasFailureDoesNotLeakExceptionDetailsOrTryAgain(){
        var count=0
        val loader=UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){count++;Response(failure=IOException("fixture transport private detail"))}
        val failure=runCatching{loader.fetch()}.exceptionOrNull()!!
        assertEquals(2,count);assertFalse(failure.message!!.contains("private detail"));loader.close()
    }
}
