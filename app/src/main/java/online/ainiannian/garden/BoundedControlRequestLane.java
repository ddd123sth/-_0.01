package online.ainiannian.garden;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Private integration candidate: one worker maximum per lane. */
final class BoundedControlRequestLane {
    static final long DEADLINE_MS = 5_000L;
    static final int MAX_RESPONSE_BYTES = 64 * 1024;
    private static final long EXIT_GRACE_MS = 250L;
    static final class BusyException extends IOException {
        final boolean transientContention;
        final Attempt ownerAttempt;
        final String busyOrigin;
        BusyException(String m, boolean transientContention, Attempt ownerAttempt, String busyOrigin) {
            super(m); this.transientContention=transientContention; this.ownerAttempt=ownerAttempt; this.busyOrigin=busyOrigin;
        }
    }
    static final class ControlStatusException extends IOException {
        final int status;
        ControlStatusException(int status) { super("Local health response status or format was invalid"); this.status=status; }
    }
    static final class JoinInterruptedException extends InterruptedIOException {
        JoinInterruptedException(String message) { super(message); }
    }
    static final class Attempt {
        final long id, startedNanos, deadlineNanos;
        final AtomicReference<HttpURLConnection> connection = new AtomicReference<>();
        final AtomicBoolean disconnectStarted = new AtomicBoolean();
        final AtomicBoolean watcherStarted = new AtomicBoolean();
        volatile String terminalKind;
        volatile Thread thread; volatile FutureTask<JSONObject> task;
        Attempt(long id, long startedNanos, long deadlineNanos) {
            this.id=id; this.startedNanos=startedNanos; this.deadlineNanos=deadlineNanos;
        }
    }
    interface AttemptObserver { void onAdmitted(Attempt attempt); }
    private final String name; private final Runnable stuckWorker;
    private final Object admissionLock = new Object();
    private final AtomicReference<Attempt> active = new AtomicReference<>();
    private final AtomicBoolean disconnectWorkerBusy = new AtomicBoolean();
    private final AtomicLong attemptSequence = new AtomicLong();
    private Attempt disconnectOwner;
    private boolean unhealthy;
    private final AtomicBoolean accepting = new AtomicBoolean(true);
    BoundedControlRequestLane(String name, Runnable stuckWorker) { this.name=name; this.stuckWorker=stuckWorker; }
    boolean isHealthy() { synchronized (admissionLock) { return !unhealthy; } }
    boolean isBusy() { return active.get()!=null; }
    /** Re-open admission only after a superseded STOP returned to the same process. */
    void resumeAccepting() {
        synchronized(admissionLock) {
            if (active.get()==null && !disconnectWorkerBusy.get()) accepting.set(true);
        }
    }
    /** Recover only after the quarantined worker and its asynchronous disconnect have both exited. */
    boolean recoverIfQuiescent() {
        synchronized (admissionLock) {
            if (!accepting.get()) return false;
            if (!unhealthy) return true;
            if (active.get()!=null || disconnectWorkerBusy.get()) return false;
            unhealthy=false;
            return true;
        }
    }

    JSONObject execute(int port, String token, String method, String route, JSONObject body) throws Exception {
        return execute(port, token, method, route, body, System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(DEADLINE_MS));
    }
    JSONObject execute(int port, String token, String method, String route, JSONObject body, long deadlineNanos) throws Exception {
        return execute(port, token, method, route, body, deadlineNanos, null);
    }
    JSONObject execute(int port, String token, String method, String route, JSONObject body, long deadlineNanos,
            AttemptObserver observer) throws Exception {
        final Attempt a=new Attempt(attemptSequence.incrementAndGet(), System.nanoTime(), deadlineNanos);
        if(deadlineNanos<=System.nanoTime()) throw new SocketTimeoutException(name+" request exceeded 5 second total deadline before admission");
        FutureTask<JSONObject> task=new FutureTask<>(()->perform(a,port,token,method,route,body,deadlineNanos)); a.task=task;
        Thread worker=new Thread(()->{try{task.run();}finally{synchronized(admissionLock){active.compareAndSet(a,null);}}}, "garden-control-"+name);
        worker.setDaemon(true); a.thread=worker;
        synchronized (admissionLock) {
            if (!accepting.get()) throw new BusyException(name+" lane stopped accepting requests", false, null, "stopped");
            if (unhealthy) throw new IOException(name+" lane unhealthy; host restart required");
            if (disconnectWorkerBusy.get()) throw new BusyException(name+" disconnect cleanup is still in flight", true, disconnectOwner, "disconnect-cleanup");
            if (!active.compareAndSet(null,a)) throw new BusyException(name+" request already in flight", true, active.get(), "active-attempt");
            if(observer!=null) observer.onAdmitted(a);
            // Keep publication and worker start under the admission lock so a
            // STOP or joiner cannot observe a half-initialized active attempt.
            if (!accepting.get() || active.get()!=a) {
                markTerminal(a,"stopped"); task.cancel(true); active.compareAndSet(a,null);
                throw new BusyException(name+" lane stopped accepting requests", false, null, "stopped");
            }
            worker.start();
        }
        try {
            long left=deadlineNanos-System.nanoTime(); if(left<=0) throw new TimeoutException();
            return task.get(left,TimeUnit.NANOSECONDS);
        } catch(TimeoutException expired) {
            markTerminal(a, "deadline-expired");
            cancelAndDisconnect(a); watchForStuckWorker(a);
            throw new SocketTimeoutException(name+" request exceeded 5 second total deadline");
        } catch(InterruptedException interrupted) {
            markTerminal(a, "interrupted");
            cancelAndDisconnect(a); watchForStuckWorker(a); Thread.currentThread().interrupt();
            throw new InterruptedIOException(name+" request interrupted");
        } catch(ExecutionException failed) {
            Throwable cause=failed.getCause(); if(cause instanceof Exception) throw (Exception)cause;
            throw new IOException(name+" request failed",cause);
        }
    }

