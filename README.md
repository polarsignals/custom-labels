> [!WARNING]
> This library is experimental; both the API and ABI are subject to change as the underlying OTEPs are finalised.

## Description

This library exposes request-scoped context - trace ID, span ID, and configurable custom attributes - to external readers such as the [OpenTelemetry eBPF Profiler](https://github.com/open-telemetry/opentelemetry-ebpf-profiler), following [OTEP 4947: Thread Context](https://github.com/open-telemetry/opentelemetry-specification/pull/4947). Context is published via an ELF TLSDESC thread-local variable that external readers can discover and read.
It focuses only on the _writing_ side of the equation; for read, an implementation will be made available in the [OpenTelemetry eBPF Profiler](https://github.com/open-telemetry/opentelemetry-ebpf-profiler).

A minimal [OTEP 4719: Process Context](https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/profiles/4719-process-ctx.md) implementation is included to publish the static metadata (key table, schema version) that thread-local records reference.

The core goal of the design is that the map for a thread may be
validly read from that thread whenever user code is stopped; for
example, in a signal handler, a debugger, or an eBPF program. This
should work even if the thread happens to be suspended in the middle
of one of the functions of this library.

The primary purpose is to make request context (trace ID, span ID) available to
profilers, so that profiling samples can be correlated with the request that was
active at the time. Additionally, custom attributes can be attached - for example,
a `customer_id` label - making profiles useful even when the tracer didn't happen
to sample the request that the profiler captured.

The library exposes a Rust API, a Node.js API, and an ABI for reading by
external code (e.g., profilers or debuggers) for both thread context and process
context.

## Supported Configurations

**Language**: Rust and Node.js.

**Platform**: Linux on x86-64 or aarch64 (64-bit ARM).

## Using from Rust

Depend on the `otel-thread-ctx` crate as both a standard dependency and a build dependency. This crate is not yet published to crates.io, so for now use a git dependency.

Then add the following line to your executable's `build.rs`:

``` rust
otel_thread_ctx::build::emit_build_instructions();
```

## Using from JavaScript / Node.js

Node.js library for attaching arbitrary key/value labels to profiling stack traces at runtime. Labels are propagated through asynchronous operations and can be used to correlate profiling data with distributed tracing, user contexts, or any other metadata.

```bash
npm install @polarsignals/custom-labels
```

Requirements:

- Node.js v22 or later
- Node.js v22-v23: requires `--experimental-async-context-frame` flag
- Node.js v24+: works without additional flags
- Native compilation tools (node-gyp)

## ABI

For profiler authors, the thread context ABI is described in
[OTEP 4947](https://github.com/open-telemetry/opentelemetry-specification/pull/4947)
and the process context format is described in
[OTEP 4719](https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/profiles/4719-process-ctx.md).

## Acknowledgements

* The approach was partially influenced by the APM/universal profiling integration described [here](https://github.com/elastic/apm/blob/bd5fa9c1/specs/agents/universal-profiling-integration.md#process-storage-layout).
