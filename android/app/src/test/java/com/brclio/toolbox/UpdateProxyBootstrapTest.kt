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
    private class Response(private val status:Int=200,private val header:String?=null,private val json:String="",private val failure:IOException?=null,private val beforeStatus:()->Unit={},private val onDisconnect:()->Unit={}):HttpsURLConnection(URL(UpdateProxyConfig.ADDRESS)){
        var disconnected=false
        override fun getResponseCode():Int{beforeStatus();failure?.let{throw it};return status}
        override fun getHeaderField(name:String)=if(name=="cf-mitigated")header else null
        override fun getInputStream()=ByteArrayInputStream(json.toByteArray())
        override fun getErrorStream()=ByteArrayInputStream(json.toByteArray())
        override fun disconnect(){disconnected=true;onDisconnect()}
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
    @Test fun networkFailureOrExplicitPrimaryChallengeRequestsAliasOnlyInNextCountedAttempt(){
        for(first in listOf(Response(failure=IOException("fixture transport private detail")),Response(403," Challenge "))){
            val addresses=mutableListOf<String>()
            val failure=UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){address->addresses.add(address);first}.use{
                runCatching{it.fetch()}.exceptionOrNull()
            }
            assertTrue(failure is UpdateBootstrapFailure);assertEquals(listOf(UpdateProxyConfig.ADDRESS),addresses)
            UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false},address=(failure as UpdateBootstrapFailure).nextAddress){address->addresses.add(address);Response(json=json)}.use{assertEquals(1,it.fetch().size)}
            assertEquals(listOf(UpdateProxyConfig.ADDRESS,UpdateProxyConfig.FALLBACK_ADDRESS),addresses);assertTrue(first.disconnected)
        }
    }
    @Test fun denialRateLimitRedirectInvalidSchemaAndCertificateAreNotRetried(){
        for(response in listOf(Response(403),Response(429),Response(302),Response(200,"challenge"),Response(200,json="{}"),Response(200,json="not-json"),Response(failure=javax.net.ssl.SSLHandshakeException("fixture")))){
            var count=0
            val failure=UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){count++;response}.use{runCatching{it.fetch()}.exceptionOrNull()!!}
            assertFalse(UpdateRetryPolicy.canRetry(failure));assertEquals(1,count);assertTrue(response.disconnected)
        }
        val alias=UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false},address=UpdateProxyConfig.FALLBACK_ADDRESS){Response(403,"challenge")}.use{runCatching{it.fetch()}.exceptionOrNull()!!}
        assertFalse(UpdateRetryPolicy.canRetry(alias))
    }
    @Test fun cancelledOrExpiredOperationNeverRequestsAnotherOrigin(){
        var count=0;var cancelled=false
        val loader=UpdateProxyBootstrap(System.currentTimeMillis()+1000,{cancelled}){count++;cancelled=true;Response(failure=IOException("fixture transport private detail"))}
        assertTrue(runCatching{loader.fetch()}.exceptionOrNull() is UpdateStopped);assertEquals(1,count);loader.close()
        val expired=UpdateProxyBootstrap(System.currentTimeMillis()-1,{false}){count++;Response(json=json)}
        assertTrue(runCatching{expired.fetch()}.isFailure);assertEquals(1,count);expired.close()
    }
    @Test fun retryControllerOwnsTheWholeBootstrapBudgetWithoutNestedFallback(){
        var now=0L;var requests=0;var cleanups=0;var address=UpdateProxyConfig.ADDRESS
        val addresses=mutableListOf<String>();val responses=mutableListOf<Response>()
        val runner=UpdateRetryController({now},{now+=it})
        val failure=runCatching{runner.run<Unit>("check",100_000,{false},{},{cleanups++}){
            UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false},address=address){origin->
                requests++;addresses.add(origin);Response(failure=java.net.SocketTimeoutException("private detail")).also{responses.add(it)}
            }.use{loader->try{loader.fetch()}catch(error:UpdateBootstrapFailure){address=error.nextAddress;throw error}}
        }}.exceptionOrNull()
        assertTrue(failure is UpdateRetryExhausted);assertEquals(11,requests);assertEquals(11,cleanups)
        assertTrue(responses.all{it.disconnected});assertEquals(6,addresses.count{it==UpdateProxyConfig.ADDRESS})
        assertEquals(5,addresses.count{it==UpdateProxyConfig.FALLBACK_ADDRESS})
        assertFalse(failure!!.message!!.contains("private detail"))
    }
    @Test fun sharedDeadlineDisconnectsABlockedHeaderRead(){
        val released=java.util.concurrent.CountDownLatch(1)
        val response=Response(beforeStatus={check(released.await(2,java.util.concurrent.TimeUnit.SECONDS))},onDisconnect={released.countDown()})
        val started=System.nanoTime()
        val failure=UpdateProxyBootstrap(System.currentTimeMillis()+100,{false}){response}.use{runCatching{it.fetch()}.exceptionOrNull()!!}
        assertTrue(response.disconnected);assertTrue(UpdateRetryPolicy.canRetry(failure))
        assertTrue(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<1500)
    }
    @Test fun unsupportedBackendConfigurationIsPermanentEvenThoughItsStatusIs502(){
        val failure=UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){Response(502,json="{\"code\":\"proxy_configuration_unsupported\"}")}.use{runCatching{it.fetch()}.exceptionOrNull()!!}
        assertEquals(UpdateProxyConfig.INVALID,failure.message);assertFalse(UpdateRetryPolicy.canRetry(failure))
    }
    @Test fun serverFailureMayRetryButDoesNotInternallySwitchOrigins(){
        var count=0
        val failure=UpdateProxyBootstrap(System.currentTimeMillis()+1000,{false}){count++;Response(502)}.use{runCatching{it.fetch()}.exceptionOrNull()!!}
        assertEquals(1,count);assertTrue(UpdateRetryPolicy.canRetry(failure));assertFalse(failure is UpdateBootstrapFailure)
    }
}
