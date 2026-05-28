// Node.js writer for the OTEP-4947 Thread Local Context Record, adapted for
// the Node.js asynchronous context model. The record is wrapped in a JS object
// (CtxWrap) and stored in an AsyncLocalStorage instance; an out-of-process
// reader discovers it by walking the V8 isolate's ContinuationPreservedEmbedderData
// to the AsyncContextFrame (a JS Map), looking up the ALS instance as the key,
// reading the resulting CtxWrap, and finally the record it owns.

#include <node.h>
#include <node_object_wrap.h>
#include <v8-internal.h>

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <atomic>
#include <memory>
#include <vector>

// Single thread-local read from outside the process via TLSDESC. It identifies,
// for the current V8 isolate's thread:
//
//  - the address of the isolate's ContinuationPreservedEmbedderData slot
//    (`cped_slot`), whose value V8 swaps as it switches between continuations.
//    Reading `*cped_slot` yields the active AsyncContextFrame; no V8 internal
//    symbol lookup is required on the reader side.
//  - the AsyncLocalStorage instance the reader must look up inside that
//    AsyncContextFrame map (`als_handle`),
//  - that instance's JS identity hash (`als_identity_hash`), so the reader
//    can restrict the lookup to a single hash bucket.
//
// Layout is part of the reader ABI: see the README "Discovery contract"
// section and the static_asserts below.
extern "C" {
using v8::Global;
using v8::Object;

struct otel_thread_ctx_nodejs_v1_t {
  // v8::internal::Address is a typedef for uintptr_t; the slot stores one
  // tagged V8 word. We expose its address so the reader can dereference it
  // live.
  v8::internal::Address *cped_slot;  // offset 0
  Global<Object> als_handle;         // offset sizeof(void*); one V8 internal pointer
  int als_identity_hash;             // offset 2 * sizeof(void*); 4 bytes + 4 bytes padding
};

__attribute__((visibility("default")))
thread_local otel_thread_ctx_nodejs_v1_t otel_thread_ctx_nodejs_v1;
}

static_assert(sizeof(v8::Global<v8::Object>) == sizeof(void *),
              "Global<Object> must be exactly one pointer wide");
static_assert(offsetof(otel_thread_ctx_nodejs_v1_t, cped_slot) == 0,
              "cped_slot must be at offset 0");
static_assert(offsetof(otel_thread_ctx_nodejs_v1_t, als_handle) ==
                  sizeof(void *),
              "als_handle must immediately follow cped_slot");
static_assert(offsetof(otel_thread_ctx_nodejs_v1_t, als_identity_hash) ==
                  2 * sizeof(void *),
              "als_identity_hash must immediately follow als_handle");

namespace otel_thread_ctx_nodejs {
using node::ObjectWrap;
using v8::Array;
using v8::Context;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Global;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::MaybeLocal;
using v8::NewStringType;
using v8::Object;
using v8::String;
using v8::Uint8Array;
using v8::Value;

// The OTEP `attrs_data_size` field is a uint16, so this is the hard upper
// bound on the attribute payload regardless of caller behavior. Exceeding it
// is treated as a caller error and throws.
constexpr size_t MAX_ATTRS_DATA_SIZE = 65535;

// OTEP-4947 record. The trailing `attrs_data` is a C99 flexible array member:
// the writer allocates one contiguous block of size
// `sizeof(OtelThreadCtxRecord) + attrs_data_size`, and the FAM gives the
// reader of this struct definition the right intuition — "there's
// variable-length data after the header" — while sizeof / offsetof still
// see only the 28-byte header. Field offsets are statically verified below.
struct OtelThreadCtxRecord {
  uint8_t trace_id[16];      // offset 0
  uint8_t span_id[8];        // offset 16
  uint8_t valid;             // offset 24
  uint8_t reserved;          // offset 25
  uint16_t attrs_data_size;  // offset 26
  uint8_t attrs_data[];      // offset 28; length is attrs_data_size
};
static_assert(sizeof(OtelThreadCtxRecord) == 28,
              "OTEP thread-ctx header must be exactly 28 bytes");
static_assert(offsetof(OtelThreadCtxRecord, trace_id) == 0, "trace_id offset");
static_assert(offsetof(OtelThreadCtxRecord, span_id) == 16, "span_id offset");
static_assert(offsetof(OtelThreadCtxRecord, valid) == 24, "valid offset");
static_assert(offsetof(OtelThreadCtxRecord, reserved) == 25, "reserved offset");
static_assert(offsetof(OtelThreadCtxRecord, attrs_data_size) == 26,
              "attrs_data_size offset");
static_assert(offsetof(OtelThreadCtxRecord, attrs_data) == 28,
              "attrs_data offset");

struct OtelThreadCtxRecordDeleter {
  void operator()(OtelThreadCtxRecord *p) const noexcept { free(p); }
};
using OwnedRecord =
    std::unique_ptr<OtelThreadCtxRecord, OtelThreadCtxRecordDeleter>;

// Wraps a heap-allocated OtelThreadCtxRecord. Lifetime is managed by V8 GC:
// when no JS code (or AsyncLocalStorage entry) holds a reference, the record
// is freed.
//
// Layout note for the reader: `record_` is private to C++ but its byte
// position within CtxWrap is part of the reader contract. It is the first
// field after the node::ObjectWrap base subobject.
class CtxWrap : public ObjectWrap {
 public:
  ~CtxWrap() override;
  static void Init(Local<Object> exports);

