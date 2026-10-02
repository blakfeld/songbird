fn main() {
    // sqlx::migrate! embeds the directory at compile time and cargo cannot see new files there.
    println!("cargo:rerun-if-changed=migrations");
}
