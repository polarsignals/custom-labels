# Sharing Node.js Asynchronous Context-Level Information with OpenTelemetry eBPF Profiler

**Author:** [Attila Szegedi](mailto:attila.szegedi@datadoghq.com)

# Context

We currently have a proposal for [sharing thread-level information with the OpenTelemetry eBPF profiler](https://github.com/open-telemetry/opentelemetry-specification/pull/4947). That proposal acknowledges that it is not suitable for either Go or Node.js because their concurrency constructs are different from threads: Go has goroutines, and Node.js has a Promise API and async/await keywords from JavaScript as well as its own completion callbacks for blocking operations.

As a general rule, Node programs execute on a single thread. This thread runs an event loop. Execution consists of callbacks the event loop invokes one after the other. These callbacks should not perform blocking operations, but rather register further callbacks for observing completion of blocking operations. Instead of explicit callbacks, these days it is also common to use JavaScript Promise API and the async/await pair of keywords; in this case the callbacks are essentially the “then” continuations of the promises. Both styles can be mixed and the two usages are equivalent, and we’ll interchangeably use the terms “callback”, “continuation”, and “task” to refer to short-duration units of code scheduled on the thread loop for execution.
For completeness sake, let’s point out that it is possible to run multiple worker threads in a single Node process. The discussion in this document applies to them as well, as each of them is its own single-threaded event loop with memory isolated from other threads, otherwise behaving in the same way as the main thread event loop.

# Problem

The above means that this single event loop thread is a locus of execution for a large number of (usually very short duration) callbacks, all rapidly executing on it one after another, each belonging to a different logical context. While it is possible to track the context information for each callback and update a pointer to the currently running task’s information in a thread local, that would be detrimental to performance. Node has one [API](https://nodejs.org/docs/latest/api/async_hooks.html#beforeasyncid) for observing the beginning of a new callback execution, and we could be using it to update a thread local. However, this API is getting deprecated and will be removed in a future Node version because (to quote the API docs) it has “usability issues, safety risks, and performance implications”.

# Solution: Asynchronous Context Tracking

Node has a concept of [asynchronous context tracking](https://nodejs.org/docs/latest/api/async_context.html#asynchronous-context-tracking), with a class named AsyncLocalStorage (ALS) being its API. Async local storage is pretty much identical to the concept of thread local storage in multithreaded runtimes, but instead of associating values with threads, it associates values with *asynchronous context*: a piece of state that is preserved and propagated from one callback to all further callbacks that logically follow from it. Datadog’s dd-trace-js library uses asynchronous context tracking extensively for multiple purposes, e.g. for tracking tracing span information, or for tracking profiling sample information.
Asynchronous context tracking is implemented as follows:

* There is an internal Node class called AsyncContextFrame (ACF), which is a map from ALS objects to their respective values in the current context. It is literally a subclass of JavaScript Map class, with ALS objects being the keys, and values associated with them being the values. It is similar to how, e.g. in Java, every Thread object will have an internal Map of thread locals to their values in that thread.
* V8, the JavaScript runtime underpinning Node, has a pair of methods on its Isolate class called {Set|Get}ContinuationPreservedEmbedderData(). (We usually use the acronym “CPED” to refer to this data.) Isolate is the top-level V8 engine object associated with a thread. Node will be calling SetCPED method for setting instances of ACF in the isolate’s CPED for the current async context whenever an ALS value changes, and V8 itself takes care of updating the value it returns from isolate’s GetCPED method as it switches between executions of promise continuations.
* Node separately tracks the ACF value for its own callbacks (IO, timer, etc.) It calls SetCPED to update it before invoking a callback.

V8’s built-in switching on promise continuations plus Node’s switching on IO callbacks together ensure the ACF pointer stored in CPED is always current for the executing async context.
The pointer in isolate’s CPED is thus the immediate equivalent of the TLSDESC thread local from the thread-level OTEP: a value that represents the data for the context of the currently executing callback, changing rapidly as the executed callbacks themselves change.

# Writer Implementation

A writer becomes fairly trivial: we just need to create an ALS instance in JavaScript code, and store a value in it.
What should the value be? In Node it’s easy to create a C++ class whose instances present themselves as JavaScript objects, are managed by the V8 garbage collector, and wrap a block of malloc’d memory and manage its lifetime. We need to define one of these to wrap the block of malloc’d memory, which can simply contain a Thread Local Context Record from the thread-local OTEP. The Polar Signals [custom\_labels project’s “js” subdirectory](https://github.com/polarsignals/custom-labels/tree/master/js) contains an implementation that is almost perfect for our purposes, except instead of Thread Local Context Record it uses its own strings-only data representation.

# Reader Implementation

Using the existing Thread Local Context Record also simplifies the reader implementation as the Node-specific reader code only needs to consider itself with discovering the record in memory, and the process of reading it can be unified with other languages.
That said, the reader is a tad more complicated than for thread-based languages. Whereas the reader for thread-based languages only needs to find the “otel\_thread\_ctx\_v1” thread local in the profiled process, the reader for Node needs to do a bit more legwork. Again, the [Polar Signals has a blog post](https://www.polarsignals.com/blog/posts/2025/11/19/custom-labels-for-node-js) on challenges for the reader implementation, which can itself be found [here](https://github.com/parca-dev/opentelemetry-ebpf-profiler/blob/main/support/ebpf/interpreter_dispatcher.ebpf.c) of it. The lookup path basically looks like this:

* We need to read the V8 thread local containing the pointer to the current isolate.
* We need to read at a known offset in the isolate to retrieve the CPED value, itself a pointer to a JS object. The JS object should be an AsyncContextFrame, but we only really need it to be a JavaScript Map object. Evaluating whether it is a map from outside of the process might be a bit tricky, but solvable.
* If it’s a Map, we need to (again, using a known offset) read a field that points to its hashtable.
* In the hashtable, we need to find the entry that has the ALS instance the writer uses as the key, and read its value, which is a pointer to our C++ wrapper object as a JavaScript object.
* In the wrapper object, we need to read the pointer to the Thread Local Context Record.

That’s it, we have a pointer to the Thread Local Context Record\!

As you can see, it’s a fair amount of indirection.

Additionally, in order to be able to identify the hashtable entry that has the writer’s ALS as the key, we need to know what’s the value (object address) we’re looking for. For this purpose, we need to publish our own thread local, an instance of v8::Global\<v8::Object\>; a C++ global reference to the ALS object. We’ll need to read the address it points to (as GC can move it around in memory) and then use the obtained value for comparison in the hashtable. Just as in the thread-level information sharing OTEP, context reads are expected to behave as if the thread whose context is being read is stopped or otherwise interrupted, and thus there can't be any concurrency hazards between reads and writes so we can rule out reads racing against V8 GC relocating objects in memory.

We can also reduce the number of hashtable reads if we also publish another thread local storing the identity hash code of the ALS object, because then we can restrict ourselves to reading only hashtable entries belonging to a single hash bucket.

# Odds and Ends

The thread-level information OTEP specifies that in the process-level information we need to have an entry named “threadlocal.schema\_version” with value “tlsdesc\_v1”, saying that other schemas can exist. We will need to propose a new value here, e.g. “nodejs\_acf\_v1” or simply “nodejs\_v1”.

Instead of publishing several thread locals, we can settle on a single thread local that publishes a struct with all the necessary information.

In addition to publishing the identity and hash of the ALS object, we can also publish the address of the CPED field in the isolate, to simplify the reader implementation as it doesn't have to find the V8 isolate thread local in the Node.js executable, nor know the offset of the field in the isolate.

Similarly, we can publish the identity of the `undefined` value in that thread's isolate, to easily recognize it as either the value of the CPED or the value associated with the ALS.