    /** Join only the exact attempt that caused a transient busy result; never issues another request. */
    JSONObject awaitOriginalAttempt(BusyException contention) throws Exception {
        Attempt a=contention==null?null:contention.ownerAttempt;
        if(a==null) throw new BusyException(name+" contention has no joinable owner", true, null,
            contention==null?"unknown":contention.busyOrigin);
        return awaitOriginalAttempt(a);
    }
    JSONObject awaitOriginalAttempt(Attempt a) throws Exception {
        if(a==null) throw new BusyException(name+" contention has no joinable owner", true, null, "unknown");
        FutureTask<JSONObject> task=a.task;
        if(task==null) throw new BusyException(name+" owner attempt has not published its result", true, a, "active-attempt");
        if(task.isDone()) return completedAttemptResult(a, task);
        long left=a.deadlineNanos-System.nanoTime();
        if(left<=0L) {
            markTerminal(a, "deadline-expired"); cancelAndDisconnect(a); watchForStuckWorker(a);
            throw new SocketTimeoutException(name+" original attempt exceeded its 5 second total deadline");
        }
        try { return task.get(left, TimeUnit.NANOSECONDS); }
        catch(TimeoutException expired) {
            markTerminal(a, "deadline-expired"); cancelAndDisconnect(a); watchForStuckWorker(a);
            throw new SocketTimeoutException(name+" original attempt exceeded its 5 second total deadline");
        } catch(InterruptedException interrupted) {
            Thread.currentThread().interrupt(); throw new JoinInterruptedException(name+" original attempt join interrupted");
        } catch(ExecutionException failed) {
            Throwable cause=failed.getCause(); if(cause instanceof Exception) throw (Exception)cause;
            throw new IOException(name+" original attempt failed",cause);
        } catch(CancellationException cancelled) {
            return cancelledAttempt(a, cancelled);
        }
    }
    private JSONObject completedAttemptResult(Attempt a, FutureTask<JSONObject> task) throws Exception {
        try { return task.get(); }
        catch(ExecutionException failed) {
            Throwable cause=failed.getCause(); if(cause instanceof Exception) throw (Exception)cause;
            throw new IOException(name+" original attempt failed",cause);
        } catch(CancellationException cancelled) { return cancelledAttempt(a, cancelled); }
        catch(InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new JoinInterruptedException(name+" original attempt join interrupted"); }
    }
    private JSONObject cancelledAttempt(Attempt a, CancellationException cancelled) throws Exception {
        if("deadline-expired".equals(a.terminalKind) && System.nanoTime()>=a.deadlineNanos)
            throw new SocketTimeoutException(name+" original attempt exceeded its 5 second total deadline");
        if("interrupted".equals(a.terminalKind) || "stopped".equals(a.terminalKind))
            throw new InterruptedIOException(name+" original attempt was cancelled: "+a.terminalKind);
        throw new IOException(name+" original attempt was cancelled without a recorded deadline", cancelled);
    }
    private void markTerminal(Attempt a, String terminalKind) {
        synchronized(admissionLock) { if(a.terminalKind==null) a.terminalKind=terminalKind; }
    }

    void stopAcceptingAndCancelActive() {
        Attempt current;
        synchronized (admissionLock) { accepting.set(false); current=active.get(); }
        if(current!=null) { markTerminal(current,"stopped"); cancelAndDisconnect(current); watchForStuckWorker(current); }
    }

