#include <stdio.h>
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include "hashmap.h"

// Internal structures for testing (copied from hashmap.c)
typedef struct {
  uint64_t key;
  void *value;
} _bucket;

typedef struct {
  _bucket *buckets;
  uint64_t log2_capacity;
  uint64_t size;
} _hm;

custom_labels_hashmap_t *cast(_hm *h) {
  return (custom_labels_hashmap_t *)h;
}

_hm *tsac(custom_labels_hashmap_t *h) {
  return (_hm *)h;
}

// Test data structure
typedef struct {
    int value;
} test_data_t;

// Test helper functions
static void test_basic_operations(void) {
    printf("Testing basic operations...\n");
    
    _hm *hm = tsac(custom_labels_hm_alloc());
    assert(hm);
    
    test_data_t data1 = {42};
    test_data_t data2 = {100};
    test_data_t data3 = {200};
    
    // Test insertion
    void *old;
    bool success = custom_labels_hm_insert(cast(hm), 1, &data1, &old);
    assert(success);
    assert(old == NULL);
    
    success = custom_labels_hm_insert(cast(hm), 2, &data2, &old);
    assert(success);
    assert(old == NULL);
    
    // Test retrieval
    test_data_t *retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), 1);
    assert(retrieved == &data1);
    assert(retrieved->value == 42);
    
    retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), 2);
    assert(retrieved == &data2);
    assert(retrieved->value == 100);
    
    // Test update
    success = custom_labels_hm_insert(cast(hm), 1, &data3, &old);
    assert(success);
    assert(old == &data1);
    
    retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), 1);
    assert(retrieved == &data3);
    assert(retrieved->value == 200);
    
    // Test deletion
    old = custom_labels_hm_delete(cast(hm), 1);
    assert(old == &data3);
    
    retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), 1);
    assert(retrieved == NULL);
    
    // Test deletion of non-existent key
    old = custom_labels_hm_delete(cast(hm), 999);
    assert(old == NULL);
    
    printf("Basic operations test passed!\n");
    
    custom_labels_hm_free(cast(hm));
}

static void test_collisions(void) {
    printf("Testing collision handling...\n");
    
    _hm *hm = tsac(custom_labels_hm_alloc());
    
    // Create test data
    test_data_t data[10];
    for (int i = 0; i < 10; i++) {
        data[i].value = i * 10;
    }
    
    // Insert multiple keys that will likely collide
    for (int i = 0; i < 10; i++) {
        void *old;
        bool success = custom_labels_hm_insert(cast(hm), i, &data[i], &old);
        assert(success);
        assert(old == NULL);
    }
    
    // Verify all keys can be retrieved
    for (int i = 0; i < 10; i++) {
        test_data_t *retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), i);
        assert(retrieved == &data[i]);
        assert(retrieved->value == i * 10);
    }
    
    // Delete every other key
    for (int i = 0; i < 10; i += 2) {
        void *old = custom_labels_hm_delete(cast(hm), i);
        assert(old == &data[i]);
    }
    
    // Verify remaining keys are still accessible
    for (int i = 1; i < 10; i += 2) {
        test_data_t *retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), i);
        assert(retrieved == &data[i]);
        assert(retrieved->value == i * 10);
    }
    
    // Verify deleted keys are not accessible
    for (int i = 0; i < 10; i += 2) {
        test_data_t *retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), i);
        assert(retrieved == NULL);
    }
    
    printf("Collision handling test passed!\n");
    
    custom_labels_hm_free(cast(hm));
}

