// addon.c
#include "addon.h"
#include "../src/customlabels.h"
#include "../src/hashmap.h"
#include "js_native_api.h"

#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdlib.h>

// returns true if success; otherwise, throws
// an exception if one is not already pending and
// then returns false.
static bool check_status(napi_env env, napi_status status) {
  if (status != napi_ok) {
    const napi_extended_error_info *error_info = NULL;
    napi_get_last_error_info(env, &error_info);
    const char *err_message = error_info->error_message;
    bool is_pending;
    napi_is_exception_pending(env, &is_pending);
    /* If an exception is already pending, don't rethrow it */
    if (!is_pending) {
      const char *message =
          (err_message == NULL) ? "empty error message" : err_message;
      napi_throw_error((env), NULL, message);
    }
  }
  return status == napi_ok;
}

#define NODE_API_CALL(env, call)                                               \
  do {                                                                         \
    napi_status status = (call);                                               \
    if (!check_status((env), status)) {                                        \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

// should this be per-isolate?
__thread custom_labels_hashmap_t *custom_labels_async_hashmap;

custom_labels_hashmap_t *btv_getit() {
  return custom_labels_async_hashmap;
}

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

typedef enum { SUCCESS, ALLOC_FAILED, CHILD_ALREADY_EXISTED } error_t;

static void unref(labelset_rc *rc) {
  if (rc && !--rc->refs)
    free(rc);
}

static error_t ensure_init() {
  if (!hm)
    init();
  if (!hm)
    return ALLOC_FAILED;
  return SUCCESS;
}

static error_t propagate(uint64_t parent, uint64_t child) {
  int error;
  if ((error = ensure_init()))
    return error;
  labelset_rc *parent_rc = hm_get(hm, parent);
  if (parent_rc) {
    ++parent_rc->refs;
    labelset_rc *old = hm_insert(hm, child, parent_rc);
    if (old) {
      unref(old);
      return CHILD_ALREADY_EXISTED;
    }
  }
  return SUCCESS;
}

static error_t destroy(uint64_t id) {
  int error;
  if ((error = ensure_init()))
    return error;
  labelset_rc *rc = hm_delete(hm, id);
  unref(rc);
  return SUCCESS;
}

static napi_value Destroy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv;
  NODE_API_CALL(env, napi_get_cb_info(env, info, &argc, &argv, NULL, NULL));
  if (argc != 1) {
    napi_throw_error(env, NULL, "destroy(async_id)");
    return NULL;
  }

  uint64_t async_id;
  NODE_API_CALL(env, napi_get_value_int64(env, argv, (int64_t *)&async_id));

  error_t err = destroy(async_id);
  // TODO - error handling
  assert(!err);
  return NULL;
}

static napi_value Propagate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NODE_API_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc != 2) {
    napi_throw_error(env, NULL, "propagate(parent_id, child_id)");
    return NULL;
  }

  uint64_t parent_id, child_id;
  NODE_API_CALL(env, napi_get_value_int64(env, argv[0], (int64_t *)&parent_id));
  NODE_API_CALL(env, napi_get_value_int64(env, argv[1], (int64_t *)&child_id));

  error_t err = propagate(parent_id, child_id);
  // TODO - error handling
  assert(!err);
  return NULL;
}


#define MAX_LABELS 10
#define MAX_KEY_SIZE 16
#define MAX_VAL_SIZE 48

#define STR_HELPER(x) #x
#define STR(x) STR_HELPER(x)

typedef struct {
  napi_env env;
  napi_value function;
} cb_data;

// napi_status napi_get_global(napi_env env, napi_value* result)
static void *cb(void *data_) {
  cb_data *data = data_;
  napi_value global;
  napi_env env = data->env;
  napi_value func = data->function;
  NODE_API_CALL(env, napi_get_global(env, &global));
  napi_value result;
  NODE_API_CALL(env, napi_call_function(env, global, func, 0, NULL, &result));

  return result;
}

