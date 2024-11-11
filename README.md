## Warning

This library is experimental; both the API and ABI are subject to change.

## Description

This library maintains a thread-local mapping of keys to values.
Each key and value is an arbitrary byte array.

The core goal of the design is that the map for a thread may be
validly read from that thread whenever user code is stopped; for
example, in a signal handler, a debugger, or an eBPF program. This
should work even if the thread happens to be suspended in the middle
of one of the functions of this library.

The intended purpose is to store custom labels for annotating stack traces
during profiling; for example, client code might set the label `customer_id`
whenever it is processing a request for a particular customer,
and a CPU profiler might then record that value whenever it interrupts the program
to collect a stack trace.

The library exposes a C API (in `customlabels.h`), a Rust API
[documented here](https://docs.rs/custom_labels/0.2.0/custom_labels/), and an ABI for reading
by external code (e.g., profilers or debuggers).

## Supported Configurations

**Language**: any language that can link against C code.

**Platform**: Linux on x86-64 or aarch64 (64-bit ARM).

## Using from Rust

Depend on the [`custom-labels`](https://crates.io/crates/custom-labels) crate as both a standard dependency and a build dependency. For example, in your `Cargo.toml`:

``` toml
[dependencies]
custom-labels = "0.2.0"

[build-dependencies]
custom-labels = "0.2.0"
```

Then add the following line to your executable's `build.rs`:

``` rust
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

For profiler authors,
the ABI is v0 of the Custom Labels ABI described [here](custom-labels-v0.md).

## Acknowledgements

* The approach was partially influenced by the APM/universal profiling integration described [here](https://github.com/elastic/apm/blob/bd5fa9c1/specs/agents/universal-profiling-integration.md#process-storage-layout).
