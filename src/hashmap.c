#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "customlabels.h"

// From https://stackoverflow.com/a/12996028/242814
// which got it from public-domain code.
//
// Changing this function is a breaking ABI change!
static uint64_t _hash(uint64_t x) {
  x = (x ^ (x >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
  x = (x ^ (x >> 27)) * UINT64_C(0x94d049bb133111eb);
  x = x ^ (x >> 31);
  return x;
}

typedef struct {
  uint64_t key;
  custom_labels_labelset_t *value;
} _bucket;

typedef struct {
  _bucket *buckets;
  uint64_t capacity;

  // everything below here isn't part of the ABI
  uint64_t size;
} _hm;

// 60%
#define LF_NUM 3
#define LF_DENOM 5

static bool _lf_reached(_hm *self) {
  return self->size * LF_DENOM >= self->capacity * LF_NUM;
}

static _bucket *_bucket_for_key(_hm *self, uint64_t key) {
  uint64_t h = _hash(key);

  for (int i = 0; i < self->capacity; ++i) {
    int pos = (h + i) % self->capacity;
    _bucket *b = &self->buckets[pos];
    if (!b->value) {
      b->key = key;
      return b;
    }
    if (b->key == key)
      return b;
  }
  // the map is entirely full? This should never happen; it should
  // have been rehashed by now.
  return NULL;
}

static void _rehash(_hm *self) {
  size_t new_sz = self->capacity * sizeof(_bucket) * 2;
  _bucket *old_buckets = self->buckets;
  self->buckets = malloc(new_sz);
  memset(self->buckets, 0, new_sz);

  for (int i = 0; i < self->capacity; ++i) {
    _bucket *b = &old_buckets[i];
    if (b->value) {
      _bucket *new_b = _bucket_for_key(self, b->key);
      assert(new_b && new_b->key == b->key);
      new_b->value = b->value;
    }
  }
  self->capacity *= 2;

  free(old_buckets);
}

// Inserts a key-value pair into the hashmap.
// Precondition: value must not be null (use delete function to remove entries).
// Returns the previous value for the key, or NULL if the key was not present.
custom_labels_labelset_t *insert(_hm *self, uint64_t key,
                                 custom_labels_labelset_t *value) {
  assert(value);
  // rehash unconditionally, even if we don't actually end up inserting.
  // So we might rehash one element below where we "should", but who cares.
  if (_lf_reached(self))
    _rehash(self);
  _bucket *b = _bucket_for_key(self, key);
  assert(b && b->key == key);
  custom_labels_labelset_t *old = b->value;
  if (!old)
    ++self->size;
  b->value = value;
  return old;
}

custom_labels_labelset_t *get(_hm *self, uint64_t key) {
  _bucket *b = _bucket_for_key(self, key);
  assert(b);
  return b->value;
}

custom_labels_labelset_t *delete(_hm *self, uint64_t key) {
  _bucket *b = _bucket_for_key(self, key);
  assert(b);
  custom_labels_labelset_t *old = b->value;
  if (!old)
    return NULL;

  --self->size;

  // move future buckets for the same hash over so linear probing still works.
#define NEXT_BUCKET(b)                                                         \
  ((b + 1 == self->buckets + self->capacity) ? self->buckets : (b + 1))
  _bucket *next;
  while (next = NEXT_BUCKET(b), (next->value && (_hash(next->key) == _hash(key) )))
    *b++ = *next;

#undef NEXT_BUCKET

  return old;
}
