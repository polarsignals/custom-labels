fn main() {
    println!("cargo:rerun-if-changed=src/tls_shim.c");
    println!("cargo:rerun-if-changed=./dlist");

    // Only compile the TLS shim on Linux.
    #[cfg(target_os = "linux")]
    {
        let mut build = cc::Build::new();

        // On x86-64, force TLSDESC dialect as required by the OTel spec.
        // On aarch64, TLSDESC is already the default.
        #[cfg(target_arch = "x86_64")]
        build.flag("-mtls-dialect=gnu2");

        build.file("src/tls_shim.c").compile("tls_shim");
    }

    println!("cargo:rustc-link-arg=-Wl,--dynamic-list=./dlist");

    // Compile protobuf definitions
    println!("cargo:rerun-if-changed=proto/");
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path().unwrap());
    prost_build::Config::new()
        .compile_protos(
            &["proto/opentelemetry/proto/common/v1/process_context.proto"],
            &["proto/"],
        )
        .expect("Failed to compile protobuf definitions");
}
