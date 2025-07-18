#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "hashmap.h"
#include "util.h"


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
  void *value;
} _bucket;

struct _hm {
  _bucket *buckets;
  uint64_t log2_capacity;

  // everything below here isn't part of the ABI
  uint64_t size;
};

// 60%
#define LF_NUM 3
#define LF_DENOM 5

static uint64_t _capacity(custom_labels_hashmap_t *self) { return 1ULL << self->log2_capacity; }

static bool _lf_reached(custom_labels_hashmap_t *self) {
  return self->size * LF_DENOM >= _capacity(self) * LF_NUM;
}

static _bucket *_bucket_for_key(custom_labels_hashmap_t *self, uint64_t key) {
  uint64_t h = _hash(key);
  uint64_t capacity = _capacity(self);

  for (int i = 0; i < capacity; ++i) {
    int pos = (h + i) % capacity;
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

static void _rehash(custom_labels_hashmap_t *self) {
  custom_labels_hashmap_t new;
  new.size = self->size;
  new.log2_capacity = self->log2_capacity + 1;
  new.buckets = calloc(_capacity(&new), sizeof(_bucket));

  for (int i = 0; i < _capacity(self); ++i) {
    _bucket *b = &self->buckets[i];
    if (b->value) {
      _bucket *new_b = _bucket_for_key(&new, b->key);
      assert(new_b && new_b->key == b->key);
      new_b->value = b->value;
    }
  }

  BARRIER;
  *self = new;
}

// Inserts a key-value pair into the hashmap.
// Precondition: value must not be null (use delete function to remove entries).
// Returns the previous value for the key, or NULL if the key was not present.
void *
custom_labels_hm_insert(custom_labels_hashmap_t *self, uint64_t key,
                        void *value) {
  assert(value);
  // rehash unconditionally, even if we don't actually end up inserting.
  // So we might rehash one element below where we "should", but who cares.
  if (_lf_reached(self))
    _rehash(self);
  _bucket *b = _bucket_for_key(self, key);
  assert(b && b->key == key);
  void *old = b->value;
  if (!old)
    ++self->size;
  b->value = value;
  return old;
}

void *custom_labels_hm_get(custom_labels_hashmap_t *self, uint64_t key) {
  _bucket *b = _bucket_for_key(self, key);
  assert(b);
  return b->value;
}

static int _pos(custom_labels_hashmap_t *self, uint64_t key) {
  uint64_t h = _hash(key);
  return h % _capacity(self);
}

void *custom_labels_hm_delete(custom_labels_hashmap_t *self, uint64_t key) {
  _bucket *b = _bucket_for_key(self, key);
  assert(b);
  void *old = b->value;
  if (!old)
    return NULL;

  --self->size;

  int pos = b - self->buckets;

  int blank_pos = pos;
  uint64_t cap = _capacity(self);
  int first_unknown = (blank_pos + 1) % cap;
  // This can't loop infinitely, because our load factor is <1 so we would have already rehashed by then.
  for (;;) {
    _bucket *next = &self->buckets[first_unknown];
    if (!next->value) break;
    int ideal_bucket = _hash(next->key) % cap;
    // if the path from ideal_bucket to next crosses the blank, we need
    // to move it. This is equivalent to considering the blank to be pos. 0
    // and checking if ideal_bucket is after next (or actually on the blank).
    int ideal_bucket_rotated = (ideal_bucket + cap - blank_pos) % cap;
    int first_unknown_rotated = (first_unknown + cap - blank_pos) % cap;
    bool crosses = first_unknown_rotated < ideal_bucket_rotated || ideal_bucket_rotated == 0;
    if (crosses) {
      self->buckets[blank_pos] = *next;
      blank_pos = first_unknown;
    }
    first_unknown = (first_unknown + 1) % cap;
  }
  BARRIER;
  self->buckets[blank_pos] = (_bucket){0};

  return old;
}

#define INITIAL_LOG2_CAPACITY 4

void custom_labels_hm_init(custom_labels_hashmap_t *self) {
  self->log2_capacity = INITIAL_LOG2_CAPACITY;
  self->buckets = calloc(_capacity(self), sizeof(_bucket));
  self->size = 0;
}
