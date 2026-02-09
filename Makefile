CXX = g++
CXXFLAGS ?= -O2 -g
TARGET = libcustomlabels.so
SRCS = src/customlabels.cpp
HEADERS = src/customlabels.h src/util.h

ARCH := $(shell uname -m)

ifeq ($(ARCH),aarch64)
    TLS_DIALECT = desc
else ifeq ($(ARCH),x86_64)
    TLS_DIALECT = gnu2
else
    $(error only aarch64 and x86-64 are supported)
endif

$(TARGET): $(SRCS) $(HEADERS)
	$(CXX) $(CXXFLAGS) -ftls-model=global-dynamic -mtls-dialect=$(TLS_DIALECT) -fPIC -shared -o $(TARGET) $(SRCS)

clean:
	rm -f $(TARGET) test_hashmap
