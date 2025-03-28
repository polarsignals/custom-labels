fn main() {
    println!("cargo:rerun-if-changed=src/customlabels.c");
    println!("cargo:rerun-if-changed=src/customlabels.h");
    println!("cargo:rerun-if-changed=./dlist");

    cc::Build::new()
        .file("src/customlabels.c")
        .compile("customlabels");

    println!("cargo:rustc-link-lib=static=customlabels");
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
