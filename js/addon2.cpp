// addon.c
// #include "addon.h"
#include "../src/customlabels.h"
#include "../src/hashmap.h"
// #include "js_native_api.h"

#include <node.h>

#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

extern "C" {
  __thread custom_labels_hashmap_t *custom_labels_async_hashmap;
}

namespace custom_labels {
using v8::FunctionCallbackInfo;
using v8::Isolate;
using v8::Local;
using v8::NewStringType;
using v8::Object;
using v8::String;
using v8::Value;


#define hm custom_labels_async_hashmap

#define hm_alloc custom_labels_hm_alloc
#define hm_free custom_labels_hm_free
#define hm_insert custom_labels_hm_insert
#define hm_get custom_labels_hm_get
#define hm_delete custom_labels_hm_delete

typedef struct {
  custom_labels_labelset_t *ls;
  unsigned refs;
} labelset_rc;

static void init() { hm = hm_alloc(); }

typedef enum {
  SUCCESS,
  ALLOC_FAILED,
  CHILD_ALREADY_EXISTED,
} hm_error_t;

const char *my_strerror(hm_error_t err) {
  switch (err) {
  case SUCCESS:
    return "(no error)";
  case ALLOC_FAILED:
    return "allocation failed";
  case CHILD_ALREADY_EXISTED:
    return "child already existed";
  }
  return "(unknown error)";
}

static void unref(labelset_rc *rc) {
  if (rc && !--rc->refs) {
    // TODO why do we need two allocations here? Like why can't the labelset
    // just be inline in the RC?
    custom_labels_free(rc->ls);
    free(rc);
  }
}

static hm_error_t ensure_init() {
  if (!hm) [[unlikely]]
    init();
  if (!hm) [[unlikely]]
    return ALLOC_FAILED;
  return SUCCESS;
}

static hm_error_t propagate(uint64_t parent, uint64_t child) {
  hm_error_t error;
  if ((error = ensure_init())) [[unlikely]]
    return error;
  labelset_rc *parent_rc = (labelset_rc *)hm_get(hm, parent);
  if (parent_rc && custom_labels_count(parent_rc->ls)) {
    ++parent_rc->refs;
    labelset_rc *old;
    bool success = hm_insert(hm, child, parent_rc, (void **)&old);
    if (!success) [[unlikely]] {
      return ALLOC_FAILED;
    }
    if (old) [[unlikely]] {
      unref(old);
      return CHILD_ALREADY_EXISTED;
    }
  }
  return SUCCESS;
}

static int64_t val2int(const Local<Value> val) {
  // see napi_get_value_int64
  if (val->IsInt32()) [[likely]] {
    return val.As<v8::Int32>()->Value();
  }
  v8::Local<v8::Context> context;
  return val->IntegerValue(context).FromJust();
}

static void throw_str(Isolate *isolate, char const *c_str) {
  // The V2 API is only available in very recent Node versions.
  auto str =
      v8::String::NewFromUtf8(isolate, c_str, v8::NewStringType::kInternalized);
  v8::Local<v8::Value> error_obj = v8::Exception::Error(str.ToLocalChecked());
  isolate->ThrowException(error_obj);
}

static void throw_error(Isolate *isolate, hm_error_t err) {
  throw_str(isolate, my_strerror(err));
}

static hm_error_t destroy(uint64_t id) {
  hm_error_t error;
  if ((error = ensure_init())) [[unlikely]]
    return error;
  labelset_rc *rc = (labelset_rc *)hm_delete(hm, id);
  unref(rc);
  return SUCCESS;
}

static void Destroy(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  uint64_t async_id = val2int(args[0]);
  hm_error_t err = destroy(async_id);
  if (err) [[unlikely]] {
    throw_error(isolate, err);
    return;
  }
}

static void Propagate(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  uint64_t parent_id = val2int(args[0]);
  uint64_t child_id = val2int(args[1]);
  hm_error_t err = propagate(parent_id, child_id);
  if (err) [[unlikely]] {
    throw_error(isolate, err);
    return;
  }
}

#define MAX_LABELS 10
#define MAX_KEY_SIZE 16
#define MAX_VAL_SIZE 48

#define STR_HELPER(x) #x
#define STR(x) STR_HELPER(x)

static hm_error_t reify(uint64_t async_id, uint64_t capacity,
                        custom_labels_labelset_t **out) {
  assert(out); // Justification: this can't be called from JS
  // TODO: should the HM have a get_or_insert function ?
  labelset_rc *rc = (labelset_rc *)hm_get(hm, async_id);
  *out = NULL;
  if (!rc) {
    rc = (labelset_rc *)malloc(sizeof *rc);
    if (!rc) [[unlikely]]
      return ALLOC_FAILED;
    rc->refs = 1;
    rc->ls = *out = custom_labels_new(capacity);
    if (!*out) [[unlikely]] {
      unref(rc);
      return ALLOC_FAILED;
    }
    if (!hm_insert(hm, async_id, rc, NULL)) [[unlikely]] {
      unref(rc);
      return ALLOC_FAILED;
    }
  } else if (rc->refs > 1) {
    labelset_rc *new_rc = (labelset_rc *)malloc(sizeof *rc);
    if (!new_rc) [[unlikely]] {
      return ALLOC_FAILED;
    }
    new_rc->refs = 1;
    new_rc->ls = *out = custom_labels_clone(rc->ls);
    if (!*out) [[unlikely]] {
      unref(new_rc);
      return ALLOC_FAILED;
    }
    if (!hm_insert(hm, async_id, new_rc, NULL)) [[unlikely]] {
      unref(new_rc);
      return ALLOC_FAILED;
    }
    --rc->refs;
  } else {
    *out = rc->ls;
  }
  return SUCCESS;
}

static void WithLabelsInternal(const FunctionCallbackInfo<Value> &args) {
  Isolate *isolate = args.GetIsolate();
  ensure_init();
  const int max_args = MAX_LABELS * 2 + 2;
  const int argc = args.Length();
  hm_error_t err;
  Local<v8::Context> context = isolate->GetCurrentContext();
  Local<Object> global = context->Global();
  Local<v8::Function> func;
  v8::MaybeLocal<Value> maybe;

  if (argc > max_args) [[unlikely]] {
    throw_str(isolate, "max " STR(MAX_LABELS) " labels per call");
    return;
  }
  if (argc < 2 || argc % 2) [[unlikely]] {
    throw_str(isolate, "withLabels(f, k, v, ...)");
    return;
  }
  if (!args[1]->IsFunction()) [[unlikely]] {
    throw_str(isolate, "withLabels(f, k, v, ...)");
    return;
  }
  func = args[1].As<v8::Function>();
  uint64_t async_id = val2int(args[0]);
  size_t n_labels = (argc - 2) / 2;
  custom_labels_label_t *labels =
      (custom_labels_label_t *)malloc(n_labels * sizeof *labels);
  size_t i;
  Local<Value> key, val;
  Local<v8::String> key_str, val_str;
  for (i = 0; i < n_labels; ++i) {
    labels[i].key.buf = (const unsigned char *)malloc(MAX_KEY_SIZE);
    labels[i].value.buf = (const unsigned char *)malloc(MAX_VAL_SIZE);
    if (!labels[i].key.buf || !labels[i].value.buf) [[unlikely]] {
      free((void *)labels[i].key.buf);
      free((void *)labels[i].value.buf);
      throw_str(isolate, "alloc failed");
      goto cleanup;
    }
    key = args[2 + 2 * i];
    if (!key->IsString()) [[unlikely]] {
      free((void *)labels[i].key.buf);
      free((void *)labels[i].value.buf);
      throw_str(isolate, "key and value must be strings");
      goto cleanup;
    }
    key_str = key.As<v8::String>();
    labels[i].key.len = key_str->WriteUtf8(
        isolate, (char *)labels[i].key.buf, MAX_KEY_SIZE, nullptr,
        v8::String::WriteOptions::NO_NULL_TERMINATION |
            v8::String::WriteOptions::REPLACE_INVALID_UTF8);

    val = args[3 + 2 * i];
    if (!val->IsString()) [[unlikely]] {
      free((void *)labels[i].key.buf);
      free((void *)labels[i].value.buf);
      throw_str(isolate, "key and value must be strings");
      goto cleanup;
    }
    val_str = val.As<v8::String>();
    labels[i].value.len = val_str->WriteUtf8(
        isolate, (char *)labels[i].value.buf, MAX_VAL_SIZE, nullptr,
        v8::String::WriteOptions::NO_NULL_TERMINATION |
            v8::String::WriteOptions::REPLACE_INVALID_UTF8);
  }

  custom_labels_labelset_t *ls;
  err = reify(async_id, n_labels, &ls);
  if (err) [[unlikely]] {
    throw_str(isolate, "alloc failed");
    goto cleanup;
  }

  for (size_t i = 0; i < n_labels; ++i) {
    custom_labels_string_t old_val;
    int error =
        custom_labels_careful_set(ls, labels[i].key, labels[i].value, &old_val);
    free((void *)labels[i].value.buf);
    labels[i].value = old_val;
    if (error) [[unlikely]] {
      throw_str(isolate, "alloc failed");
      goto cleanup;
    }
  }

  maybe = func->Call(context, global, 0, nullptr);
  if (maybe.IsEmpty()) [[unlikely]] {
    throw_str(isolate, "unexpected error!");
    goto cleanup;
  }
  args.GetReturnValue().Set(maybe.ToLocalChecked());

  err = reify(async_id, 0, &ls);
  if (err) [[unlikely]] {
    throw_str(isolate, "alloc failed");
    goto cleanup;
  }

  for (size_t i = 0; i < n_labels; ++i) {
    int error = 0;
    if (labels[i].value.buf)
      error =
          custom_labels_careful_set(ls, labels[i].key, labels[i].value, NULL);
    else
      custom_labels_careful_delete(ls, labels[i].key);
    if (error) [[unlikely]] {
      err = ALLOC_FAILED;
      break;
    }
  }
  if (err) [[unlikely]] {
    throw_error(isolate, err);
  }

cleanup:
  for (size_t j = 0; j < i; ++j) {
    free((void *)labels[j].key.buf);
    free((void *)labels[j].value.buf);
  }
  free(labels);
}

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-function-type"

NODE_MODULE_INIT() {
  NODE_SET_METHOD(exports, "withLabelsInternal", WithLabelsInternal);
  NODE_SET_METHOD(exports, "propagate", Propagate);
  NODE_SET_METHOD(exports, "destroy", Destroy);
}
} // namespace custom_labels

#pragma GCC diagnostic pop
