//! # Custom labels for profilers.
//!
//! ## Overview
//!
//! This library provides Rust bindings to [v1 of the Custom Labels ABI](../custom-labels-v1.md).
//!
//! It allows time ranges within a thread's execution to be annotated with labels (key/value pairs) in such a way
//! that the labels are visible to a CPU profiler that may
//! interrupt the running process at any time. The profiler can then report the labels
//! that were active at any given time in the profiles it produces.
//!
//! The main interface is [`with_label`], which sets a label to a provided value,
//! executes a function, and then resets the label to its old value (or removes it if there was no old value).
//!
//! For example, imagine a program that performs database queries on behalf of a user. It might have a function
//! like the following:
//!
//! ```rust
//! # struct DbResultSet;
//! #
//! # fn do_query(sql: &str) -> DbResultSet {
//! #     DbResultSet
//! # }
//! #
//! fn query_for_user(username: &str, sql: &str) -> DbResultSet {
//!     custom_labels::with_label("username", username, || do_query(sql))
//! }
//! ```
//!
//! If two users named "Marta" and "Petros" repeatedly query the database, a profiler might produce a
//! CPU profile like the following:
//! ```text
//! * all (13.4s)
//! |
//! +---- username: Marta (4.9s)
//! |   |
//! |   +---- query_for_user (4.9s)
//! |       |
//! |       + ---- custom_labels::with_label (4.9s)
//! |            |
//! |            + ---- do_query (4.9s)
//! |
//! +---- username: Petros (8.5s)
//!     |
//!     +---- query_for_user (8.5s)
//!         |
//!         + ---- custom_labels::with_label (8.5s)
//!              |
//!              + ---- do_query (8.5s)
//! ```
//!
//! ## Profiler Support
//!
//! The following profilers can make use of the labels set with this library:
//! * [Parca](parca.dev) (when using parca-agent v0.33.0 and later)
//! * [Polar Signals Cloud](https://www.polarsignals.com) (when using parca-agent v0.33.0 and later).
//!
//! If you work on another profiler that also supports this format, [send us a PR](https://github.com/polarsignals/custom-labels)
//! to update this list!

use std::ptr::NonNull;

/// Low-level interface to the underlying C library.
pub mod sys {
    #[allow(non_camel_case_types)]
    mod c {
        include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
    }

    pub use c::custom_labels_label_t as Label;
    pub use c::custom_labels_labelset_t as Labelset;
    pub use c::custom_labels_string_t as String;

    impl<'a> From<&'a [u8]> for self::String {
        fn from(value: &'a [u8]) -> Self {
            Self {
                len: value.len(),
                buf: value.as_ptr(),
            }
        }
    }

    impl Clone for self::String {
        fn clone(&self) -> Self {
            unsafe {
                let buf = libc::malloc(self.len);
                if buf.is_null() {
                    panic!("Out of memory");
                }
                libc::memcpy(buf, self.buf as *const _, self.len);
                Self {
                    len: self.len,
                    buf: buf as *mut _,
                }
            }
        }
    }

    impl Drop for self::String {
        fn drop(&mut self) {
            unsafe {
                libc::free(self.buf as *mut _);
            }
        }
    }

    pub use c::custom_labels_delete as delete;
    pub use c::custom_labels_get as get;
    pub use c::custom_labels_set as set;

    // these aren't used yet in the higher-level API,
    // but use them here to prevent "unused" warnings.
    pub use c::custom_labels_labelset_clone as labelset_clone;
    pub use c::custom_labels_labelset_current as labelset_current;
    pub use c::custom_labels_labelset_delete as labelset_delete;
    pub use c::custom_labels_labelset_free as labelset_free;
    pub use c::custom_labels_labelset_get as labelset_get;
    pub use c::custom_labels_labelset_new as labelset_new;
    pub use c::custom_labels_labelset_replace as labelset_replace;
    pub use c::custom_labels_labelset_set as labelset_set;
}

