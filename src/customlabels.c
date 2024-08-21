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
const uint32_t custom_labels_abi_version = 0;

typedef struct {
  custom_labels_label_t *storage;
  size_t count;
} tls;

__attribute__((retain))
__thread tls custom_labels_thread_local_data = (tls) { NULL, 0 };

#define tls_count (custom_labels_thread_local_data.count)
#define tls_storage (custom_labels_thread_local_data.storage)

static __thread size_t capacity = 0;

static bool eq(custom_labels_string_t l, custom_labels_string_t r) {
        return l.len == r.len &&
                !memcmp(l.buf, r.buf, l.len);
}

static custom_labels_label_t *custom_labels_get_mut(custom_labels_string_t key) {
        for (size_t i = 0; i < tls_count; ++i) {
                if (!tls_storage[i].key.buf) {
                        continue;
                }
                if (eq(tls_storage[i].key, key)) {
                        return &tls_storage[i];
                }
        }
        return NULL;
}

const custom_labels_label_t *custom_labels_get(custom_labels_string_t key) {
        return custom_labels_get_mut(key);
}

// `push` pushes a new element onto the thread-local vector of labels.
// `key` must not be the same as any existing label's key, which must
// be checked by the caller.
static int push(custom_labels_string_t key, custom_labels_string_t value) {
        if (tls_count == capacity) {
                size_t new_cap = MAX(2 * capacity, 1);
                custom_labels_label_t *new_storage = malloc(sizeof(custom_labels_label_t) * new_cap);
                if (!new_storage) {
                        return errno;
                }
                memcpy(new_storage, tls_storage, sizeof(custom_labels_label_t) * tls_count);
                custom_labels_label_t *old_storage = tls_storage;
                // Need barriers on both sides because we have to prepare
                // the new storage, then point to it, then free the old storage,
                // in that order.
                BARRIER;
                tls_storage = new_storage;
                BARRIER;
                capacity = new_cap;
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
        tls_storage[tls_count] = (custom_labels_label_t) {new_key, new_value};
        // Make sure the new item is written before the count is updated causing
        // the profiler to try to read it.
        BARRIER;
        ++tls_count;
        return 0;
}

// swap_delete deletes the label `element`
// by overwriting it with the last label and decrementing
// `count` by one (thus changing the order of labels, but we don't care)
static void swap_delete(custom_labels_label_t *element) {
        assert(tls_count > 0);
        custom_labels_label_t *last = tls_storage + tls_count - 1;
        if (element == last) {
                --tls_count;
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
        --tls_count;
}

void custom_labels_delete(custom_labels_string_t key) {
        custom_labels_label_t *old = custom_labels_get_mut(key);
        if (old) {
                swap_delete(old);
        }
}

int custom_labels_set(custom_labels_string_t key, custom_labels_string_t value) {
        assert(key.buf);
        custom_labels_label_t *old = custom_labels_get_mut(key);
        int old_idx = old ? old - tls_storage : -1;
        int ret = push(key, value);
        if (ret) {
                return ret;
        }
        if (old_idx >= 0) {
                swap_delete(&tls_storage[old_idx]);
        }
        return 0;        
}
