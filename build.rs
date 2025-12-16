trait BuildExt {
    fn sanflags(&mut self) -> &mut Self;
}

impl BuildExt for cc::Build {
    #[cfg(feature = "sanitized")]
    fn sanflags(&mut self) -> &mut cc::Build {
        self.flag("-fsanitize=address,undefined")
            .flag("-O1")
            .flag("-g")
            .flag("-fno-omit-frame-pointer")
            .flag("-fno-optimize-sibling-calls")
            .flag("-static-libsan")
    }

    #[cfg(not(feature = "sanitized"))]
    fn sanflags(&mut self) -> &mut cc::Build {
        self
    }
}

fn main() {
    println!("cargo:rerun-if-changed=src/customlabels.cpp");
    println!("cargo:rerun-if-changed=src/customlabels.h");
    println!("cargo:rerun-if-changed=./dlist");

    cc::Build::new()
        .file("src/customlabels.cpp")
        .sanflags()
        .compile("customlabels");

    // println!("cargo:rustc-link-arg=-fsanitize=address,undefined");
    // println!("cargo:rustc-link-arg=-static-libsan");
    println!("cargo:rustc-link-lib=static=customlabels");
    // println!("cargo:rustc-link-lib=asan");
    // println!("cargo:rustc-link-lib=ubsan");
    println!("cargo:rustc-link-arg=-Wl,--dynamic-list=./dlist");

    // let dlist_path = format!("{}/dlist", std::env::var("OUT_DIR").unwrap());
    // std::fs::copy("./dlist", &dlist_path).unwrap();

    // println!("cargo::metadata=dlist-path={}", dlist_path);

    // Generate bindings using bindgen
    let bindings = bindgen::Builder::default()
        .header("src/customlabels.h")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("Unable to generate bindings");

    // Write the bindings to the $OUT_DIR/bindings.rs file.
    let out_path = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("Couldn't write bindings!");
}
