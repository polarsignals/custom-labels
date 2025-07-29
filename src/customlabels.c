#include <assert.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>

#include "customlabels.h"
#include "util.h"

#define MAX(a,b) ((a) > (b) ? (a) : (b))

__attribute__((retain))
const uint32_t custom_labels_abi_version = 1;

struct _custom_labels_ls {
  custom_labels_label_t *storage;
  size_t count;
  size_t capacity;
};

__attribute__((retain))
__thread custom_labels_labelset_t *custom_labels_current_set = NULL;

static bool eq(custom_labels_string_t l, custom_labels_string_t r) {
        return l.len == r.len &&
                !memcmp(l.buf, r.buf, l.len);
}

#include <stdio.h>

int custom_labels_debug_string(const custom_labels_labelset_t *ls, custom_labels_string_t *out) {
        out->len = 2; // for '{' and '}'
        for (size_t i = 0; i < ls->count; ++i) {
                out->len += ls->storage[i].key.len;
                out->len += 2; // for ': '
                out->len += ls->storage[i].value.len;
                if (i > 0) {
                        out->len += 2; // for ', '
                }
        }

        unsigned char *s = malloc(out->len);
        if (!s) {
                return errno;
        }
        out->buf = s;

        *s++ = '{';
        for (size_t i = 0; i < ls->count; ++i) {
                const custom_labels_label_t *lbl = &ls->storage[i];

                if (i > 0) {
                        *s++ = ',';
                        *s++ = ' ';
                }

                memcpy(s, lbl->key.buf, lbl->key.len);
                s += lbl->key.len;

                *s++ = ':';
                *s++ = ' ';

                memcpy(s, lbl->value.buf, lbl->value.len);
                s += lbl->value.len;
        }
        *s++ = '}';

        assert((s - out->buf) == (ssize_t) out->len);

        return 0;
}

static custom_labels_label_t *get_mut(custom_labels_labelset_t *ls, custom_labels_string_t key) {
        for (size_t i = 0; i < ls->count; ++i) {
                if (!ls->storage[i].key.buf) {
                        continue;
                }
                if (eq(ls->storage[i].key, key)) {
                        return &ls->storage[i];
                }
        }
        return NULL;
}

const custom_labels_label_t *custom_labels_get(custom_labels_labelset_t *ls, custom_labels_string_t key) {
        return get_mut(ls, key);
}

// `push` pushes a new element onto the current set's vector of labels.
// `key` must not be the same as any existing label's key, which must
// be checked by the caller.
static int careful_push(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value) {
        if (ls->count == ls->capacity) {
                size_t new_cap = MAX(2 * ls->capacity, 1);
                custom_labels_label_t *new_storage = malloc(sizeof(custom_labels_label_t) * new_cap);
                if (!new_storage) {
                        return errno;
                }
                memcpy(new_storage, ls->storage, sizeof(custom_labels_label_t) * ls->count);
                custom_labels_label_t *old_storage = ls->storage;
                // Need barriers on both sides because we have to prepare
                // the new storage, then point to it, then free the old storage,
                // in that order.
                BARRIER;
                ls->storage = new_storage;
                BARRIER;
                ls->capacity = new_cap;
                free(old_storage);
        }
        unsigned char *new_key_buf = malloc(key.len);
        if (!new_key_buf) {
                return errno;
        }
        memcpy(new_key_buf, key.buf, key.len);
        unsigned char *new_value_buf = malloc(value.len);
        if (!new_value_buf) {
                free(new_key_buf);
                return errno;
        }
        memcpy(new_value_buf, value.buf, value.len);
        custom_labels_string_t new_key = {key.len, new_key_buf};
        custom_labels_string_t new_value = {value.len, new_value_buf};
        ls->storage[ls->count] = (custom_labels_label_t) {new_key, new_value};
        // Make sure the new item is written before the count is updated causing
        // the profiler to try to read it.
        BARRIER;
        ++ls->count;
        return 0;
}

static int push(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value) {
        if (ls == custom_labels_current_set)
                return careful_push(ls, key, value);
        if (ls->count == ls->capacity) {
                size_t new_cap = MAX(2 * ls->capacity, 1);
                ls->storage = realloc(ls->storage, new_cap * sizeof(custom_labels_label_t));
                ls->capacity = new_cap;
                if (!ls->storage)
                        return errno;
        }
        unsigned char *new_key_buf = malloc(key.len);
        if (!new_key_buf) {
                return errno;
        }
        memcpy(new_key_buf, key.buf, key.len);
        unsigned char *new_value_buf = malloc(value.len);
        if (!new_value_buf) {
                free(new_key_buf);
                return errno;
        }
        memcpy(new_value_buf, value.buf, value.len);
        custom_labels_string_t new_key = {key.len, new_key_buf};
        custom_labels_string_t new_value = {value.len, new_value_buf};
        ls->storage[ls->count++] = (custom_labels_label_t) {new_key, new_value};
        return 0;
}