static void test_rehashing(void) {
    printf("Testing rehashing...\n");
    
    _hm *hm = tsac(custom_labels_hm_alloc());
    
    // Insert enough elements to trigger rehashing
    // Initial capacity is 16, load factor is 60%, so rehash at 10 elements
    test_data_t data[20];
    for (int i = 0; i < 20; i++) {
        data[i].value = i * 5;
    }
    
    // Insert 20 elements to trigger multiple rehashes
    for (int i = 0; i < 20; i++) {
        void *old;
        bool success = custom_labels_hm_insert(cast(hm), i + 1000, &data[i], &old);
        assert(success);
        assert(old == NULL);
    }
    
    // Verify all elements are still accessible after rehashing
    for (int i = 0; i < 20; i++) {
        test_data_t *retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), i + 1000);
        assert(retrieved == &data[i]);
        assert(retrieved->value == i * 5);
    }
    
    // Test deletion after rehashing
    for (int i = 0; i < 10; i++) {
        void *old = custom_labels_hm_delete(cast(hm), i + 1000);
        assert(old == &data[i]);
    }
    
    // Verify remaining elements
    for (int i = 10; i < 20; i++) {
        test_data_t *retrieved = (test_data_t *)custom_labels_hm_get(cast(hm), i + 1000);
        assert(retrieved == &data[i]);
        assert(retrieved->value == i * 5);
    }
    
    printf("Rehashing test passed!\n");
    
    custom_labels_hm_free(cast(hm));
}

static void test_deletion_edge_cases(void) {
    printf("Testing deletion edge cases...\n");
    
    _hm *hm = tsac(custom_labels_hm_alloc());
    
    test_data_t data1 = {1};
    test_data_t data2 = {2};
    test_data_t data3 = {3};
    test_data_t data4 = {4};
    
    // Create a chain of colliding keys
    uint64_t key1 = 100;
    uint64_t key2 = 116;  // These will likely collide with initial capacity
    uint64_t key3 = 132;
    uint64_t key4 = 148;

    bool success;
    success = custom_labels_hm_insert(cast(hm), key1, &data1, NULL);
    assert(success);
    success = custom_labels_hm_insert(cast(hm), key2, &data2, NULL);
    assert(success);
    success = custom_labels_hm_insert(cast(hm), key3, &data3, NULL);
    assert(success);
    success = custom_labels_hm_insert(cast(hm), key4, &data4, NULL);
    assert(success);
    
    // Delete middle element
    void *old = custom_labels_hm_delete(cast(hm), key2);
    assert(old == &data2);
    
    // Verify remaining elements are still accessible
    assert(custom_labels_hm_get(cast(hm), key1) == &data1);
    assert(custom_labels_hm_get(cast(hm), key2) == NULL);
    assert(custom_labels_hm_get(cast(hm), key3) == &data3);
    assert(custom_labels_hm_get(cast(hm), key4) == &data4);
    
    // Delete first element
    old = custom_labels_hm_delete(cast(hm), key1);
    assert(old == &data1);
    
    // Verify remaining elements
    assert(custom_labels_hm_get(cast(hm), key1) == NULL);
    assert(custom_labels_hm_get(cast(hm), key3) == &data3);
    assert(custom_labels_hm_get(cast(hm), key4) == &data4);
    
    printf("Deletion edge cases test passed!\n");
    
    custom_labels_hm_free(cast(hm));
}

static void test_large_keys(void) {
    printf("Testing large key values...\n");
    
    _hm *hm = tsac(custom_labels_hm_alloc());
    
    test_data_t data1 = {999};
    test_data_t data2 = {888};
    
    uint64_t large_key1 = 0xDEADBEEFCAFEBABE;
    uint64_t large_key2 = 0x1234567890ABCDEF;

    bool success;
    success = custom_labels_hm_insert(cast(hm), large_key1, &data1, NULL);
    assert(success);
    success = custom_labels_hm_insert(cast(hm), large_key2, &data2, NULL);
    assert(success);
    
    test_data_t *retrieved1 = (test_data_t *)custom_labels_hm_get(cast(hm), large_key1);
    test_data_t *retrieved2 = (test_data_t *)custom_labels_hm_get(cast(hm), large_key2);
    
    assert(retrieved1 == &data1);
    assert(retrieved2 == &data2);
    assert(retrieved1->value == 999);
    assert(retrieved2->value == 888);
    
    printf("Large key test passed!\n");
    
    custom_labels_hm_free(cast(hm));
}

