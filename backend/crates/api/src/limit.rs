use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use tokio::sync::Semaphore;

use crate::error::ApiError;

/// Cloned into each LLM-backed router so they draw on one shared budget.
#[derive(Clone)]
pub struct GenerationLimiter(Arc<Semaphore>);

impl GenerationLimiter {
    pub fn new(max_concurrent: usize) -> Self {
        Self(Arc::new(Semaphore::new(max_concurrent)))
    }
}

/// Rejects instead of queueing so a flood cannot pile up pending provider
/// calls, each of which costs tokens or local compute once it starts.
pub async fn shed_when_busy(
    State(limiter): State<GenerationLimiter>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let _permit = limiter
        .0
        .try_acquire_owned()
        .map_err(|_| ApiError::GenerationBusy)?;
    Ok(next.run(request).await)
}