// swap_delete deletes the label `element`
// by overwriting it with the last label and decrementing
// `count` by one (thus changing the order of labels, but we don't care)
static void careful_swap_delete(custom_labels_labelset_t *ls, custom_labels_label_t *element) {
        assert(ls->count > 0);
        custom_labels_label_t *last = ls->storage + ls->count - 1;
        if (element == last) {
                --ls->count;
                // Make sure memory is freed after decrementing the count
                // causing profilers to no longer try to read it.
                BARRIER;
                free((void*)element->key.buf);
                free((void*)element->value.buf);
                return;
        }
        custom_labels_string_t old_key = element->key;
        element->key.buf = NULL;
        // The ABI specifies that profilers must ignore
        // elements with null keys. So the element has now
        // been deleted from the profiler's perspective.
        //
        // The barrier ensures that this is done before freeing the associated memory.
        BARRIER;
        free((void*)old_key.buf);
        free((void*)element->value.buf);
        element->value = last->value;
        element->key.len = last->key.len;
        // The element that was previously freed is now equivalent to the last element,
        // except that its `key.buf` has not been set. The barrier here ensures that
        // everything is set up before doing that, so the profiler doesn't see any intermediate state.
        BARRIER;
        element->key.buf = last->key.buf;
        // Now there are two visible copies of the same label: both `element` and `last`.
        // The ABI specifies that profilers are to ignore subsequent copies of labels for
        // the same key, so this is fine.
        //
        // The barrier ensures that the label is visible in `element` before it's no longer visible
        // in `last`.
        BARRIER;
        --ls->count;
}

void custom_labels_careful_delete(custom_labels_labelset_t *ls, custom_labels_string_t key) {
        if (!ls) return;
        custom_labels_label_t *old = get_mut(ls, key);
        if (old) {
                careful_swap_delete(ls, old);
        }
}

// if error, no allocation
static int custom_labels_string_clone(custom_labels_string_t s, custom_labels_string_t *new_out) {
        if (!new_out)
                return 0;
        if (!s.buf) {
                *new_out = (custom_labels_string_t) { 0 };
                return 0;
        }
        unsigned char *new_buf = malloc(s.len);
        if (!new_buf)
                return errno;
        memcpy(new_buf, s.buf, s.len);
        *new_out = (custom_labels_string_t) {s.len, new_buf };
        return 0;
}


int custom_labels_careful_set(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value, custom_labels_string_t *old_value_out) {
        int error;
        
        assert(key.buf);
        custom_labels_label_t *old = get_mut(ls, key);
        if (old_value_out) {
                if (old) {
                        error = custom_labels_string_clone(old->value, old_value_out);
                        if (error)
                                return error;
                } else {
                        *old_value_out = (custom_labels_string_t) { 0 };
                }
        }
        int old_idx = old ? old - ls->storage : -1;
        int ret = careful_push(ls, key, value);
        if (ret) {
                return ret;
        }
        if (old_idx >= 0) {
                careful_swap_delete(ls, &ls->storage[old_idx]);
        }
        return 0;        
}

custom_labels_labelset_t *custom_labels_new(size_t capacity) {
        custom_labels_labelset_t *ls = malloc(sizeof(custom_labels_labelset_t));
        if (!ls)
                return NULL;
        custom_labels_label_t *storage = calloc(capacity, sizeof(custom_labels_label_t));
        if (!storage) {
                free(ls);
                return NULL;
        }
        *ls = (custom_labels_labelset_t) { storage, 0, capacity };
        return ls;
}

int custom_labels_set(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value, custom_labels_string_t *old_value_out) {
        int error;
        if (ls == custom_labels_current_set) {
                return custom_labels_careful_set(ls, key, value, old_value_out);
        }
        assert(key.buf);
        custom_labels_label_t *old = get_mut(ls, key);
        if (old_value_out) {
                if (old) {
                        error = custom_labels_string_clone(old->value, old_value_out);
                        if (error)
                                return error;
                } else {
                        *old_value_out = (custom_labels_string_t) { 0 };
                }
        }

        if (old) {
                unsigned char *new_value_buf = malloc(value.len);
                if (!new_value_buf) {
                        return errno;
                }
                memcpy(new_value_buf, value.buf, value.len);
                free((void *)old->value.buf);

                old->value = (custom_labels_string_t){ value.len, new_value_buf };
                return 0;
        }
        return push(ls, key, value);
}

