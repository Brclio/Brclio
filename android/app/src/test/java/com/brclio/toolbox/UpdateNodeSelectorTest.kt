package com.brclio.toolbox

import org.junit.Assert.*
import org.junit.Test
import org.junit.After
import java.net.URL
import java.security.Principal
import java.security.cert.Certificate
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection

class UpdateNodeSelectorTest {
    @After fun noOperationThreadsLinger() = UpdateProxyThreadAssertions.awaitIdle()

    private fun node(number:Int)=UpdateProxyNode(UUID(0,number.toLong()),"node.example.com",443,"/","1.1.1.1")
    private class Response(private val run:()->Int,private val challenge:String?=null,private val onClose:()->Unit={}) : HttpsURLConnection(URL(UpdateNodeSelector.PROBE_ADDRESS)) {
        override fun getResponseCode()=run()
        override fun getHeaderField(name:String)=if(name=="cf-mitigated")challenge else null
        override fun disconnect()=onClose()
        override fun usingProxy()=true
        override fun connect(){}
        override fun getCipherSuite()="TLS_FIXTURE"
        override fun getLocalCertificates():Array<Certificate>?=null
        override fun getServerCertificates():Array<Certificate> = emptyArray()
        override fun getPeerPrincipal():Principal?=null
        override fun getLocalPrincipal():Principal?=null
    }
    @Test fun testsAllSixteenCandidatesConcurrentlyAndChoosesLowestSuccessfulEndToEndLatency(){
        val nodes=(1..16).map(::node)
        val fastest=nodes[6]
        val otherProbesStarted=CountDownLatch(15)
        val allStarted=CountDownLatch(16)
        val fastestMeasured=CountDownLatch(1)
        val ordered=nodes.filter{it!==fastest}+fastest
        val submissions=object:AbstractList<UpdateProxyNode>(){
            override val size get()=ordered.size
            override fun get(index:Int):UpdateProxyNode{
                // Do not submit the fastest probe until the other fifteen are all in flight.
                if(index==ordered.lastIndex)check(otherProbesStarted.await(5,TimeUnit.SECONDS))
                return ordered[index]
            }
        }
        val calls=AtomicInteger();val closes=AtomicInteger();val bridges=java.util.concurrent.ConcurrentHashMap<NativeUpdateProxy,UpdateProxyNode>()
        val selector=UpdateNodeSelector({node,deadline->NativeUpdateProxy(listOf(node),deadline).also{bridges[it]=node}},{bridge->
            val id=bridges[bridge]!!.uuid.leastSignificantBits.toInt()
            Response({
                calls.incrementAndGet();allStarted.countDown()
                if(id==7)check(allStarted.await(5,TimeUnit.SECONDS))
                else{
                    otherProbesStarted.countDown()
                    check(fastestMeasured.await(5,TimeUnit.SECONDS))
                }
                if(id==8)403 else 200
            },onClose={
                closes.incrementAndGet()
                // disconnect follows the selector's elapsed-time measurement. Every other
                // probe starts before this one and finishes afterwards, regardless of scheduling.
                if(id==7)fastestMeasured.countDown()
            })
        })
        selector.use{
            val chosen=it.select(submissions,System.currentTimeMillis()+8000)
            assertSame(fastest,chosen);assertEquals(16,calls.get());assertEquals(16,closes.get())
        }
        // @After verifies our actual listener/probe/deadline threads stop. Released ephemeral
        // ports may already belong to another process, so reconnecting cannot verify ownership.
    }
    @Test fun rejectsRedirectsAndChallengeEvenIfStatusIs200WithoutSilentDirectFallback(){
        for((status,challenge) in listOf(302 to null,403 to null,200 to " Challenge ")){
            val selector=UpdateNodeSelector(requestFactory={Response({status},challenge)})
            val error=runCatching{selector.select(listOf(node(1)),System.currentTimeMillis()+1000)}.exceptionOrNull()
            assertNotNull(error);assertFalse(UpdateRetryPolicy.canRetry(error!!))
        }
    }
    @Test fun securityFailureDoesNotBecomeRetryableNoUsableNodes(){
        val selector=UpdateNodeSelector(requestFactory={Response({throw javax.net.ssl.SSLHandshakeException("fixture certificate")})})
        val failure=runCatching{selector.select(listOf(node(1)),System.currentTimeMillis()+1000)}.exceptionOrNull()!!
        assertTrue(failure is javax.net.ssl.SSLHandshakeException);assertFalse(UpdateRetryPolicy.canRetry(failure))
    }
    @Test fun connectionFailureBecomesRetryableOnlyAfterAllResourcesClose(){
        val closes=AtomicInteger()
        val selector=UpdateNodeSelector(requestFactory={Response({throw java.net.SocketTimeoutException("fixture")},onClose={closes.incrementAndGet()})})
        val failure=runCatching{selector.select(listOf(node(1)),System.currentTimeMillis()+1000)}.exceptionOrNull()!!
        assertTrue(UpdateRetryPolicy.canRetry(failure));assertEquals(1,closes.get())
    }
    @Test fun cancellationClosesInFlightRequestsAndDoesNotSelectANode(){
        val started=CountDownLatch(1);val released=CountDownLatch(1);val count=AtomicInteger()
        val selector=UpdateNodeSelector(requestFactory={Response({count.incrementAndGet();started.countDown();released.await(3,TimeUnit.SECONDS);200},onClose={released.countDown()})})
        val pool=Executors.newSingleThreadExecutor()
        val future=pool.submit<Boolean>{runCatching{selector.select(listOf(node(1)),System.currentTimeMillis()+8000)}.isFailure}
        assertTrue(started.await(2,TimeUnit.SECONDS));selector.close();assertTrue(future.get(2,TimeUnit.SECONDS));assertEquals(1,count.get());pool.shutdownNow()
    }
}
