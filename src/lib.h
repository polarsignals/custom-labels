typedef unsigned long size_t;
typedef unsigned uint32_t;

typedef struct {
        size_t len;
        const unsigned char *buf;
} custom_labels_string_t;

typedef struct {
        custom_labels_string_t key;
        custom_labels_string_t value;
} custom_labels_label_t;

/**
 * The version of the ABI in use.
 * Currently 0.
 */
extern uint32_t custom_labels_abi_version;

/**
 *
 * Get the label corresponding to a key, or NULL if none exists.
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
 * Delete a custom label, if it exists.
 */
void custom_labels_delete(custom_labels_string_t key);

/**
 * Set a new custom label, or reset an existing one.
 *
 * SAFETY:
 * The caller must not pass a NULL value for key.buf
 *
 * Returns 0 on success, `errno` otherwise.
 */
int custom_labels_set(custom_labels_string_t key, custom_labels_string_t value);