/// Utilities for build scripts
pub mod build {
    /// Emit the instructions required for an
    /// executable to expose custom labels data.
    pub fn emit_build_instructions() {
        let dlist_path = format!("{}/dlist", std::env::var("OUT_DIR").unwrap());
        std::fs::write(&dlist_path, include_str!("../dlist")).unwrap();
        println!("cargo:rustc-link-arg=-Wl,--dynamic-list={}", dlist_path);
    }
}

/// A set of key-value labels that can be installed as the current label set.
pub struct Labelset {
    raw: NonNull<sys::Labelset>,
}

unsafe impl Send for Labelset {}

impl Labelset {
    /// Create a new label set.
    pub fn new() -> Self {
        Self::with_capacity(0)
    }

    /// Create a new label set with the specified capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        let raw = unsafe { sys::labelset_new(capacity) };
        let raw = NonNull::new(raw).expect("failed to allocate labelset");
        Self { raw }
    }

    /// Create a new label set by cloning the current one, if it exists,
    /// or creating a new one otherwise.
    pub fn clone_from_current() -> Self {
        Self::try_clone_from_current().unwrap_or_default()
    }

    /// Create a new label set by cloning the current one, if it exists,
    pub fn try_clone_from_current() -> Option<Self> {
        let raw = unsafe { sys::labelset_current() };
        if raw.is_null() {
            None
        } else {
            let raw = unsafe { sys::labelset_clone(raw) };
            let raw = NonNull::new(raw).expect("failed to clone labelset");
            Some(Self { raw })
        }
    }

    /// Run a function with this set of labels applied.
    pub fn enter<F, Ret>(&mut self, f: F) -> Ret
    where
        F: FnOnce() -> Ret,
    {
        struct Guard {
            old: *mut sys::Labelset,
        }

        impl Drop for Guard {
            fn drop(&mut self) {
                unsafe { sys::labelset_replace(self.old) };
            }
        }

        let old = unsafe { sys::labelset_replace(self.raw.as_ptr()) };
        let _guard = Guard { old };
        f()
    }

    /// Adds the specified key-value pair to the label set.
    pub fn set<K, V>(&mut self, key: K, value: V)
    where
        K: AsRef<[u8]>,
        V: AsRef<[u8]>,
    {
        unsafe {
            sys::labelset_set(
                self.raw.as_ptr(),
                key.as_ref().into(),
                value.as_ref().into(),
            )
        };
    }
}

impl Default for Labelset {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Labelset {
    fn drop(&mut self) {
        unsafe { sys::labelset_free(self.raw.as_ptr()) }
    }
}

impl Clone for Labelset {
    fn clone(&self) -> Self {
        let raw = unsafe { sys::labelset_clone(self.raw.as_ptr()) };
        let raw = NonNull::new(raw).expect("failed to clone labelset");
        Self { raw }
    }
}

impl<K, V> Extend<(K, V)> for Labelset
where
    K: AsRef<[u8]>,
    V: AsRef<[u8]>,
{
    fn extend<T: IntoIterator<Item = (K, V)>>(&mut self, iter: T) {
        for (k, v) in iter {
            self.set(k, v);
        }
    }
}

/// Set the label for the specified key to the specified
/// value while the given function is running.
///
/// All labels are thread-local: setting a label on one thread
/// has no effect on its value on any other thread.
pub fn with_label<K, V, F, Ret>(k: K, v: V, f: F) -> Ret
where
    K: AsRef<[u8]>,
    V: AsRef<[u8]>,
    F: FnOnce() -> Ret,
{
    unsafe {
        if sys::labelset_current().is_null() {
            let l = sys::labelset_new(0);
            sys::labelset_replace(l);
        }
    }
    struct Guard<'a> {
        k: &'a [u8],
        old_v: Option<sys::String>,
    }

    impl<'a> Drop for Guard<'a> {
        fn drop(&mut self) {
            if let Some(old_v) = std::mem::take(&mut self.old_v) {
                let errno = unsafe { sys::set(self.k.into(), old_v) };
                if errno != 0 {
                    panic!("corruption in custom labels library: errno {errno}");
                }
            } else {
                unsafe { sys::delete(self.k.into()) };
            }
        }
    }

