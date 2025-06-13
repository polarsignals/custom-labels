// addon.c
#include "addon.h"
#include "js_native_api.h"
#include "../src/customlabels.h"

#include <assert.h>
#include <errno.h>
#include <stdlib.h>

#define NODE_API_CALL(env, call)                                  \
  do {                                                            \
    napi_status status = (call);                                  \
    if (status != napi_ok) {                                      \
      const napi_extended_error_info* error_info = NULL;          \
      napi_get_last_error_info((env), &error_info);               \
      const char* err_message = error_info->error_message;        \
      bool is_pending;                                            \
      napi_is_exception_pending((env), &is_pending);              \
      /* If an exception is already pending, don't rethrow it */  \
      if (!is_pending) {                                          \
        const char* message = (err_message == NULL)               \
            ? "empty error message"                               \
            : err_message;                                        \
        napi_throw_error((env), NULL, message);                   \
      }                                                           \
      return NULL;                                                \
    }                                                             \
  } while(0)

struct ref_counted_labelset {
  custom_labels_labelset_t *native;
  unsigned n_refs;
};

struct labelset_ref {
  struct ref_counted_labelset *target;
};

#include <stdio.h>

static void pdbg(const struct labelset_ref *ref) {
  custom_labels_labelset_print_debug(ref->target->native);
  fprintf(stderr, " %p -> %p %d\n", ref, ref->target, ref->target->n_refs);
}

void LabelSetRefFz(napi_env env, void *finalize_data, void *finalize_hint) {
  struct labelset_ref *ref = (struct labelset_ref *)finalize_data;
  if (!--ref->target->n_refs) {
    custom_labels_labelset_free(ref->target->native);
    free(ref->target);
  }  
  free(ref);
}

static napi_ref labelset_ref_ctor_ref = NULL;

static napi_value LabelSetRefCtor(napi_env env, napi_callback_info info) {
  napi_value this;
  size_t argc = 1;
  napi_value arg = NULL;
  NODE_API_CALL(env, napi_get_cb_info(env, info, &argc, &arg, &this, NULL));
  
  bool isinstance;
  napi_value ctor;
  NODE_API_CALL(env, napi_get_reference_value(env, labelset_ref_ctor_ref, &ctor));
  NODE_API_CALL(env, napi_instanceof(env, this, ctor, &isinstance));
  if (!isinstance) {
    napi_throw_error(env, NULL, "Must be called with 'new'");
    return NULL;
  }

  struct ref_counted_labelset *target = NULL;
  if (argc > 0) {
    struct labelset_ref *parent = NULL;
    NODE_API_CALL(env, napi_instanceof(env, arg, ctor, &isinstance));
    if (!isinstance) {
      napi_throw_error(env, NULL, "arg must be of type LabelSetRef");
      return NULL;
    }
    NODE_API_CALL(env, napi_unwrap(env, arg, (void **)&parent));
    target = parent->target;
  }
  if (!target) {
    target = (struct ref_counted_labelset *)malloc(sizeof(struct ref_counted_labelset));
    if (!target) {
      napi_throw_error(env, NULL, "allocation failed!");
      return NULL;
    }
    target->n_refs = 0;
    target->native = custom_labels_labelset_new(0);
    if (!target->native) {
      napi_throw_error(env, NULL, "allocation failed!");
      free(target);
      return NULL;
    }
  }
  struct labelset_ref *ref = malloc(sizeof(struct labelset_ref));
  if (!ref) {
    if (target->n_refs == 0) {
      custom_labels_labelset_free(target->native);
      free(target);
    }
    napi_throw_error(env, NULL, "allocation failed!");
    return NULL;
  }
  ref->target = target;
  ++target->n_refs;
  
  NODE_API_CALL(env, napi_wrap(env, this, ref, LabelSetRefFz, NULL, NULL));

  return this;
}