  CtxWrap(const CtxWrap &) = delete;
  CtxWrap &operator=(const CtxWrap &) = delete;
  CtxWrap(CtxWrap &&) = delete;
  CtxWrap &operator=(CtxWrap &&) noexcept = delete;

 private:
  static void New(const FunctionCallbackInfo<Value> &args);
  static void Bytes(const FunctionCallbackInfo<Value> &args);

  OtelThreadCtxRecord *record_;

  explicit CtxWrap(OtelThreadCtxRecord *record);
};

CtxWrap::~CtxWrap() { free(record_); }

CtxWrap::CtxWrap(OtelThreadCtxRecord *record) : record_(record) {}

// Copy exactly `expected_bytes` bytes out of a JS Uint8Array (or subclass such
// as Buffer) into `out`. Returns false if the value isn't a Uint8Array or its
// length doesn't match.
static bool CopyBytes(Local<Value> value, size_t expected_bytes, uint8_t *out) {
  if (!value->IsUint8Array()) return false;
  Local<Uint8Array> arr = value.As<Uint8Array>();
  if (arr->ByteLength() != expected_bytes) return false;
  uint8_t *base = static_cast<uint8_t *>(arr->Buffer()->Data()) +
                  arr->ByteOffset();
  memcpy(out, base, expected_bytes);
  return true;
}

void CtxWrap::New(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();

  if (!args.IsConstructCall()) {
    isolate->ThrowError("CtxWrap must be called with `new`");
    return;
  }
  if (args.Length() != 3) {
    isolate->ThrowError(
        "CtxWrap expects 3 arguments: traceId, spanId, attributes");
    return;
  }

  // Validate IDs into a scratch header first; we copy into the final
  // allocation once we know how much room the attrs payload needs.
  uint8_t trace_id[16];
  uint8_t span_id[8];
  if (!CopyBytes(args[0], 16, trace_id)) {
    isolate->ThrowError("traceId must be a 16-byte Uint8Array");
    return;
  }
  if (!CopyBytes(args[1], 8, span_id)) {
    isolate->ThrowError("spanId must be an 8-byte Uint8Array");
    return;
  }

  // Encode attributes into a transient buffer first so we can allocate the
  // final record at exactly the size it needs. The OTEP doesn't mandate a
  // fixed-size record — attrs_data_size tells the reader how many bytes
  // follow the 28-byte header — so we publish only as much as we have, and
  // skip the OTEP's recommended 640-byte ceiling (which exists for eBPF
  // readers; per the OTEP, Node.js readers don't use that path).
  std::vector<uint8_t> attrs_buf;
  if (!args[2]->IsUndefined() && !args[2]->IsNull()) {
    if (!args[2]->IsArray()) {
      isolate->ThrowError(
          "attributes must be an array indexed by key, or undefined");
      return;
    }
    Local<Array> attrs = args[2].As<Array>();
    uint32_t n = attrs->Length();
    if (n > 256) {
      isolate->ThrowError("attributes array length must not exceed 256");
      return;
    }
    // Reserve a conservative upper bound; reallocations are cheap but
    // unnecessary for the typical small attribute set.
    attrs_buf.reserve(n * 4);
    for (uint32_t i = 0; i < n; ++i) {
      Local<Value> val_val;
      if (!attrs->Get(context, i).ToLocal(&val_val)) return;
      // null / undefined / array holes mean "no value at this key index".
      if (val_val->IsUndefined() || val_val->IsNull()) continue;

      Local<String> v;
      if (!val_val->ToString(context).ToLocal(&v)) {
        isolate->ThrowError("failed to coerce attribute value to string");
        return;
      }
      int v_utf8_len = v->Utf8Length(isolate);
      // The on-the-wire val_len prefix is a uint8, so individual values
      // longer than 255 UTF-8 bytes are silently truncated to 255.
      int v_budget = v_utf8_len > 255 ? 255 : v_utf8_len;

      // The OTEP attrs_data_size field is a uint16, so the *total* payload
      // hard-caps at 65535 bytes. With the existing per-value cap of 255
      // and per-entry overhead of 2 bytes, only pathological callers
      // (close to 256 max-sized attrs) can hit this — throw rather than
      // silently drop.
      const size_t needed = 2u + static_cast<size_t>(v_budget);
      if (attrs_buf.size() + needed > MAX_ATTRS_DATA_SIZE) {
        isolate->ThrowError(
            "encoded attributes exceed the 65535-byte attrs_data_size "
            "limit imposed by the OTEP-4947 record format");
        return;
      }

      const size_t entry_off = attrs_buf.size();
      attrs_buf.resize(entry_off + needed);
      attrs_buf[entry_off] = static_cast<uint8_t>(i);
      // WriteUtf8 returns the actual number of bytes written, which can be
      // less than v_budget when the cap lands inside a multibyte codepoint
      // — WriteUtf8 stops before writing a partial sequence. Use that
      // count as the length prefix, and shrink the buffer back so the next
      // entry starts at exactly the right offset.
      int v_written = v->WriteUtf8(
          isolate, reinterpret_cast<char *>(&attrs_buf[entry_off + 2]),
          v_budget, nullptr, String::NO_NULL_TERMINATION);
      attrs_buf[entry_off + 1] = static_cast<uint8_t>(v_written);
      if (v_written < v_budget) {
        attrs_buf.resize(entry_off + 2u + static_cast<size_t>(v_written));
      }
    }
  }

  // Allocate one contiguous block of header + attrs_data sized to fit.
  const size_t total = sizeof(OtelThreadCtxRecord) + attrs_buf.size();
  OwnedRecord record(
      static_cast<OtelThreadCtxRecord *>(calloc(1, total)));
  if (!record) {
    isolate->ThrowError("allocation failed");
    return;
  }
  memcpy(record->trace_id, trace_id, sizeof(trace_id));
  memcpy(record->span_id, span_id, sizeof(span_id));
  record->attrs_data_size = static_cast<uint16_t>(attrs_buf.size());
  if (!attrs_buf.empty()) {
    memcpy(record->attrs_data, attrs_buf.data(), attrs_buf.size());
  }

  // OTEP-4947 publication protocol: order the `valid = 1` store after every
  // other field write, with an `atomic_signal_fence` to pin that ordering at
  // compile time and a volatile store so the compiler can't fold or hoist
  // the write. Our current design doesn't actually need this — the record
  // is freshly allocated and only becomes visible to a reader via the V8
  // hand-off below, which already establishes happens-before with all the
  // field writes — but it matches the spec verbatim and is the protocol the
  // alternative "fixed buffer, toggle valid" publication mode would require
  // if we ever switch to it. Both the fence and the volatile store are
  // zero-cost at runtime.
  std::atomic_signal_fence(std::memory_order_release);
  *reinterpret_cast<volatile uint8_t *>(&record->valid) = 1;

  CtxWrap *self = new CtxWrap(record.release());
  self->Wrap(args.This());
  args.GetReturnValue().Set(args.This());
}

// Debug accessor: returns the record (header + attrs_data) as a fresh
// Uint8Array sized to the actual on-the-wire length. Not part of the stable
// API; intended for tests and out-of-process-reader development.
void CtxWrap::Bytes(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  CtxWrap *self = ObjectWrap::Unwrap<CtxWrap>(args.This());
  if (!self) {
    isolate->ThrowError("not a CtxWrap");
    return;
  }
  const size_t total =
      sizeof(OtelThreadCtxRecord) + self->record_->attrs_data_size;
  Local<v8::ArrayBuffer> buf = v8::ArrayBuffer::New(isolate, total);
  memcpy(buf->Data(), self->record_, total);
  args.GetReturnValue().Set(Uint8Array::New(buf, 0, total));
}

void CtxWrap::Init(Local<Object> exports) {
#if NODE_MAJOR_VERSION >= 26
  Isolate *isolate = Isolate::GetCurrent();
#else
  Isolate *isolate = exports->GetIsolate();
#endif
  Local<Context> context = isolate->GetCurrentContext();

  Local<FunctionTemplate> tpl = FunctionTemplate::New(isolate, New);
  tpl->SetClassName(String::NewFromUtf8(isolate, "CtxWrap").ToLocalChecked());
  tpl->InstanceTemplate()->SetInternalFieldCount(1);

  tpl->PrototypeTemplate()->Set(
      String::NewFromUtf8(isolate, "bytes").ToLocalChecked(),
      FunctionTemplate::New(isolate, Bytes));

  Local<Function> constructor = tpl->GetFunction(context).ToLocalChecked();
  exports
      ->Set(context, String::NewFromUtf8(isolate, "CtxWrap").ToLocalChecked(),
            constructor)
      .FromJust();
}

// Reset the Global<Object> and the cped_slot pointer before the isolate is
// torn down. The Global lives in thread-local storage and its destructor only
// runs at thread exit, which on the main thread happens after the isolate is
// already gone — causing a segfault. Registering this as a per-isolate
// cleanup hook the first time StoreAls is called keeps the handle safely
// scoped to the isolate, and the cped_slot pointer points into a struct that
// won't exist once the isolate is gone.
static void ResetDiscoveryStruct(void * /*arg*/) {
  otel_thread_ctx_nodejs_v1.cped_slot = nullptr;
  otel_thread_ctx_nodejs_v1.als_handle.Reset();
  otel_thread_ctx_nodejs_v1.als_identity_hash = 0;
}

void StoreAls(const FunctionCallbackInfo<Value> &args) {
  static thread_local bool cleanup_registered = false;

  Isolate *isolate = args.GetIsolate();
  if (!args[0]->IsObject()) {
    isolate->ThrowError("First argument must be the AsyncLocalStorage object.");
    return;
  }
  Local<Object> obj = args[0].As<Object>();
  otel_thread_ctx_nodejs_v1.als_identity_hash = obj->GetIdentityHash();
  otel_thread_ctx_nodejs_v1.als_handle = Global<Object>(isolate, obj);
  otel_thread_ctx_nodejs_v1.cped_slot = reinterpret_cast<v8::internal::Address *>(
      reinterpret_cast<char *>(isolate) +
      v8::internal::Internals::kContinuationPreservedEmbedderDataOffset);
  if (!cleanup_registered) {
    node::AddEnvironmentCleanupHook(isolate, ResetDiscoveryStruct, nullptr);
    cleanup_registered = true;
  }
}

// Without a function that explicitly reads the TLS variable, on x86 the
// linker may strip the symbol from the dynamic symbol table even though `nm`
// still reports it, breaking out-of-process discovery. This is the same
// workaround as the legacy custom-labels addon.
void GetStoredAlsHash(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  args.GetReturnValue().Set(
      Integer::New(isolate, otel_thread_ctx_nodejs_v1.als_identity_hash));
}

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-function-type"

NODE_MODULE_INIT() {
  CtxWrap::Init(exports);
  NODE_SET_METHOD(exports, "storeAls", StoreAls);
  NODE_SET_METHOD(exports, "getStoredAlsHash", GetStoredAlsHash);
}

#pragma GCC diagnostic pop

} // namespace otel_thread_ctx_nodejs
