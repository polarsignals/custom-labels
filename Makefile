CC = gcc
CFLAGS ?= -O2 -g
TARGET = libcustomlabels.so
SRCS = src/customlabels.c

ARCH := $(shell uname -m)

ifeq ($(ARCH),aarch64)
    TLS_DIALECT = desc
else ifeq ($(ARCH),x86_64)
    TLS_DIALECT = gnu2
else
    $(error only aarch64 and x86-64 are supported)
endif

$(TARGET): $(SRCS)
	$(CC) $(CFLAGS) -ftls-model=global-dynamic -mtls-dialect=$(TLS_DIALECT) -fPIC -shared -o $(TARGET) $(SRCS)

test_hashmap: src/test_hashmap.c src/hashmap.c
	clang $(CFLAGS) -fsanitize=undefined -Isrc -o test_hashmap src/test_hashmap.c src/hashmap.c

clean:
	rm -f $(TARGET) test_hashmap