static int
setOrDeleteValue(napi_env env, struct labelset_ref *ref, custom_labels_string_t key, custom_labels_string_t value) {
  assert(ref->target->n_refs > 0);
  // if there are other references to this label set, we need
  // to clone it here, so they don't get clobbered.
  bool should_clone = (ref->target->n_refs != 1);
  // if the given set is already installed, and we're about to clone it,
  // we need to install the new one after.
  bool must_install = (ref->target->native == custom_labels_current_set) && should_clone;
  struct ref_counted_labelset *old_target = NULL;
  if (should_clone) {
    --ref->target->n_refs;
    custom_labels_labelset_t *new_native = custom_labels_labelset_clone(ref->target->native);
    if (!new_native) {
      napi_throw_error(env, NULL, "allocation failed!");
      return errno;
    }
    old_target = ref->target;
    struct ref_counted_labelset *new_target = malloc(sizeof(struct ref_counted_labelset));
    if (!new_target) {
      custom_labels_labelset_free(new_native);
      napi_throw_error(env, NULL, "allocation failed!");
      return errno;
    }
    new_target->native = new_native;
    new_target->n_refs = 1;
    ref->target = new_target;
  }
  assert(should_clone == (bool)old_target);
  if (value.buf) {
    int err = custom_labels_labelset_set(ref->target->native, key, value);
    if (err) {
      // if we cloned, let's get rid of the clone and put back the old target.
      if (should_clone) {
        custom_labels_labelset_free(ref->target->native);
        free(ref->target);
        ref->target = old_target;
        ++ref->target->n_refs;
      }
      napi_throw_error(env, NULL, "allocation failed!");
      return err;
    }
  }
  else {
    custom_labels_labelset_delete(ref->target->native, key);
  }
  if (must_install) {
    custom_labels_labelset_replace(ref->target->native);
  }
  return 0;
}

#define THISCHK()                                                       \
  do {                                                                  \
    bool isinstance;                                                    \
    napi_value ctor;                                                    \
    NODE_API_CALL(env, napi_get_reference_value(env, labelset_ref_ctor_ref, &ctor)); \
    NODE_API_CALL(env, napi_instanceof(env, this, ctor, &isinstance));  \
    if (!isinstance) {                                                  \
      napi_throw_error(env, NULL, "this must be of type LabelSetRef");  \
      return NULL;                                                      \
    }                                                                   \
  } while (0)

// setValue(k, v)
// clones the underlying LS if there are other references to it,
// to avoid clobbering those. Otherwise, if we own it exclusively,
// just updates the value.
static napi_value
LabelSetSetValue(napi_env env, napi_callback_info info) {
  // XXX error handling (in entire file)
  napi_value this;
  size_t argc = 2;
  napi_value argv[2];
  NODE_API_CALL(env, napi_get_cb_info(env, info, &argc, argv, &this, NULL));
  THISCHK();
  if (argc != 2) {
    napi_throw_error(env, NULL, "setValue(k, v)");
    return NULL;
  }  
  
  char kbuf[64 + 1]; // +1 for null terminator
  size_t klen;
  char vbuf[64 + 1];
  size_t vlen;
  NODE_API_CALL(env, napi_get_value_string_utf8(env, argv[0], kbuf, sizeof(kbuf), &klen));
  NODE_API_CALL(env, napi_get_value_string_utf8(env, argv[1], vbuf, sizeof(vbuf), &vlen));

  struct labelset_ref *ref;
  NODE_API_CALL(env, napi_unwrap(env, this, (void **)&ref));
  // if the given set is already installed, and we're about to clone it,
  // we need to install the new one after.
  int err = setOrDeleteValue(env, ref, (custom_labels_string_t){klen, (unsigned char *)kbuf }, (custom_labels_string_t){vlen, (unsigned char *)vbuf});
  if (err) {
    napi_throw_error(env, NULL, "failed to set value");    
  }
  return NULL;
}

static napi_value
LabelSetGetValue(napi_env env, napi_callback_info info) {
  napi_value this;
  size_t argc = 1;
  napi_value argv[1];
  NODE_API_CALL(env, napi_get_cb_info(env, info, &argc, argv, &this, NULL));
  THISCHK();
  if (argc != 1) {
    napi_throw_error(env, NULL, "getValue(k)");
    return NULL;
  }
  struct labelset_ref *ref;
  NODE_API_CALL(env, napi_unwrap(env, this, (void **)&ref));

  char kbuf[64 + 1]; // +1 for null terminator
  size_t klen;
  NODE_API_CALL(env, napi_get_value_string_utf8(env, argv[0], kbuf, sizeof(kbuf), &klen));
  const custom_labels_label_t *lbl = custom_labels_labelset_get(ref->target->native, (custom_labels_string_t){klen, (unsigned char *)kbuf});
  if (!lbl)
    return NULL;

  napi_value result;
  NODE_API_CALL(env, napi_create_string_utf8(env, (const char *)lbl->value.buf, lbl->value.len, &result));
  return result;
}

