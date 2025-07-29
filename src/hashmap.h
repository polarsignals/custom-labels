#ifndef HASHMAP_H
#define HASHMAP_H

#include <stdint.h>

// Forward declaration of hashmap type
struct _hm;
typedef struct _hm custom_labels_hashmap_t;

// Initialize a new hashmap
custom_labels_hashmap_t *custom_labels_hm_alloc();

// Free a hashmap
void custom_labels_hm_free(custom_labels_hashmap_t *self);

// Insert a key-value pair into the hashmap
// Precondition: value must not be null (use delete function to remove entries)
// Returns the previous value for the key, or NULL if the key was not present
void *custom_labels_hm_insert(custom_labels_hashmap_t *self, uint64_t key, void *value);

// Get a value from the hashmap
// Returns the value for the key, or NULL if the key is not present
void *custom_labels_hm_get(custom_labels_hashmap_t *self, uint64_t key);

// Delete a key-value pair from the hashmap
// Returns the previous value for the key, or NULL if the key was not present
void *custom_labels_hm_delete(custom_labels_hashmap_t *self, uint64_t key);

#endif // HASHMAP_H
