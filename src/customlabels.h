#ifndef CUSTOMLABELS_H
#define CUSTOMLABELS_H
#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

typedef unsigned long size_t;
typedef unsigned uint32_t;

typedef struct {
        size_t len;
        const unsigned char *buf;
} custom_labels_string_t;

/**
 * <div rustbindgen nocopy></div>
 */
typedef struct {
        custom_labels_string_t key;
        custom_labels_string_t value;
} custom_labels_label_t;

struct _custom_labels_ls;
typedef struct _custom_labels_ls custom_labels_labelset_t;

/**
 * <div rustbindgen hide></div>
 */
extern __thread custom_labels_labelset_t *custom_labels_current_set;


/**
 * Get a pointer to the current label set on this thread.
 */
custom_labels_labelset_t *custom_labels_current();

/**
 * Get the label corresponding to a key on the given label set, or NULL if none exists.
 *
 * This function forwards to `custom_labels_careful_get` if `ls` is the current set.
 * 
 * SAFETY:
 * The caller must not attempt to mutate anything through the
 * returned pointer.
 *
 * The caller must not attempt to access the returned pointer
 * after any function that mutates the internal state is called.
 * That is, after any call to `custom_labels_set` or `custom_labels_delete`
 * (or the corresponding careful versions),
 * any pointer returned by a previous call to `custom_labels_get` is invalid.
 */
const custom_labels_label_t *custom_labels_get(custom_labels_labelset_t *ls, custom_labels_string_t key);

/**
 * Delete a custom label, if it exists, on the given label set.
 *
 * This function forwards to `custom_labels_careful_delete` if `ls`
 * is the current set.
 */
void custom_labels_delete(custom_labels_labelset_t *ls, custom_labels_string_t key);

/**
 * Writes a debug string representing the given label set into `out`.
 * If successful, the caller must free `out->buf`.
 *
 * Returns 0 on success, `errno` otherwise.
 */
int custom_labels_debug_string(const custom_labels_labelset_t *ls, custom_labels_string_t *out);

/**
 * Set a new custom label, or reset an existing one, on the given label set.
 *
 * Optionally, if `old_value_out` is non-NULL, write the old value into it
 * (writing old_value_out->buf = NULL if there was no old value).
 * If a non-NULL value is written into old_value_out->buf, the caller is
 * responsible for freeing it.
 *
 * This function forwards to `custom_labels_careful_set` if `ls`
 * is the current set.
 *
 * This function copies in the given strings and thus does not take
 * ownership of the memory they point to.
 *
 * SAFETY:
 * The caller must not pass a NULL value for key.buf
 *
 * Returns 0 on success, `errno` otherwise.
 */
// TODO -- to avoid unnecessary copies, there should probably be
// a few more versions of this function,
// that take ownership of key and/or value instead of copying them in,
// or that neither take ownership nor copy them in, and
// don't delete them when resetting them, where the client
// takes care that they are valid for as long as they're in the map.
//
// Actually, maybe the latter thing is only useful in run_with, and we could just
// open-code that logic there. But I think the first part
// (taking by either ownership or copying in) will be more generally important.
//
// This would be a lot easier in Rust FWIW.
int custom_labels_set(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value, custom_labels_string_t *old_value_out);

/**
 * Create a new label set.
 *
 * Returns the new label set on success, NULL on failure.
 */
custom_labels_labelset_t *custom_labels_new(size_t capacity);

/**
 * Frees all memory associated with a label set.
 *
 * SAFETY: The label set must not be currently installed.
 */
void custom_labels_free(custom_labels_labelset_t *ls);

/**
 * Install the given label set as the current one, returning the old one.
 */
custom_labels_labelset_t *custom_labels_replace(custom_labels_labelset_t *ls);

/**
 * Clone the given label set.
 *
 * Returns the clone on success, NULL otherwise.
 */
custom_labels_labelset_t *custom_labels_clone(const custom_labels_labelset_t *ls);

/**
 * Run the supplied callback function (passing it the supplied data pointer)
 * with the supplied set of N labels applied,
 * then re-set the old values. Optionally, if out is non-NULL,
 * write the return value of the callback into out.
 */
int custom_labels_run_with(custom_labels_labelset_t *ls, custom_labels_label_t *labels, int n, void *(*cb)(void *), void *data, void **out);

/**
 * Get the number of labels in the label set.
 */
size_t custom_labels_count(custom_labels_labelset_t *ls);
// "careful" functions:
// These all do the same thing as the non-careful versions.
//
// The difference is that they are written to ensure signal-safety:
// that is, the thread can be interrupted at any instruction,
// and a consistent state can be read by external code.

void custom_labels_careful_delete(custom_labels_labelset_t *ls, custom_labels_string_t key);

int custom_labels_careful_set(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value, custom_labels_string_t *old_value_out);

int custom_labels_careful_run_with(custom_labels_labelset_t *ls, custom_labels_label_t *labels, int n, void *(*cb)(void *), void *data, void **out);

#ifdef __cplusplus
}
#endif
    
#endif // CUSTOMLABELS_H
