## !!WARNING!!

This crate is an experimental proof-of-concept/work-in-progress. It
should be expected to change arbitrarily at any moment, and might
have bugs that cause undefined behavior.

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

The library exposes a C API (in `lib.h`), a Rust API (which just
re-exports everything from `lib.h`), and an ABI for reading
by external code (e.g., profilers or debuggers).

## ABI

Three important symbols are exposed.

**`uint32_t custom_labels_abi_version`**

As of the present version, this is always zero.

**`__thread size_t custom_labels_count`**

This thread-local variable stores the number of label/value pairs
present on the current thread.

**`__thread custom_labels_label_t *custom_labels_storage`**

This thread-local variable is an array of custom labels on
the current thread. Indexes into this array must be less than
`custom_labels_count`.

The type of the elements of this array are given by

``` c
typedef struct {
        size_t len;
        unsigned char *buf;
} custom_labels_string_t;

typedef struct {
        custom_labels_string_t key;
        custom_labels_string_t value;
} custom_labels_label_t;
```

In the steady state, there is at most one element
in the array for each unique key, and the buffers for each key
are never NULL. However, if the thread happens to be suspended
in the middle of one of the functions of this library,
those invariants might not hold. To be robust against this possibility,
consuming code must uphold the following contract:

* It must skip any label whose `key.buf` is NULL, and
* It must always take the _first_ label corresponding to a given
  key.
