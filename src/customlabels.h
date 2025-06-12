typedef unsigned long size_t;
typedef unsigned uint32_t;

/**
 * <div rustbindgen nocopy></div>
 */
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
 *
 * Get the label corresponding to a key on the current label set, or NULL if none exists.
 *
 * SAFETY:
 * The caller must not attempt to mutate anything through the
 * returned pointer.
 *
 * The caller must not attempt to access the returned pointer
 * after any function that mutates the internal state is called.
 * That is, after any call to `custom_labels_set` or `custom_labels_delete`,
 * any pointer returned by a previous call to `custom_labels_get` is invalid.
 */
const custom_labels_label_t *custom_labels_get(custom_labels_string_t key);

/**
 * Delete a custom label, if it exists, on the current label set.
 */
void custom_labels_delete(custom_labels_string_t key);

void custom_labels_labelset_print_debug(custom_labels_labelset_t *ls);

/**
 * Set a new custom label, or reset an existing one, on the current label set.
 *
 * SAFETY:
 * The caller must not pass a NULL value for key.buf
 *
 * Returns 0 on success, `errno` otherwise.
 */
int custom_labels_set(custom_labels_string_t key, custom_labels_string_t value);

/**
 * Create a new label set.
 * 
 * Returns the new label set on success, NULL on failure.
 */
custom_labels_labelset_t *custom_labels_labelset_new(size_t capacity);

/**
 * Set a new custom label, or reset an existing one, on a given label set.
 * 
 * SAFETY:
 * The caller must not pass a NULL value for key.buf
 * 
 * Returns 0 on success, `errno` otherwise.
 */
int custom_labels_labelset_set(custom_labels_labelset_t *ls, custom_labels_string_t key, custom_labels_string_t value);

/**
 * Frees all memory associated with a label set.
 * 
 * SAFETY: The label set must not be currently installed.
 */
void custom_labels_labelset_free(custom_labels_labelset_t *ls);

/**
 * Delete a custom label, if it exists, on the given label set.
 */
void custom_labels_labelset_delete(custom_labels_labelset_t *ls, custom_labels_string_t key);

/**
 * Install the given label set as the current one, returning the old one.
 */
custom_labels_labelset_t *custom_labels_labelset_replace(custom_labels_labelset_t *ls);

/**
 * Clone the given label set.
 * 
 * Returns the clone on success, NULL otherwise.
 */
custom_labels_labelset_t *custom_labels_labelset_clone(const custom_labels_labelset_t *ls);

/**
 * Get the label corresponding to a key on the given label set, or NULL if none exists.
 * 
 * SAFETY:
 * The caller must not attempt to mutate anything through the returned pointer.
 * 
 * The caller must not attempt to access the returned pointer
 * after any function that mutates the given label set is called.
 */
const custom_labels_label_t *custom_labels_labelset_get(custom_labels_labelset_t *ls, custom_labels_string_t key);

/**
 * Get the currently active label set.
 */
const custom_labels_labelset_t *custom_labels_labelset_current();
