use std::sync::{Arc, Mutex};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::ApiError;

/// Cloned into each LLM-backed router so they draw on one shared budget.
#[derive(Clone)]
pub struct GenerationLimiter(Arc<Semaphore>);

impl GenerationLimiter {
    pub fn new(max_concurrent: usize) -> Self {
        Self(Arc::new(Semaphore::new(max_concurrent)))
    }
}

/// A generation slot that a handler can take over. A streamed chat answers with headers long
/// before its provider calls finish, so it moves the permit into its own task; every other
/// route leaves it here and gets it released as soon as the handler returns.
#[derive(Clone)]
pub struct BusyPermit(Arc<Mutex<Option<OwnedSemaphorePermit>>>);

impl BusyPermit {
    pub fn take(&self) -> Option<OwnedSemaphorePermit> {
        self.0
            .lock()
            .expect("no panic while the lock is held")
            .take()
    }
}

/// Rejects instead of queueing so a flood cannot pile up pending provider
/// calls, each of which costs tokens or local compute once it starts.
pub async fn shed_when_busy(
    State(limiter): State<GenerationLimiter>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let permit = limiter
        .0
        .try_acquire_owned()
        .map_err(|_| ApiError::GenerationBusy)?;
    let slot = BusyPermit(Arc::new(Mutex::new(Some(permit))));
    request.extensions_mut().insert(slot.clone());
    let response = next.run(request).await;
    // Not tied to the response body: a client that never reads it must not keep the slot.
    drop(slot.take());
    Ok(response)
}
