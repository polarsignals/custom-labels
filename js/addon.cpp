// Node.js writer for the OTEP-4947 Thread Local Context Record, adapted for
// the Node.js asynchronous context model. The record is wrapped in a JS object
// (CtxWrap) and stored in an AsyncLocalStorage instance; an out-of-process
// reader discovers it by walking the V8 isolate's ContinuationPreservedEmbedderData
// to the AsyncContextFrame (a JS Map), looking up the ALS instance as the key,
// reading the resulting CtxWrap, and finally the record it owns.

#include <node.h>
#include <node_object_wrap.h>

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <memory>

// Single thread-local read from outside the process via TLSDESC. It identifies,
// for the current V8 isolate's thread, which AsyncLocalStorage instance the
// reader must look up inside the AsyncContextFrame map. `als_identity_hash`
// lets the reader restrict the search to a single hash bucket.
//
// Layout is part of the reader ABI: see the README "Discovery contract"
// section and the static_asserts below.
extern "C" {
using v8::Global;
using v8::Object;

struct otel_thread_ctx_nodejs_v1_t {
  Global<Object> als_handle;  // offset 0; one V8 internal pointer
  int als_identity_hash;      // offset sizeof(void*); padding to 16 bytes total
};

__attribute__((visibility("default")))
thread_local otel_thread_ctx_nodejs_v1_t otel_thread_ctx_nodejs_v1;
}

static_assert(sizeof(v8::Global<v8::Object>) == sizeof(void *),
              "Global<Object> must be exactly one pointer wide");
static_assert(offsetof(otel_thread_ctx_nodejs_v1_t, als_handle) == 0,
              "als_handle must be at offset 0");
static_assert(offsetof(otel_thread_ctx_nodejs_v1_t, als_identity_hash) ==
                  sizeof(void *),
              "als_identity_hash must immediately follow als_handle");