    private JSONObject perform(Attempt a,int port,String token,String method,String route,JSONObject body,long deadline) throws Exception {
        requireTime(deadline);
        HttpURLConnection c=(HttpURLConnection)new URL("http://127.0.0.1:"+port+route).openConnection(Proxy.NO_PROXY);
        a.connection.set(c);
        try {
            c.setInstanceFollowRedirects(false);
            c.setRequestMethod(method);
            c.setRequestProperty("Authorization","Bearer "+token);
            if(body!=null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type","application/json");
                byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(bytes.length);
                setPhaseTimeout(c,deadline);
                try(OutputStream out=c.getOutputStream()) {
                    requireTime(deadline);
                    out.write(bytes);
                    requireTime(deadline);
                }
            }
            setPhaseTimeout(c,deadline);
            int code=c.getResponseCode();
            boolean acceptedRestart=code==HttpURLConnection.HTTP_ACCEPTED && "POST".equals(method) && "/api/local/engine-restart".equals(route);
            boolean rejectedRestart=code==HttpURLConnection.HTTP_CONFLICT && "POST".equals(method) && "/api/local/engine-restart".equals(route);
            boolean healthRead="GET".equals(method) && "/api/local/health".equals(route);
            if(healthRead && code!=HttpURLConnection.HTTP_OK && code!=HttpURLConnection.HTTP_UNAVAILABLE)
                throw new ControlStatusException(code);
            if(code!=HttpURLConnection.HTTP_OK && !acceptedRestart && !rejectedRestart && !(healthRead && code==HttpURLConnection.HTTP_UNAVAILABLE))
                throw new IOException("Local control request returned HTTP "+code);
            // The rejection status itself is authoritative. Do not let an
            // unreadable 409 body turn an explicitly denied restart into an
            // ambiguous liveness failure.
            if(rejectedRestart) return new JSONObject().put("controlHttpStatus", code).put("restartScheduled", false);
            // HTTP 202 is the backend's single-use fresh-ticket acceptance.
            // Once received, body transport cannot revoke that acceptance.
            if(acceptedRestart) return new JSONObject().put("controlHttpStatus", code).put("restartScheduled", true);
            InputStream responseStream = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if(responseStream==null) throw new IOException("Local control response body unavailable");
            try(InputStream in=responseStream;ByteArrayOutputStream out=new ByteArrayOutputStream()) {
                byte[] buffer=new byte[4096];
                for(;;) {
                    setPhaseTimeout(c,deadline);
                    int n=in.read(buffer);
                    requireTime(deadline);
                    if(n<0)break;
                    if(out.size()+n>MAX_RESPONSE_BYTES)throw new IOException("Local control response exceeds 64 KiB");
                    out.write(buffer,0,n);
                }
                JSONObject result;
                try { result = new JSONObject(out.toString("UTF-8")); }
                catch (Exception malformed) { if (healthRead) throw new ControlStatusException(code); throw malformed; }
                if (healthRead || acceptedRestart || rejectedRestart) result.put("controlHttpStatus", code);
                return result;
            }
        } finally {
            // Disconnect for every exit, including output, status-code and body errors.
            c.disconnect();
        }
    }
    private static void setPhaseTimeout(HttpURLConnection c,long deadline) throws SocketTimeoutException {
        long left=deadline-System.nanoTime();if(left<=0)throw new SocketTimeoutException("Total request deadline reached");
        int ms=(int)Math.max(1L,Math.min(Integer.MAX_VALUE,TimeUnit.NANOSECONDS.toMillis(left)));
        c.setConnectTimeout(ms);c.setReadTimeout(ms);
    }
    private static void requireTime(long deadline)throws SocketTimeoutException{if(System.nanoTime()>=deadline)throw new SocketTimeoutException("Total request deadline reached");}
    private void cancelAndDisconnect(Attempt a) {
        FutureTask<JSONObject> t=a.task;if(t!=null)t.cancel(true);HttpURLConnection c=a.connection.get();
        if(c==null||!a.disconnectStarted.compareAndSet(false,true))return;
        synchronized (admissionLock) {
            if(!disconnectWorkerBusy.compareAndSet(false,true))return;
            disconnectOwner=a;
        }
        Thread d=new Thread(()->{try{c.disconnect();}finally{synchronized(admissionLock){if(disconnectOwner==a)disconnectOwner=null;disconnectWorkerBusy.set(false);}}},"garden-control-disconnect-"+name);d.setDaemon(true);d.start();
    }
    private void watchForStuckWorker(Attempt a) {
        if(!a.watcherStarted.compareAndSet(false,true)) return;
        Thread w=a.thread; if(w==null) return; Thread watcher=new Thread(()->{
            try{w.join(EXIT_GRACE_MS);}catch(InterruptedException e){Thread.currentThread().interrupt();return;}
            boolean newlyUnhealthy=false;
            synchronized(admissionLock) { if(w.isAlive()&&active.get()==a&&!unhealthy){unhealthy=true;newlyUnhealthy=true;} }
            if(newlyUnhealthy) stuckWorker.run();
        },"garden-control-watch-"+name);watcher.setDaemon(true);watcher.start();
    }
}