static napi_value WithLabelsInternal(napi_env env, napi_callback_info info) {
  void *retval = NULL;
  ensure_init();
  const size_t max_args = MAX_LABELS * 2 + 2;
  size_t argc = max_args;
  napi_value argv[max_args];
  NODE_API_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 2 || argc % 2) {
    napi_throw_error(env, NULL, "withLabels(f, k, v, ...)");
    return NULL;
  }
  if (argc > max_args) {
    napi_throw_error(env, NULL, "max " STR(MAX_LABELS) " labels per call");
    return NULL;
  }
  uint64_t async_id;
  NODE_API_CALL(env, napi_get_value_int64(env, argv[0], (int64_t *)&async_id));

  size_t n_labels = (argc - 1) / 2;
  custom_labels_label_t *labels = malloc(n_labels * sizeof *labels);
  size_t i;
  for (i = 0; i < n_labels; ++i) {
    labels[i].key.buf = malloc(MAX_KEY_SIZE + 1);
    labels[i].value.buf = malloc(MAX_VAL_SIZE + 1);
    if (!labels[i].key.buf || !labels[i].value.buf) {
      free((void *)labels[i].key.buf);
      free((void *)labels[i].value.buf);
      napi_throw_error(env, NULL, "alloc failed");
      goto cleanup;
    }
    napi_status status = napi_get_value_string_utf8(
        env, argv[2 + 2 * i], (char *)labels[i].key.buf, MAX_KEY_SIZE,
        &labels[i].key.len);
    if (!check_status(env, status)) {
      free((void *)labels[i].key.buf);
      free((void *)labels[i].value.buf);
      goto cleanup;
    }
    status = napi_get_value_string_utf8(env, argv[3 + 2 * i],
                                        (char *)labels[i].value.buf,
                                        MAX_VAL_SIZE, &labels[i].value.len);
    if (!check_status(env, status)) {
      free((void *)labels[i].key.buf);
      free((void *)labels[i].value.buf);
      goto cleanup;
    }
  }

  // TODO: should the HM have a get_or_insert function ?
  labelset_rc *rc = hm_get(hm, async_id);
  custom_labels_labelset_t *ls = NULL;
  if (!rc) {
    rc = malloc(sizeof *rc);
    // TODO handle alloc error
    rc->refs = 1;
    rc->ls = ls = custom_labels_new(n_labels);
    // TODO handle alloc error
    hm_insert(hm, async_id, rc);
  } else if (rc->refs > 1) {
    --rc->refs;
    custom_labels_labelset_t *old = rc->ls;
    rc = malloc(sizeof *rc);
    // TODO handle alloc error
    rc->refs = 1;
    rc->ls = ls = custom_labels_clone(old);
    // TODO handle alloc error
    hm_insert(hm, async_id, rc);
  } else {
    ls = rc->ls;
  }

  cb_data d = (cb_data){env, argv[1]};

  int error =
      custom_labels_careful_run_with(ls, labels, n_labels, cb, &d, &retval);
  // TODO fix this
  assert(!error);

cleanup:
  for (size_t j = 0; j < i; ++j) {
    free((void *)labels[j].key.buf);
    free((void *)labels[j].value.buf);
  }
  free(labels);

  return retval;
}

napi_value create_addon(napi_env env) {
  napi_value result;
  NODE_API_CALL(env, napi_create_object(env, &result));

  napi_value with_labels_function;
  NODE_API_CALL(env, napi_create_function(env, "withLabelsInternal",
                                          NAPI_AUTO_LENGTH, WithLabelsInternal,
                                          NULL, &with_labels_function));
  NODE_API_CALL(env, napi_set_named_property(env, result, "withLabelsInternal",
                                             with_labels_function));

  napi_value propagate_function;
  NODE_API_CALL(env, napi_create_function(env, "propagate",
                                          NAPI_AUTO_LENGTH, Propagate,
                                          NULL, &propagate_function));
  NODE_API_CALL(env, napi_set_named_property(env, result, "propagate",
                                             propagate_function));

  napi_value destroy_function;
  NODE_API_CALL(env, napi_create_function(env, "destroy",
                                          NAPI_AUTO_LENGTH, Destroy,
                                          NULL, &destroy_function));
  NODE_API_CALL(env, napi_set_named_property(env, result, "destroy",
                                             destroy_function));  

  return result;
}
