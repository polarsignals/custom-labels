//! # OTel Thread Context
//!
//! This library provides a mechanism for OpenTelemetry SDKs to publish
//! thread-level attributes for out-of-process readers such as the
//! OpenTelemetry eBPF profilers.

/// Low-level interface to the underlying C library.
pub mod sys {
    #[allow(non_camel_case_types)]
    #[allow(non_upper_case_globals)]
    #[allow(non_snake_case)]
    #[allow(dead_code)]
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}

/// Generated protobuf types for OTel process context.
pub mod proto {
    pub mod opentelemetry {
        pub mod proto {
            pub mod common {
                pub mod v1 {
                    include!(concat!(env!("OUT_DIR"), "/opentelemetry.proto.common.v1.rs"));
                }
            }
            pub mod resource {
                pub mod v1 {
                    include!(concat!(env!("OUT_DIR"), "/opentelemetry.proto.resource.v1.rs"));
                }
            }
        }
    }
}

pub mod otel_process_ctx;

/// Utilities for build scripts
pub mod build {
    /// Emit the instructions required for an
    /// executable to expose custom labels data.
    pub fn emit_build_instructions() {
        #[cfg(target_os = "linux")]
        {
            let dlist_path = format!("{}/dlist", std::env::var("OUT_DIR").unwrap());
            std::fs::write(&dlist_path, include_str!("../dlist")).unwrap();
            println!("cargo:rustc-link-arg=-Wl,--dynamic-list={}", dlist_path);
        }
    }
}
