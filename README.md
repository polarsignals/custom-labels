> [!NOTE]
> This is a temporary fork of [polarsignals/custom-labels](https://github.com/polarsignals/custom-labels)
> updated to match [OTEP 4947: Thread Context](https://github.com/open-telemetry/opentelemetry-specification/pull/4947).
> It is experimental and will be incorporated back upstream once the OTEP is accepted.
> Thanks to [Polar Signals](https://polarsignals.com) for providing a great foundation to build on --
> the original work is (C) Polar Signals.

> [!WARNING]
> This library is experimental; both the API and ABI are subject to change as the underlying OTEPs are finalised.

## Description

This library exposes request-scoped context - trace ID, span ID, and configurable custom attributes - to external readers such as the [OpenTelemetry eBPF Profiler](https://github.com/open-telemetry/opentelemetry-ebpf-profiler), following [OTEP 4947: Thread Context](https://github.com/open-telemetry/opentelemetry-specification/pull/4947). Context is published via an ELF TLSDESC thread-local variable that external readers can discover and read.
It focuses only on the _writing_ side of the equation; for read, an implementation will be made available in the [OpenTelemetry eBPF Profiler](https://github.com/open-telemetry/opentelemetry-ebpf-profiler).

A minimal [OTEP 4719: Process Context](https://github.com/open-telemetry/opentelemetry-specification/pull/4719) implementation is included to publish the static metadata (key table, schema version) that thread-local records reference.

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

The library exposes a C API (in `customlabels.h`) and a Rust API
for both thread context and process context.

## Supported Configurations

**Language**: any language that can link against C code.

**Platform**: Linux on x86-64 or aarch64 (64-bit ARM).

## Using from Rust

Depend on the `custom-labels` crate as both a standard dependency and a build dependency. This crate is not yet published to crates.io, so for now use a git dependency.

Then add the following line to your executable's `build.rs`:

``` rust
#[cfg(not(target_os="macos"))]
custom_labels::build::emit_build_instructions();
```

## Using from C or C++ (shared library)

For a release build:

``` bash
CFLAGS="-O2" make
```

For a debug build:

``` bash
CFLAGS="-O0 -g" make
```

Either will produce a library called `libcustomlabels.so` in the repository root,
which should be linked against during your build process.

## Using from C or C++ (main executable)

Ensure that `customlabels.c` is linked into your executable and that `customlabels.h` is available
in the include path for any source file from which you want to use custom labels. The details of
this will depend on your build system.

## ABI

For profiler authors, the thread context ABI is described in
[OTEP 4947](https://github.com/open-telemetry/opentelemetry-specification/pull/4947)
and the process context format is described in
[OTEP 4719](https://github.com/open-telemetry/opentelemetry-specification/pull/4719).

## Acknowledgements

* This is a fork of [polarsignals/custom-labels](https://github.com/polarsignals/custom-labels), extended to support the formalisation of the thread-local context sharing mechanism in [OTEP 4947](https://github.com/open-telemetry/opentelemetry-specification/pull/4947).
* The approach was partially influenced by the APM/universal profiling integration described [here](https://github.com/elastic/apm/blob/bd5fa9c1/specs/agents/universal-profiling-integration.md#process-storage-layout).
