// addon.c
#include "../src/customlabels.h"
#include "../src/hashmap.h"

#include <node.h>
#include <node_object_wrap.h>

#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

extern "C" {
  __thread int custom_labels_als_identity_hash = 0;
}

namespace custom_labels {
using node::ObjectWrap;
using v8::Exception;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Isolate;
using v8::Local;
using v8::NewStringType;
using v8::Object;
using v8::ObjectTemplate;
using v8::String;
using v8::Value;
using v8::Context;

#define hm custom_labels_async_hashmap

#define hm_alloc custom_labels_hm_alloc
#define hm_free custom_labels_hm_free
#define hm_insert custom_labels_hm_insert
#define hm_get custom_labels_hm_get
#define hm_delete custom_labels_hm_delete

class ClWrap : public ObjectWrap {
public:
  ~ClWrap() override;
  static void Init(Local<Object> exports);
private:
  static void New(const v8::FunctionCallbackInfo<v8::Value>& args);
  custom_labels_labelset_t *underlying_;
  explicit ClWrap(custom_labels_labelset_t *underlying);
};

ClWrap::~ClWrap() {
  // printf("dtor\n");
  custom_labels_free(underlying_);
}

ClWrap::ClWrap(custom_labels_labelset_t *underlying) :
  underlying_(underlying) {}

void ClWrap::New(const v8::FunctionCallbackInfo<v8::Value>& args) {
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

  // args[0] is the old ls, args[n+1] is the nth key, args[n+2] is the nth value.
  custom_labels_labelset_t *old = NULL;
  if (!args[0]->IsUndefined()) {
    if (!args[0]->IsObject()) {
      isolate->ThrowError("First argument must be the old object or `undefined`");
      return;
    }
    // XXX - is there a way to check that we were actually called with a
    // wrapped ClWrap here, and not any random object?
    ClWrap *old_wrap = ObjectWrap::Unwrap<ClWrap>(args[0].As<Object>());
    assert(old_wrap);
    old = old_wrap->underlying_;
  }

  custom_labels_labelset_t *underlying;
  if (old) {
    underlying = custom_labels_clone_with_capacity(old, custom_labels_count(old) + new_labels);
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

  ClWrap *new_  = new ClWrap(underlying);
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

    // XXX - does this include null terminator?
    int k_len = k->Utf8Length(isolate);
    auto k_buf = std::make_unique<char[]>(k_len);

    int v_len = v->Utf8Length(isolate);
    auto v_buf = std::make_unique<char[]>(v_len);

    k->WriteUtf8(isolate, k_buf.get());
    v->WriteUtf8(isolate, v_buf.get());

    custom_labels_string_t key { (size_t)k_len, (unsigned char *)k_buf.get() };
    custom_labels_string_t value { (size_t)v_len, (unsigned char *)v_buf.get() };
    int err = custom_labels_set(underlying, key, value, nullptr);

    if (err) {
      // TODO - better error message here.
      isolate->ThrowError("Underlying custom_labels_set call failed: probably an allocation error.");
      return;
    }
  }

  me.release()->Wrap(args.This());
  
  args.GetReturnValue().Set(args.This());
}

void ClWrap::Init(Local<Object> exports) {
  Isolate* isolate = exports->GetIsolate();
  Local<Context> context = isolate->GetCurrentContext();

  Local<ObjectTemplate> addon_data_tpl = ObjectTemplate::New(isolate);
  addon_data_tpl->SetInternalFieldCount(1);  // 1 field for the ClWrap::New()
  Local<Object> addon_data =
      addon_data_tpl->NewInstance(context).ToLocalChecked();

  // Prepare constructor template
  Local<FunctionTemplate> tpl = FunctionTemplate::New(isolate, New, addon_data);
  tpl->SetClassName(String::NewFromUtf8(isolate, "ClWrap").ToLocalChecked());
  tpl->InstanceTemplate()->SetInternalFieldCount(1);

  Local<Function> constructor = tpl->GetFunction(context).ToLocalChecked();
  addon_data->SetInternalField(0, constructor);
  exports->Set(context, String::NewFromUtf8(
      isolate, "ClWrap").ToLocalChecked(),
      constructor).FromJust();
}

void StoreHash(const v8::FunctionCallbackInfo<v8::Value>& args) {
  if (!args[0]->IsObject()) {
    args.GetIsolate()->ThrowError("First argument must be an object.");
  }
  int hash = args[0].As<Object>()->GetIdentityHash();
  custom_labels_als_identity_hash = hash;
  // printf("hash: %d\n", hash);
}
  
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-function-type"

NODE_MODULE_INIT() {
  ClWrap::Init(exports);
  NODE_SET_METHOD(exports, "storeHash", StoreHash);
}
} // namespace custom_labels

#pragma GCC diagnostic pop