// Sanity check function that verifies hashmap integrity
static void sanity_check_hashmap(_hm *hm) {
    uint64_t capacity = 1ULL << hm->log2_capacity;
    uint64_t found_elements = 0;
    
    // Iterate through all buckets
    for (uint64_t i = 0; i < capacity; i++) {
        _bucket *bucket = &hm->buckets[i];
        
        // If bucket is occupied, verify it can be found via get
        if (bucket->value != NULL) {
            found_elements++;
            
            // Try to find this key using the public API
            void *found = custom_labels_hm_get(cast(hm), bucket->key);
            
            // The key should be found and should point to the same value
            if (found != bucket->value) {
                printf("SANITY CHECK FAILED: Key %lu at bucket %lu not findable via get!\n", 
                       bucket->key, i);
                printf("Expected value: %p, Found value: %p\n", bucket->value, found);
                abort();
            }
        }
    }
    
    // Verify the size matches the number of occupied buckets
    if (found_elements != hm->size) {
        printf("SANITY CHECK FAILED: Size mismatch! Expected %lu, found %lu\n", 
               hm->size, found_elements);
        abort();
    }
}

static void test_random_operations(void) {
    printf("Testing random operations with sanity checks...\n");
    
    // Use fixed seed for deterministic randomness
    srand(42);
    
    _hm *hm = tsac(custom_labels_hm_alloc());
    
    // Test data pool - we'll use indices into this array as values
    #define TEST_DATA_SIZE 10000
    test_data_t test_data[TEST_DATA_SIZE];
    for (int i = 0; i < TEST_DATA_SIZE; i++) {
        test_data[i].value = i;
    }
    
    // Track which keys we've inserted
    #define MAX_KEYS 10000
    uint64_t active_keys[MAX_KEYS];
    int num_active_keys = 0;

    const int N_ROUNDS = 50000;
    // Perform thousands of random operations
    for (int round = 0; round < 50000; round++) {
        if (!(round % 100))
            printf("%d / %d\n", round, N_ROUNDS);
        int operation = rand() % 100;
        
        if (operation < 60 && num_active_keys < MAX_KEYS) {
            // 60% chance: Insert a new key
            uint64_t new_key = rand() % 100000;
            
            // Check if key already exists
            bool key_exists = false;
            for (int i = 0; i < num_active_keys; i++) {
                if (active_keys[i] == new_key) {
                    key_exists = true;
                    break;
                }
            }
            
            if (!key_exists) {
                int data_index = rand() % TEST_DATA_SIZE;
                void *old;
                bool success = custom_labels_hm_insert(cast(hm), new_key, &test_data[data_index], &old);
                assert(success);
                assert(old == NULL);
                
                active_keys[num_active_keys++] = new_key;
            }
        } else if (operation < 90 && num_active_keys > 0) {
            // 30% chance: Delete an existing key
            int key_index = rand() % num_active_keys;
            uint64_t key_to_delete = active_keys[key_index];

            void *old = custom_labels_hm_delete(cast(hm), key_to_delete);
            assert(old != NULL);
            
            // Remove from active keys array
            for (int i = key_index; i < num_active_keys - 1; i++) {
                active_keys[i] = active_keys[i + 1];
            }
            num_active_keys--;
        } else if (num_active_keys > 0) {
            // 10% chance: Update an existing key
            int key_index = rand() % num_active_keys;
            uint64_t key_to_update = active_keys[key_index];
            
            int data_index = rand() % TEST_DATA_SIZE;
            void *old;
            bool success = custom_labels_hm_insert(cast(hm), key_to_update, &test_data[data_index], &old);
            assert(success);
            assert(old != NULL);
        }
        
        sanity_check_hashmap(hm);
            
        // Also verify all active keys are still findable
        for (int i = 0; i < num_active_keys; i++) {
          void *found = custom_labels_hm_get(cast(hm), active_keys[i]);
          if (found == NULL) {
            printf("CONSISTENCY CHECK FAILED: Active key %lu not found!\n", active_keys[i]);
            abort();
          }
        }
    }
    
    printf("Random operations test passed! Performed 5000 operations with %d final keys.\n", num_active_keys);
    
    custom_labels_hm_free(cast(hm));
}

int main(void) {
    printf("Running hashmap test suite...\n\n");
    
    test_basic_operations();
    test_collisions();
    test_rehashing();
    test_deletion_edge_cases();
    test_large_keys();
    test_random_operations();
    
    printf("\nAll tests passed! Hashmap implementation is working correctly.\n");
    return 0;
}