void custom_labels_free(custom_labels_labelset_t *ls) {        
        if (!ls)
                return;
        assert(ls != custom_labels_current_set);
        for (size_t i = 0; i < ls->count; ++i) {
                free((void *)ls->storage[i].key.buf);
                free((void *)ls->storage[i].value.buf);
        }
        free(ls->storage);
        free(ls);
}

void custom_labels_delete(custom_labels_labelset_t *ls, custom_labels_string_t key) {
        if (!ls)
                return;
        if (ls == custom_labels_current_set) {
                return custom_labels_careful_delete(ls, key);
        }
        custom_labels_label_t *old = get_mut(ls, key);
        if (old) {
                // this block is like swap_delete, but far simpler due to not needing barriers
                assert(ls->count > 0); // impossible to be empty if we got here.
                custom_labels_label_t *last = &ls->storage[ls->count - 1];
                free((void *)old->key.buf);
                free((void *)old->value.buf);
                *old = *last;
                --ls->count;
        }
}

custom_labels_labelset_t *custom_labels_replace(custom_labels_labelset_t *ls) {
        custom_labels_labelset_t *old = custom_labels_current_set;
        // Whatever operations the user tried to do on `ls` have to be finished
        // before we install it
        BARRIER;        
        custom_labels_current_set = ls;
        // likewise, we need to have installed it before
        // the user tries to do anything with the old one.
        BARRIER;
        return old;
}

static int custom_labels_label_clone(custom_labels_label_t lbl, custom_labels_label_t *new_out) {
        if (!new_out)
                return 0;

        int error;
        error = custom_labels_string_clone(lbl.key, &new_out->key);
        if (error) {
                return error;
        }

        error = custom_labels_string_clone(lbl.value, &new_out->value);
        if (error) {
                free((void *)new_out->key.buf);
                return error;
        }
        return 0;
}

custom_labels_labelset_t *custom_labels_clone(const custom_labels_labelset_t *ls) {
        custom_labels_labelset_t *new = custom_labels_new(ls->count);
        if (!new)
                return NULL;
        for (size_t i = 0; i < ls->count; ++i) {
                int ret = custom_labels_label_clone(ls->storage[i], &new->storage[i]);
                if (ret) {
                        new->count = i;
                        custom_labels_free(new);
                        return NULL;
                }
        }
        new->count = ls->count;
        return new;
}

custom_labels_labelset_t *custom_labels_current() {
        return custom_labels_current_set;
}

// TODO - does it matter that these are not applied atomically? The
// profiler can see a torn state... (some applied, some not).
int custom_labels_run_with(custom_labels_labelset_t *ls, custom_labels_label_t *labels, int n, void *(*cb)(void *), void *data, void **out) {
        // NB: It's ok to call this on the current set, since
        // the `custom_labels_set` functions will forward to the careful ones.
        // But rewrite this to forward to custom_labels_careful_run_with
        // if we ever change it and need to do any other mutating operations.
        int error;
        // TODO -- maybe avoid an allocation here with a smallvec approach?
        custom_labels_string_t *values = malloc(n * sizeof(custom_labels_string_t));
        if (!values)
                return errno;
        for (int i = 0; i < n; ++i) {
                error = custom_labels_set(ls, labels[i].key, labels[i].value, &values[i]);
                if (error) {
                        for (int j = 0; j < i; ++j) {
                                free((void *)values[i].buf);
                        }
                        return error;
                }
        }
        void *cb_ret = cb(data);
        if (out) {
                *out = cb_ret;
        }
        error = 0;
        for (int i = 0; i < n; ++i) {
                error = custom_labels_set(ls, labels[i].key, values[i], NULL);
                if (error)
                        break;
        }
        for (int i = 0; i < n; ++i) {
                free((void *)values[i].buf);
        }
        return error;
}

int custom_labels_careful_run_with(custom_labels_labelset_t *ls, custom_labels_label_t *labels, int n, void *(*cb)(void *), void *data, void **out) {
        // custom_labels_run_with inherits the carefulness of custom_labels_set.
        return custom_labels_run_with(ls, labels, n, cb, data, out);
}