    let old_v = unsafe { sys::get(k.as_ref().into()).as_ref() }.map(|lbl| lbl.value.clone());
    let _g = Guard {
        k: k.as_ref(),
        old_v,
    };

    let errno = unsafe { sys::set(k.as_ref().into(), v.as_ref().into()) };
    if errno != 0 {
        panic!("corruption in custom labels library: errno {errno}")
    }

    f()
}

/// Set the labels for the specified keys to the specified
/// values while the given function is running.
///
/// `i` is an iterator of key-value pairs.
///
/// The effect is the same as repeatedly nesting calls to the singular [`with_label`].
pub fn with_labels<I, K, V, F, Ret>(i: I, f: F) -> Ret
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<[u8]>,
    V: AsRef<[u8]>,
    F: FnOnce() -> Ret,
{
    let mut i = i.into_iter();
    if let Some((k, v)) = i.next() {
        with_label(k, v, || with_labels(i, f))
    } else {
        f()
    }
}

pub mod asynchronous {
    use pin_project_lite::pin_project;
    use std::future::Future;
    use std::iter;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use crate::Labelset;

    pin_project! {
        /// A [`Future`] with custom labels attached.
        ///
        /// This type is returned by the [`Label`] extension trait. See that
        /// trait's documentation for details.
        pub struct Labeled<Fut> {
            #[pin]
            inner: Fut,
            labelset: Labelset,
        }
    }

    impl<Fut, Ret> Future for Labeled<Fut>
    where
        Fut: Future<Output = Ret>,
    {
        type Output = Ret;

        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            let p = self.project();
            p.labelset.enter(|| p.inner.poll(cx))
        }
    }

    /// Attaches custom labels to a [`Future`].
    pub trait Label: Sized {
        /// Attach the currently active labels to the future.
        ///
        /// This can be used to propagate the current labels when spawning
        /// a new future.
        fn with_current_labels(self) -> Labeled<Self>;

        /// Attach a single label to the future.
        ///
        /// This is equivalent to calling [`with_labels`] with an iterator that
        /// yields a single key–value pair.
        fn with_label<K, V>(self, k: K, v: V) -> Labeled<Self>
        where
            K: AsRef<[u8]>,
            V: AsRef<[u8]>;

        /// Attaches the specified labels to the future.
        ///
        /// The labels will be installed in the current thread whenever the
        /// future is polled, and removed when the poll completes.
        ///
        /// This is equivalent to calling [`with_labelset`] with a label
        /// set constructed like so:
        ///
        /// ```rust
        /// # use custom_labels::Labelset;
        /// let mut labelset = Labelset::clone_from_current();
        /// labelset.extend(i);
        /// ```
        fn with_labels<I, K, V>(self, i: I) -> Labeled<Self>
        where
            I: IntoIterator<Item = (K, V)>,
            K: AsRef<[u8]>,
            V: AsRef<[u8]>;

        /// Attaches the specified labelset to the future.
        ///
        /// The labels in the set will be installed in the current thread
        /// whenever the future is polled, and removed when the poll completes.
        fn with_labelset(self, labelset: Labelset) -> Labeled<Self>;
    }

    impl<Fut: Future> Label for Fut {
        fn with_current_labels(self) -> Labeled<Self> {
            self.with_labels(iter::empty::<(&[u8], &[u8])>())
        }

        fn with_label<K, V>(self, k: K, v: V) -> Labeled<Self>
        where
            K: AsRef<[u8]>,
            V: AsRef<[u8]>,
        {
            self.with_labels(iter::once((k, v)))
        }

        fn with_labels<I, K, V>(self, iter: I) -> Labeled<Self>
        where
            I: IntoIterator<Item = (K, V)>,
            K: AsRef<[u8]>,
            V: AsRef<[u8]>,
        {
            let mut labelset = Labelset::clone_from_current();
            labelset.extend(iter);
            Labeled {
                inner: self,
                labelset,
            }
        }

        fn with_labelset(self, labelset: Labelset) -> Labeled<Self> {
            Labeled {
                inner: self,
                labelset,
            }
        }
    }
}