static napi_value
LabelSetDeleteValue(napi_env env, napi_callback_info info) {
  napi_value this;
  size_t argc = 1;
  napi_value argv[1];
  NODE_API_CALL(env, napi_get_cb_info(env, info, &argc, argv, &this, NULL));
  THISCHK();
  if (argc != 1) {
    napi_throw_error(env, NULL, "deleteValue(k)");
    return NULL;
  }
  struct labelset_ref *ref;
  NODE_API_CALL(env, napi_unwrap(env, this, (void **)&ref));

  char kbuf[64 + 1]; // +1 for null terminator
  size_t klen;
  NODE_API_CALL(env, napi_get_value_string_utf8(env, argv[0], kbuf, sizeof(kbuf), &klen));

  int err = setOrDeleteValue(env, ref, (custom_labels_string_t){klen, (unsigned char *)kbuf}, (custom_labels_string_t) { 0, NULL});
  if (err) {
    napi_throw_error(env, NULL, "failed to delete value");
  }    

  return NULL;
}

static napi_value
LabelSetInstall(napi_env env, napi_callback_info info) {
  napi_value this;
  NODE_API_CALL(env, napi_get_cb_info(env, info, NULL, NULL, &this, NULL));
  struct labelset_ref *ref;
  NODE_API_CALL(env, napi_unwrap(env, this, (void **)&ref));

  custom_labels_labelset_replace(ref->target->native);
  return NULL;
}

static napi_value
LabelSetPrintDebug(napi_env env, napi_callback_info info) {
  napi_value this;
  NODE_API_CALL(env, napi_get_cb_info(env, info, NULL, NULL, &this, NULL));
  struct labelset_ref *ref;
  NODE_API_CALL(env, napi_unwrap(env, this, (void **)&ref));

  pdbg(ref);
  return NULL;
}


napi_value ClearLabelSet(napi_env env, napi_callback_info info) {
  custom_labels_labelset_replace(NULL);
  return NULL;
}


napi_value create_addon(napi_env env) {
  napi_value result;
  NODE_API_CALL(env, napi_create_object(env, &result));

  napi_value clear_label_set_function;
  NODE_API_CALL(env, napi_create_function(env,
                                          "clearLabelSet",
                                          NAPI_AUTO_LENGTH,
                                          ClearLabelSet,
                                          NULL,
                                          &clear_label_set_function));

  NODE_API_CALL(env, napi_set_named_property(env,
                                             result,
                                             "clearLabelSet",
                                             clear_label_set_function));
  
  napi_value labelset_ref;

  napi_property_descriptor properties[] = {
    { "setValue", NULL, LabelSetSetValue, NULL, NULL, NULL, napi_default, NULL },
    { "getValue", NULL, LabelSetGetValue, NULL, NULL, NULL, napi_default, NULL },
    { "deleteValue", NULL, LabelSetDeleteValue, NULL, NULL, NULL, napi_default, NULL },
    { "install", NULL, LabelSetInstall, NULL, NULL, NULL, napi_default, NULL },
    { "printDebug", NULL, LabelSetPrintDebug, NULL, NULL, NULL, napi_default, NULL },
  };
  
  NODE_API_CALL(env, napi_define_class(env, "LabelSetRef", NAPI_AUTO_LENGTH, LabelSetRefCtor,
                                       NULL, sizeof(properties)/sizeof(properties[0]), properties, &labelset_ref));

  NODE_API_CALL(env, napi_create_reference(env, labelset_ref, 1, &labelset_ref_ctor_ref));

  NODE_API_CALL(env, napi_set_named_property(env, result, "LabelSetRef", labelset_ref));
                                       
  
  return result;
}
