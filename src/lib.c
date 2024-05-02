#include <assert.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>

#include "lib.h"

// The point of these barriers, which prevent the compiler from
// reordering code before or after, is to make sure that we can be
// interrupted at any instruction and the profiler will see a
// consistent state.
//
// For example, if we push a new label onto our array and then
// increment `n_profiling_custom_labels`, we must have a barrier
// in between. Otherwise, it's possible that the compiler will
// reorder the ++n store before the code that pushes the new label.
// Then if the profiler is invoked between those two points,
// it will see the new value of `n_profiling_custom_labels` and possibly
// try to read gibberish.
#define BARRIER asm volatile("": : :"memory")

#define MAX(a,b) ((a) > (b) ? (a) : (b))

uint32_t custom_labels_abi_version = 0;

__thread custom_labels_label_t *custom_labels_storage = NULL;
__thread size_t custom_labels_count = 0;

static __thread size_t profiling_custom_labels_capacity = 0;

static bool eq(custom_labels_string_t l, custom_labels_string_t r) {
        return l.len == r.len &&
                !memcmp(l.buf, r.buf, l.len);
}

static custom_labels_label_t *custom_labels_get_mut(custom_labels_string_t key) {
        for (size_t i = 0; i < custom_labels_count; ++i) {
                if (!custom_labels_storage[i].key.buf) {
                        continue;
                }
                if (eq(custom_labels_storage[i].key, key)) {
                        return &custom_labels_storage[i];
                }
        }
        return NULL;
}

const custom_labels_label_t *custom_labels_get(custom_labels_string_t key) {
        return custom_labels_get_mut(key);
}

static int push(custom_labels_string_t key, custom_labels_string_t value) {
        if (custom_labels_count == profiling_custom_labels_capacity) {
                size_t new_cap = MAX(2 * profiling_custom_labels_capacity, 1);
                custom_labels_label_t *new_profiling_custom_labels = malloc(sizeof(custom_labels_label_t) * new_cap);
                if (!new_profiling_custom_labels) {
                        return errno;
                }
                memcpy(new_profiling_custom_labels, custom_labels_storage, sizeof(custom_labels_label_t) * custom_labels_count);
                BARRIER;
                custom_labels_label_t *old_profiling_custom_labels = custom_labels_storage;
                custom_labels_storage = new_profiling_custom_labels;
                profiling_custom_labels_capacity = new_cap;
                BARRIER;
                free(old_profiling_custom_labels);
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
        custom_labels_storage[custom_labels_count] = (custom_labels_label_t) {new_key, new_value};
        BARRIER;
        ++custom_labels_count;
        return 0;
}

static void swap_delete(custom_labels_label_t *element) {
        assert(custom_labels_count > 0);
        custom_labels_label_t *last = custom_labels_storage + custom_labels_count - 1;
        if (element == last) {
                --custom_labels_count;
                BARRIER;
                free((void*)element->key.buf);
                free((void*)element->value.buf);
                return;
        }
        custom_labels_string_t old_key = element->key;
        element->key.buf = NULL;
        BARRIER;
        free((void*)old_key.buf);
        free((void*)element->value.buf);
        element->value = last->value;
        element->key.len = last->key.len;
        BARRIER;
        element->key.buf = last->key.buf;
        BARRIER;
        --custom_labels_count;
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
        int old_idx = old ? old - custom_labels_storage : -1;
        int ret = push(key, value);
        if (ret) {
                return ret;
        }
        if (old_idx >= 0) {
                swap_delete(&custom_labels_storage[old_idx]);
        }
        return 0;        
}
