//! Credentials and sessions. Everything except `http` is free of HTTP so the
//! operator CLI, tests, and the request layer share one implementation.

pub mod http;
pub mod password;
pub mod session;
pub mod throttle;
