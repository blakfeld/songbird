pub mod config;
pub mod error;
pub mod patterns;
pub mod provider;
pub mod routes;
pub mod songs;
pub mod state;

pub use routes::{app, middleware, routes};
