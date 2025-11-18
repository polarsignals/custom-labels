// addon.c
#include "native/customlabels.h"

#include <node.h>
#include <node_object_wrap.h>
#include <v8-internal.h>

#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

extern "C" {
using v8::Global;
using v8::Object;
thread_local int custom_labels_als_identity_hash;

thread_local Global<Object> custom_labels_als_handle;
}

namespace custom_labels {
using node::ObjectWrap;
using v8::Context;
using v8::Exception;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Global;
using v8::Isolate;
using v8::Local;
using v8::NewStringType;
using v8::Object;
using v8::ObjectTemplate;
using v8::String;
using v8::Value;

#define hm custom_labels_async_hashmap

#define hm_alloc custom_labels_hm_alloc
#define hm_free custom_labels_hm_free
#define hm_insert custom_labels_hm_insert
#define hm_get custom_labels_hm_get
#define hm_delete custom_labels_hm_delete

const uint64_t CLWRAP_TOKEN_VALUE = 0xEC9EB507FB5D7903;

// Wrapper around a custom_labels_labelset_t,
// with lifetime managed by the V8 GC.
class ClWrap : public ObjectWrap {
public:
  ~ClWrap() override;
  static void Init(Local<Object> exports);

  ClWrap(const ClWrap &) = delete;
  ClWrap &operator=(const ClWrap &) = delete;
  ClWrap(ClWrap &&) = delete;
  ClWrap &operator=(ClWrap &&) noexcept = delete;

private:
  static void New(const v8::FunctionCallbackInfo<v8::Value> &args);
  static void ToString(const v8::FunctionCallbackInfo<v8::Value> &args);
  custom_labels_labelset_t *underlying_;
  // Homemade RTTI. If the bytes at this address equal
  // CLWRAP_TOKEN_VALUE, the agent knows it's looking at
  // an element of ClWrap.
  uint64_t __attribute__((unused)) token_;
  explicit ClWrap(custom_labels_labelset_t *underlying);
};

ClWrap::~ClWrap() { custom_labels_free(underlying_); }

ClWrap::ClWrap(custom_labels_labelset_t *underlying)
    : underlying_(underlying), token_(CLWRAP_TOKEN_VALUE) {}

void ClWrap::New(const v8::FunctionCallbackInfo<v8::Value> &args) {
  Isolate *isolate = args.GetIsolate();

  if (!args.IsConstructCall()) [[unlikely]] {
    isolate->ThrowError("Must be called like `new ClWrap(old, (k, v)*`");
    return;
  }
  if (args.Length() % 2 == 0) {
    isolate->ThrowError("Must be called like `new ClWrap(old, (k, v)*)`");
    return;
  }

  size_t new_labels = args.Length() / 2;

  // args[0] is the old ls, args[n+1] is the nth key, args[n+2] is the nth
  // value.
  custom_labels_labelset_t *old = NULL;
  if (!args[0]->IsUndefined()) {
    if (!args[0]->IsObject()) {
      isolate->ThrowError(
          "First argument must be the old object or `undefined`");
      return;
    }
    ClWrap *old_wrap = ObjectWrap::Unwrap<ClWrap>(args[0].As<Object>());
    if (!old_wrap || old_wrap->token_ != CLWRAP_TOKEN_VALUE) {
      // TODO: Better way to do this?
      // https://stackoverflow.com/questions/8994196/how-to-check-for-correct-type-when-calling-objectwrapunwrap-in-a-nodejs-add-on
      isolate->ThrowError(
          "First argument must be the old object or `undefined`");
      return;
    }
    old = old_wrap->underlying_;
  }

  custom_labels_labelset_t *underlying;
  if (old) {
    underlying = custom_labels_clone_with_capacity(
        old, custom_labels_count(old) + new_labels);
    if (!underlying) {
      isolate->ThrowError("allocation failed");
      return;
    }
  } else {
    underlying = custom_labels_new(new_labels);
    if (!underlying) {
      isolate->ThrowError("allocation failed");
      return;
    }
  }

  ClWrap *new_ = new ClWrap(underlying);
  auto me = std::unique_ptr<ClWrap>(new_);

  for (size_t i = 0; i < new_labels; ++i) {
    int k_idx = 2 * i + 1;
    int v_idx = 2 * i + 2;
    if (!args[k_idx]->IsString() || !args[v_idx]->IsString()) {
      isolate->ThrowError("Arguments other than the first must be strings");
      return;
    }

    Local<String> k = args[k_idx].As<String>();
    Local<String> v = args[v_idx].As<String>();

    int k_len = k->Utf8Length(isolate);
    auto k_buf = std::make_unique<char[]>(k_len);

    int v_len = v->Utf8Length(isolate);
    auto v_buf = std::make_unique<char[]>(v_len);

    k->WriteUtf8(isolate, k_buf.get(), k_len, nullptr,
                 String::NO_NULL_TERMINATION);
    v->WriteUtf8(isolate, v_buf.get(), v_len, nullptr,
                 String::NO_NULL_TERMINATION);

    custom_labels_string_t key{(size_t)k_len, (unsigned char *)k_buf.get()};
    custom_labels_string_t value{(size_t)v_len, (unsigned char *)v_buf.get()};
    int err = custom_labels_set(underlying, key, value, nullptr);

    if (err) {
      // TODO - better error message here.
      isolate->ThrowError("Underlying custom_labels_set call failed: probably "
                          "an allocation error.");
      return;
    }
  }

  me.release()->Wrap(args.This());

  args.GetReturnValue().Set(args.This());
}

void ClWrap::ToString(const v8::FunctionCallbackInfo<v8::Value> &args) {
  Isolate *isolate = args.GetIsolate();

  ClWrap *obj = ObjectWrap::Unwrap<ClWrap>(args.This());
  if (!obj) {
    isolate->ThrowError("Invalid ClWrap object");
    return;
  }

  custom_labels_string_t debug_str;
  int result = custom_labels_debug_string(obj->underlying_, &debug_str);

  if (result != 0) {
    isolate->ThrowError("Failed to generate debug string");
    return;
  }

  Local<String> js_string =
      String::NewFromUtf8(isolate, (const char *)debug_str.buf,
                          NewStringType::kNormal, debug_str.len)
          .ToLocalChecked();

  free((void *)debug_str.buf);

  args.GetReturnValue().Set(js_string);
}

void ClWrap::Init(Local<Object> exports) {
#if NODE_MAJOR_VERSION >= 26
  Isolate *isolate = Isolate::GetCurrent();
#else
  Isolate *isolate = exports->GetIsolate();
#endif
  Local<Context> context = isolate->GetCurrentContext();

  Local<ObjectTemplate> addon_data_tpl = ObjectTemplate::New(isolate);
  addon_data_tpl->SetInternalFieldCount(1); // 1 field for the ClWrap::New()
  Local<Object> addon_data =
      addon_data_tpl->NewInstance(context).ToLocalChecked();

  // Prepare constructor template
  Local<FunctionTemplate> tpl = FunctionTemplate::New(isolate, New, addon_data);
  tpl->SetClassName(String::NewFromUtf8(isolate, "ClWrap").ToLocalChecked());
  tpl->InstanceTemplate()->SetInternalFieldCount(1);

  // Add toString method
  tpl->PrototypeTemplate()->Set(
      String::NewFromUtf8(isolate, "toString").ToLocalChecked(),
      FunctionTemplate::New(isolate, ToString));

  Local<Function> constructor = tpl->GetFunction(context).ToLocalChecked();
  addon_data->SetInternalField(0, constructor);
  exports
      ->Set(context, String::NewFromUtf8(isolate, "ClWrap").ToLocalChecked(),
            constructor)
      .FromJust();
}

void StoreHash(const v8::FunctionCallbackInfo<v8::Value> &args) {
  Isolate *isolate = args.GetIsolate();
  if (!args[0]->IsObject()) {
    isolate->ThrowError("First argument must be an object.");
  }
  Local<Object> obj = args[0].As<Object>();
  int hash = obj->GetIdentityHash();
  custom_labels_als_identity_hash = hash;
  custom_labels_als_handle = Global<Object>(isolate, obj);
}

// parca-agent can't see the hash symbol on x86 if we don't have
// this function that reads it.
// Is the linker stripping it out due to lack of ever being read?
// Not sure; FWIW `nm` *can* see it.
//
// TODO: Figure out why, so we can get rid of this.
void GetStoredHash(const v8::FunctionCallbackInfo<v8::Value> &args) {
  Isolate *isolate = args.GetIsolate();
  Local<v8::Integer> ret{
      v8::Integer::New(isolate, custom_labels_als_identity_hash)};
  args.GetReturnValue().Set(ret);
}

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-function-type"

NODE_MODULE_INIT() {
  ClWrap::Init(exports);
  NODE_SET_METHOD(exports, "storeHash", StoreHash);
}
} // namespace custom_labels

#pragma GCC diagnostic pop