namespace otel_thread_ctx_nodejs {
using node::ObjectWrap;
using v8::Array;
using v8::Context;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Global;
using v8::Int32;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::MaybeLocal;
using v8::NewStringType;
using v8::Object;
using v8::String;
using v8::Uint8Array;
using v8::Value;

// Maximum size of the variable-length attribute payload. Chosen so the total
// record size is exactly 640 bytes, matching libdd-otel-thread-ctx and staying
// within the OTEP-recommended 640-byte limit for eBPF readers.
constexpr size_t MAX_ATTRS_DATA_SIZE = 612;

// Exact OTEP-4947 layout. Total: 28-byte header + 612-byte attrs payload.
// Field offsets are statically verified below.
struct OtelThreadCtxRecord {
  uint8_t trace_id[16];                    // offset 0
  uint8_t span_id[8];                      // offset 16
  uint8_t valid;                           // offset 24
  uint8_t reserved;                        // offset 25
  uint16_t attrs_data_size;                // offset 26
  uint8_t attrs_data[MAX_ATTRS_DATA_SIZE]; // offset 28
};
static_assert(sizeof(OtelThreadCtxRecord) == 640,
              "OTEP thread-ctx record must be exactly 640 bytes");
static_assert(offsetof(OtelThreadCtxRecord, trace_id) == 0, "trace_id offset");
static_assert(offsetof(OtelThreadCtxRecord, span_id) == 16, "span_id offset");
static_assert(offsetof(OtelThreadCtxRecord, valid) == 24, "valid offset");
static_assert(offsetof(OtelThreadCtxRecord, reserved) == 25, "reserved offset");
static_assert(offsetof(OtelThreadCtxRecord, attrs_data_size) == 26,
              "attrs_data_size offset");
static_assert(offsetof(OtelThreadCtxRecord, attrs_data) == 28,
              "attrs_data offset");

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

CtxWrap::~CtxWrap() { delete record_; }

CtxWrap::CtxWrap(OtelThreadCtxRecord *record) : record_(record) {}

static bool HexNibble(uint8_t c, uint8_t *out) {
  if (c >= '0' && c <= '9') {
    *out = (uint8_t)(c - '0');
    return true;
  }
  if (c >= 'a' && c <= 'f') {
    *out = (uint8_t)(c - 'a' + 10);
    return true;
  }
  if (c >= 'A' && c <= 'F') {
    *out = (uint8_t)(c - 'A' + 10);
    return true;
  }
  return false;
}

// Parse `expected_bytes` raw bytes from a JS value. The value must be either a
// Uint8Array of exactly `expected_bytes` bytes, or a hex string of exactly
// `expected_bytes * 2` ASCII hex characters. Returns true on success.
static bool ParseFixedBytes(Isolate *isolate, Local<Value> value,
                            size_t expected_bytes, uint8_t *out) {
  if (value->IsUint8Array()) {
    Local<Uint8Array> arr = value.As<Uint8Array>();
    if (arr->ByteLength() != expected_bytes) return false;
    uint8_t *base = static_cast<uint8_t *>(arr->Buffer()->Data()) +
                    arr->ByteOffset();
    memcpy(out, base, expected_bytes);
    return true;
  }
  if (value->IsString()) {
    Local<String> s = value.As<String>();
    int utf8_len = s->Utf8Length(isolate);
    if ((size_t)utf8_len != expected_bytes * 2) return false;
    std::unique_ptr<char[]> buf(new char[utf8_len]);
    s->WriteUtf8(isolate, buf.get(), utf8_len, nullptr,
                 String::NO_NULL_TERMINATION);
    for (size_t i = 0; i < expected_bytes; ++i) {
      uint8_t hi, lo;
      if (!HexNibble((uint8_t)buf[i * 2], &hi) ||
          !HexNibble((uint8_t)buf[i * 2 + 1], &lo)) {
        return false;
      }
      out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
  }
  return false;
}

// Convert an 8-byte raw span ID to a 16-character lowercase hex string,
// written into `out` (which must have room for 16 bytes).
static void EncodeSpanIdHex(const uint8_t span_id[8], uint8_t out[16]) {
  static const char HEX[] = "0123456789abcdef";
  for (size_t i = 0; i < 8; ++i) {
    out[i * 2] = (uint8_t)HEX[span_id[i] >> 4];
    out[i * 2 + 1] = (uint8_t)HEX[span_id[i] & 0xF];
  }
}

void CtxWrap::New(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();

  if (!args.IsConstructCall()) {
    isolate->ThrowError("CtxWrap must be called with `new`");
    return;
  }
  if (args.Length() != 4) {
    isolate->ThrowError(
        "CtxWrap expects 4 arguments: traceId, spanId, localRootSpanId, "
        "attributes");
    return;
  }

  // Value-initialize so all bytes start at 0, then set valid=1.
  std::unique_ptr<OtelThreadCtxRecord> record(new OtelThreadCtxRecord{});
  record->valid = 1;

  if (!ParseFixedBytes(isolate, args[0], 16, record->trace_id)) {
    isolate->ThrowError(
        "traceId must be a 16-byte Uint8Array or a 32-char hex string");
    return;
  }
  if (!ParseFixedBytes(isolate, args[1], 8, record->span_id)) {
    isolate->ThrowError(
        "spanId must be an 8-byte Uint8Array or a 16-char hex string");
    return;
  }

  size_t attrs_offset = 0;
  const bool has_root_span = !args[2]->IsUndefined() && !args[2]->IsNull();
  if (has_root_span) {
    uint8_t root_span[8];
    if (!ParseFixedBytes(isolate, args[2], 8, root_span)) {
      isolate->ThrowError(
          "localRootSpanId must be an 8-byte Uint8Array or a 16-char hex "
          "string");
      return;
    }
    // Index 0 entry: key_index=0, val_len=16, val=<16 lowercase hex chars>.
    record->attrs_data[0] = 0;
    record->attrs_data[1] = 16;
    EncodeSpanIdHex(root_span, &record->attrs_data[2]);
    attrs_offset = 18;
  }

  if (!args[3]->IsUndefined() && !args[3]->IsNull()) {
    if (!args[3]->IsArray()) {
      isolate->ThrowError(
          "attributes must be an array of [keyIndex, value] pairs or "
          "undefined");
      return;
    }
    Local<Array> attrs = args[3].As<Array>();
    uint32_t n = attrs->Length();
    for (uint32_t i = 0; i < n; ++i) {
      Local<Value> pair_val;
      if (!attrs->Get(context, i).ToLocal(&pair_val)) return;
      if (!pair_val->IsArray()) {
        isolate->ThrowError(
            "each attribute must be a [keyIndex, value] pair");
        return;
      }
      Local<Array> pair = pair_val.As<Array>();
      if (pair->Length() != 2) {
        isolate->ThrowError(
            "each attribute must be a [keyIndex, value] pair");
        return;
      }

      Local<Value> key_val, val_val;
      if (!pair->Get(context, 0).ToLocal(&key_val)) return;
      if (!pair->Get(context, 1).ToLocal(&val_val)) return;

      if (!key_val->IsInt32()) {
        isolate->ThrowError(
            "attribute keyIndex must be an integer in [0, 255]");
        return;
      }
      int32_t k = key_val.As<Int32>()->Value();
      if (k < 0 || k > 255) {
        isolate->ThrowError(
            "attribute keyIndex must be an integer in [0, 255]");
        return;
      }
      uint8_t key_idx = (uint8_t)k;
      if (has_root_span && key_idx == 0) {
        isolate->ThrowError(
            "attribute keyIndex 0 is reserved when localRootSpanId is "
            "provided");
        return;
      }

      Local<String> v;
      if (!val_val->ToString(context).ToLocal(&v)) {
        isolate->ThrowError("failed to coerce attribute value to string");
        return;
      }
      int v_utf8_len = v->Utf8Length(isolate);
      // Spec caps value length at 255 bytes; silently truncate longer values.
      uint8_t v_len = v_utf8_len > 255 ? 255 : (uint8_t)v_utf8_len;
      size_t needed = 2u + (size_t)v_len;
      if (attrs_offset + needed > MAX_ATTRS_DATA_SIZE) {
        // Total attribute payload would overflow the 612-byte budget; drop
        // this and any remaining attributes, matching libdd-otel-thread-ctx.
        break;
      }
      record->attrs_data[attrs_offset] = key_idx;
      record->attrs_data[attrs_offset + 1] = v_len;
      v->WriteUtf8(isolate,
                   reinterpret_cast<char *>(&record->attrs_data[attrs_offset + 2]),
                   v_len, nullptr, String::NO_NULL_TERMINATION);
      attrs_offset += needed;
    }
  }

  record->attrs_data_size = (uint16_t)attrs_offset;

  CtxWrap *self = new CtxWrap(record.release());
  self->Wrap(args.This());
  args.GetReturnValue().Set(args.This());
}

// Debug accessor: returns the entire 640-byte record as a fresh Uint8Array.
// Not part of the stable API; intended for tests and out-of-process-reader
// development.
void CtxWrap::Bytes(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  CtxWrap *self = ObjectWrap::Unwrap<CtxWrap>(args.This());
  if (!self) {
    isolate->ThrowError("not a CtxWrap");
    return;
  }
  Local<v8::ArrayBuffer> buf =
      v8::ArrayBuffer::New(isolate, sizeof(OtelThreadCtxRecord));
  memcpy(buf->Data(), self->record_, sizeof(OtelThreadCtxRecord));
  args.GetReturnValue().Set(
      Uint8Array::New(buf, 0, sizeof(OtelThreadCtxRecord)));
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

// Reset the Global<Object> before the isolate is torn down. The Global lives
// in thread-local storage and its destructor only runs at thread exit, which
// on the main thread happens after the isolate is already gone — causing a
// segfault. Registering this as a per-isolate cleanup hook the first time
// StoreAls is called keeps the handle safely scoped to the isolate.
static void ResetAlsHandle(void * /*arg*/) {
  otel_thread_ctx_nodejs_v1.als_handle.Reset();
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
  if (!cleanup_registered) {
    node::AddEnvironmentCleanupHook(isolate, ResetAlsHandle, nullptr);
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
