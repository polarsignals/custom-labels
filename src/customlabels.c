#include <assert.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>

#include "customlabels.h"

// The point of these barriers, which prevent the compiler from
// reordering code before or after, is to make sure that we can be
// interrupted at any instruction and the profiler will see a
// consistent state.
//
// For example, if we push a new label onto our array and then
// increment `count`, we must have a barrier
// in between. Otherwise, it's possible that the compiler will
// reorder the ++n store before the code that pushes the new label.
// Then if the profiler is invoked between those two points,
// it will see the new value of `count` and possibly
// try to read gibberish.
#define BARRIER asm volatile("": : :"memory")

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

/* thread_local_data = (tls) { NULL, 0 }; */

/* #define tls_count (custom_labels_thread_local_data.count) */
/* #define tls_storage (custom_labels_thread_local_data.storage) */

#define cur_count (custom_labels_current_set->count)
#define cur_storage (custom_labels_current_set->storage)
#define cur_capacity (custom_labels_current_set->capacity)

static bool eq(custom_labels_string_t l, custom_labels_string_t r) {
        return l.len == r.len &&
                !memcmp(l.buf, r.buf, l.len);
}

#include <stdio.h>

void custom_labels_labelset_print_debug(custom_labels_labelset_t *ls) {
  unsigned ct = ls->count;
  fprintf(stderr, "{");
  for (unsigned i = 0; i < ct; ++i) {
    custom_labels_label_t *lbl = &ls->storage[i];
    fprintf(stderr, "%.*s: %.*s", (int)lbl->key.len, lbl->key.buf, (int)lbl->value.len, lbl->value.buf);
    if (i != ct - 1)
            fprintf(stderr, ", ");
  }
  fprintf(stderr, "}");
}

static custom_labels_label_t *labelset_get_mut(custom_labels_labelset_t *ls, custom_labels_string_t key) {
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

static custom_labels_label_t *get_mut(custom_labels_string_t key) {
        if (!custom_labels_current_set)
                return NULL;
        return labelset_get_mut(custom_labels_current_set, key);
}

const custom_labels_label_t *custom_labels_get(custom_labels_string_t key) {
        return get_mut(key);
}

// `push` pushes a new element onto the current set's vector of labels.
// `key` must not be the same as any existing label's key, which must
// be checked by the caller.
static int push(custom_labels_string_t key, custom_labels_string_t value) {
        if (!custom_labels_current_set)
                return EFAULT;
        if (cur_count == cur_capacity) {
                size_t new_cap = MAX(2 * cur_capacity, 1);
                custom_labels_label_t *new_storage = malloc(sizeof(custom_labels_label_t) * new_cap);
                if (!new_storage) {
                        return errno;
                }
                memcpy(new_storage, cur_storage, sizeof(custom_labels_label_t) * cur_count);
                custom_labels_label_t *old_storage = cur_storage;
                // Need barriers on both sides because we have to prepare
                // the new storage, then point to it, then free the old storage,
                // in that order.
                BARRIER;
                cur_storage = new_storage;
                BARRIER;
                cur_capacity = new_cap;
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
        cur_storage[cur_count] = (custom_labels_label_t) {new_key, new_value};
        // Make sure the new item is written before the count is updated causing
        // the profiler to try to read it.
        BARRIER;
        ++cur_count;
        return 0;
}

static int labelset_push(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value) {
        if (ls->count == ls->capacity) {
                size_t new_cap = MAX(2 * ls->capacity, 1);
                ls->storage = reallocarray(ls->storage, new_cap, sizeof(custom_labels_label_t));
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
static void swap_delete(custom_labels_label_t *element) {
        assert(cur_count > 0);
        custom_labels_label_t *last = cur_storage + cur_count - 1;
        if (element == last) {
                --cur_count;
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
        --cur_count;
}

void custom_labels_delete(custom_labels_string_t key) {
        custom_labels_label_t *old = get_mut(key);
        if (old) {
                swap_delete(old);
        }
}

int custom_labels_set(custom_labels_string_t key, custom_labels_string_t value) {
        assert(key.buf);
        custom_labels_label_t *old = get_mut(key);
        int old_idx = old ? old - cur_storage : -1;
        int ret = push(key, value);
        if (ret) {
                return ret;
        }
        if (old_idx >= 0) {
                swap_delete(&cur_storage[old_idx]);
        }
        return 0;        
}

custom_labels_labelset_t *custom_labels_labelset_new(size_t capacity) {
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

int custom_labels_labelset_set(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value) {
        if (ls == custom_labels_current_set) {
                return custom_labels_set(key, value);
        }
        assert(key.buf);
        custom_labels_label_t *old = labelset_get_mut(ls, key);
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
        return labelset_push(ls, key, value);
}

void custom_labels_labelset_free(custom_labels_labelset_t *ls) {        
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

void custom_labels_labelset_delete(custom_labels_labelset_t *ls, custom_labels_string_t key) {
        if (ls == custom_labels_current_set) {
                return custom_labels_delete(key);
        }
        custom_labels_label_t *old = labelset_get_mut(ls, key);
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

custom_labels_labelset_t *custom_labels_labelset_replace(custom_labels_labelset_t *ls) {
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
        unsigned char *new_key_buf = malloc(lbl.key.len);
        if (!new_key_buf)
                return errno;
        memcpy(new_key_buf, lbl.key.buf, lbl.key.len);
        new_out->key = (custom_labels_string_t) {lbl.key.len, new_key_buf };

        unsigned char *new_val_buf = malloc(lbl.value.len);
        if (!new_val_buf) {
                free((void *)new_out->key.buf);
                return errno;
        }
        memcpy(new_val_buf, lbl.value.buf, lbl.value.len);
        new_out->value = (custom_labels_string_t) {lbl.value.len, new_val_buf };
        return 0;
}

// it's fine to call this with the current label 
custom_labels_labelset_t *custom_labels_labelset_clone(const custom_labels_labelset_t *ls) {
        custom_labels_labelset_t *new = custom_labels_labelset_new(ls->count);
        if (!new)
                return NULL;
        for (size_t i = 0; i < ls->count; ++i) {
                int ret = custom_labels_label_clone(ls->storage[i], &new->storage[i]);
                if (ret) {
                        new->count = i;
                        custom_labels_labelset_free(new);
                        return NULL;
                }
        }
        new->count = ls->count;
        return new;
}

// ok to call on current ls
const custom_labels_label_t *custom_labels_labelset_get(custom_labels_labelset_t *ls, custom_labels_string_t key) {
  return labelset_get_mut(ls, key);
}

const custom_labels_labelset_t *custom_labels_labelset_current() {
  return custom_labels_current_set;
}
