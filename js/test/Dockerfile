# Image for running this package's test suite on Linux. The addon is
# Linux-only, so non-Linux developers (Mac in particular) need a Linux
# environment to actually exercise it. node-gyp needs python3 and a C++
# toolchain; everything else comes from the base node:22 image.
FROM node:22-bookworm

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
        python3 \
        build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/work
