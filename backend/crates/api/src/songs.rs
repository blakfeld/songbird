use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Extension;
use axum::{Json, Router};
use futures_util::Stream;
use tokio::sync::OwnedSemaphorePermit;
use tokio::task::JoinHandle;
use tokio::time::Sleep;

use music::ai::plan::{Plan, PlanRequest};
use music::chat::{
    plan_chat, render_planner_prompt, song_with_planned_track, track_limit_reached, ChatEvent,
    ChatProgress, ChatRange, ChatReplyDelta, ChatReplyReset, ChatStreamError, PlanEvent, RangeRule,
    LOOP_RANGE_REPLY, TRACK_LIMIT_REPLY,
};
use music::generate::generate_track;
use music::song_midi::song_to_midi;
use music::{
    ChatBody, ChatResponse, ChatTrack, Song, SongError, SongLimits, TrackGenerateBody,
    TrackGenerateResponse, ValidTrackRequest,
};

use crate::ai_access::RequestProviders;
use crate::chat_queue::{self, EventReceiver};
use crate::error::{ApiError, ApiJson};
use crate::limit::BusyPermit;
use crate::patterns::{slugify, with_timeout};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/songs/export/midi", post(export_midi))
        .route("/api/v1/songs/limits", get(limits))
}

/// Every route that calls a provider belongs here so the metering layer covers it.
pub fn ai_router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/songs/tracks/generate", post(generate_track_part))
        .route("/api/v1/songs/chat", post(chat))
}

/// Shared by the streamed task and the planner bridge, which both need `Send + Sync` to cross
/// the spawn boundary.
type EventSink<'a> = &'a (dyn Fn(ChatEvent) + Send + Sync);

fn wants_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.to_ascii_lowercase().contains("text/event-stream"))
}

/// Everything the chat needs from validation, owned, because the streamed task outlives the
/// request and cannot borrow the body. Validating once here keeps the two paths identical.
struct PreparedChat {
    song: Song,
    plan_request: PlanRequest,
    track_limit_reached: bool,
    range_rule: RangeRule,
}

fn prepare_chat(state: &AppState, body: ChatBody) -> Result<PreparedChat, ApiError> {
    let (plan_request, track_limit_reached, range_rule) = {
        let chat = body.validate(&state.instruments, state.config.max_input_tokens)?;
        (
            PlanRequest {
                user: render_planner_prompt(&chat, state.config.max_context_tokens),
                instruments: state.instruments.all().to_vec(),
                latest_user_message: chat.prompt.clone(),
            },
            track_limit_reached(&chat.song),
            chat.range_rule(),
        )
    };
    Ok(PreparedChat {
        song: body.song,
        plan_request,
        track_limit_reached,
        range_rule,
    })
}

/// Negotiated here rather than on a new route so validation, auth and metering stay one path,
/// and the JSON response is produced by the same code as before streaming existed.
async fn chat(
    State(state): State<AppState>,
    ai: RequestProviders,
    headers: HeaderMap,
    permit: Option<Extension<BusyPermit>>,
    ApiJson(body): ApiJson<ChatBody>,
) -> Result<Response, ApiError> {
    // Before any streaming starts, so a bad body is a plain 400 and not an error event.
    let prepared = prepare_chat(&state, body)?;
    if !wants_event_stream(&headers) {
        let response = run_chat(&state, &ai, prepared, None).await?;
        return Ok(Json(response).into_response());
    }
    let permit = permit.and_then(|Extension(permit)| permit.take());
    Ok(stream_chat(state, ai, prepared, permit))
}

/// Aborts the chat task when the response body is dropped, which is how a client disconnect
/// reaches the in-flight provider call: dropping its future closes the provider connection.
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct ChatEventStream {
    events: EventReceiver,
    deadline: Pin<Box<Sleep>>,
    _task: AbortOnDrop,
}

impl Stream for ChatEventStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        self.events.poll_recv(cx).map(|event| {
            event.map(|event| Ok(Event::default().event(event.name()).data(event.data_json())))
        })
    }
}

/// How often a silent stream gets a comment line; well under the idle timeouts of common
/// proxies and hosts, so a long provider call does not get the connection closed.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// Slack on top of the two provider timeouts for planning, validation and delivery. The
/// deadline only ends a stream the server is still polling; hyper stops polling one whose
/// socket is full, which is what the queue's cap and a proxy's send timeout are for.
const STREAM_DEADLINE_MARGIN: Duration = Duration::from_secs(30);

fn stream_deadline(generation_timeout: Duration) -> Duration {
    generation_timeout * 2 + STREAM_DEADLINE_MARGIN
}

fn error_event(error: &ApiError) -> ChatEvent {
    ChatEvent::Error(ChatStreamError {
        code: error.code().to_string(),
        message: error.to_string(),
        retry_after: error.retry_after(),
    })
}

fn stream_chat(
    state: AppState,
    ai: RequestProviders,
    prepared: PreparedChat,
    permit: Option<OwnedSemaphorePermit>,
) -> Response {
    // The queue coalesces and caps reply text, so a client that stops reading cannot make it
    // grow without bound while the provider keeps streaming.
    let (tx, events) = chat_queue::channel();
    let supervisor_tx = tx.clone();
    // A client that stops reading must not hold a busy slot, so the permit lives with the
    // provider work, not with the response body, and is dropped when that work ends.
    let deadline = Box::pin(tokio::time::sleep(stream_deadline(
        state.config.generation_timeout,
    )));
    let chat_task = AbortOnDrop(tokio::spawn(async move {
        let _permit = permit;
        let sink = |event: ChatEvent| {
            tx.send(event);
        };
        let terminal = match run_chat(&state, &ai, prepared, Some(&sink)).await {
            Ok(response) => ChatEvent::Result(response),
            Err(error) => error_event(&error),
        };
        sink(terminal);
    }));
    // Supervised so a panic still ends the stream with its one terminal event, and owning the
    // guard so aborting this task on disconnect aborts the chat task with it.
    let task = tokio::spawn(async move {
        let mut chat_task = chat_task;
        if (&mut chat_task.0).await.is_err() {
            // Fixed text: a panic message could carry request content.
            supervisor_tx.send(error_event(&ApiError::Internal));
        }
    });
    let stream = ChatEventStream {
        events,
        deadline,
        _task: AbortOnDrop(task),
    };
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(KEEPALIVE_INTERVAL))
        .into_response();
    let headers = response.headers_mut();
    // `no-store` like every API response, plus `no-transform` so intermediaries do not
    // compress or rewrite the stream.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

/// Two provider calls, each under its own timeout, because they fail
/// independently and a slow planner should not eat the generation's time.
async fn run_chat(
    state: &AppState,
    ai: &RequestProviders,
    prepared: PreparedChat,
    events: Option<EventSink<'_>>,
) -> Result<ChatResponse, ApiError> {
    let emit = |event: ChatEvent| {
        if let Some(events) = events {
            events(event);
        }
    };
    let timeout = state.config.generation_timeout;
    let PreparedChat {
        song,
        plan_request,
        track_limit_reached,
        range_rule,
    } = prepared;

    emit(ChatEvent::Progress(ChatProgress::Planning));
    let forward_plan_event = |event: PlanEvent| {
        emit(match event {
            PlanEvent::ReplyDelta(text) => ChatEvent::ReplyDelta(ChatReplyDelta { text }),
            PlanEvent::ReplyReset => ChatEvent::ReplyReset(ChatReplyReset {}),
        })
    };
    let plan_events: Option<&(dyn Fn(PlanEvent) + Send + Sync)> =
        events.map(|_| &forward_plan_event as _);
    let plan = with_timeout(
        timeout,
        ai.provider_name,
        plan_chat(ai.providers.plans.as_ref(), &plan_request, plan_events),
    )
    .await?;
    let (reply, instrument, track_name, prompt, measures) = match plan {
        Plan::ReplyOnly { reply } => return Ok(ChatResponse::reply_only(reply)),
        Plan::AddTrack {
            reply,
            instrument,
            track_name,
            prompt,
            measures,
        } => (reply, instrument, track_name, prompt, measures),
    };

    // Enforced here whatever the planner decided, so a confused model cannot
    // push a song past its limits.
    if track_limit_reached {
        return Ok(ChatResponse::reply_only(TRACK_LIMIT_REPLY));
    }
    let ChatRange::Range(range) = range_rule.range_for(measures) else {
        return Ok(ChatResponse::reply_only(LOOP_RANGE_REPLY));
    };

    let extended = song_with_planned_track(&song, &track_name, instrument.id);
    let valid = extended.validate(&state.instruments).map_err(|error| {
        tracing::error!(%error, "a validated song with one more track failed validation");
        ApiError::Internal
    })?;
    let request = ValidTrackRequest {
        target: valid.tracks.len() - 1,
        song: valid,
        prompt: cap_prompt(&prompt, state.config.max_input_tokens),
        range,
    };
    emit(ChatEvent::Progress(ChatProgress::Writing {
        name: track_name.clone(),
        instrument: instrument.id.to_string(),
    }));
    let generated = with_timeout(
        timeout,
        ai.provider_name,
        generate_track(
            ai.providers.patterns.as_ref(),
            &request,
            state.config.max_context_tokens,
        ),
    )
    .await?;
    Ok(ChatResponse {
        reply,
        track: Some(ChatTrack {
            name: track_name,
            instrument: instrument.id.to_string(),
            range,
            notes: generated.notes,
        }),
    })
}

/// The planner is trusted to rewrite the prompt but not to respect the input
/// limit, and generation does not re-validate it.
fn cap_prompt(prompt: &str, max_input_tokens: u32) -> String {
    prompt.chars().take(max_input_tokens as usize * 4).collect()
}

async fn generate_track_part(
    State(state): State<AppState>,
    ai: RequestProviders,
    ApiJson(body): ApiJson<TrackGenerateBody>,
) -> Result<Json<TrackGenerateResponse>, ApiError> {
    // Validation precedes the provider so rejected requests never cost tokens.
    let request = body.validate(&state.instruments, state.config.max_input_tokens)?;
    let response = with_timeout(
        state.config.generation_timeout,
        ai.provider_name,
        generate_track(
            ai.providers.patterns.as_ref(),
            &request,
            state.config.max_context_tokens,
        ),
    )
    .await?;
    Ok(Json(response))
}

async fn limits(State(state): State<AppState>) -> Json<SongLimits> {
    Json(SongLimits::new(state.config.max_input_tokens))
}

async fn export_midi(
    State(state): State<AppState>,
    ApiJson(song): ApiJson<Song>,
) -> Result<Response, ApiError> {
    let valid = song
        .validate(&state.instruments)
        .map_err(|error| match error {
            SongError::UnknownInstrument { message } => ApiError::InvalidSongInstrument(message),
            SongError::Invalid { message, .. } => ApiError::InvalidSong(message),
        })?;
    let bytes = song_to_midi(&valid).map_err(|error| {
        tracing::error!(%error, "song MIDI serialization failed");
        ApiError::Internal
    })?;
    let disposition = format!(
        "attachment; filename=\"{}\"",
        song_filename(&song.name, song.tempo_bpm)
    );
    let disposition = HeaderValue::from_str(&disposition).expect("filename is ASCII");
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("audio/midi")),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        bytes,
    )
        .into_response())
}

fn song_filename(name: &str, tempo_bpm: u32) -> String {
    format!("songbird-{}-{tempo_bpm}bpm.mid", slugify(name, "song"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use futures_util::StreamExt;

    use super::*;

    #[test]
    fn filename_is_slugged() {
        assert_eq!(
            song_filename("Late Train", 96),
            "songbird-late-train-96bpm.mid"
        );
        assert_eq!(song_filename("🚆", 96), "songbird-song-96bpm.mid");
    }

    struct SetOnDrop(Arc<AtomicBool>);

    impl Drop for SetOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_stream_that_outlives_its_deadline_ends_and_aborts_its_task() {
        let timeout = Duration::from_secs(60);
        let (_tx, events) = chat_queue::channel();
        let aborted = Arc::new(AtomicBool::new(false));
        let flag = SetOnDrop(aborted.clone());
        let task = tokio::spawn(async move {
            let _flag = flag;
            std::future::pending::<()>().await;
        });
        let mut stream = ChatEventStream {
            events,
            deadline: Box::pin(tokio::time::sleep(stream_deadline(timeout))),
            _task: AbortOnDrop(task),
        };

        let started = tokio::time::Instant::now();
        assert!(stream.next().await.is_none());
        assert_eq!(started.elapsed(), Duration::from_secs(150));

        drop(stream);
        tokio::task::yield_now().await;
        assert!(aborted.load(Ordering::SeqCst));
    }
}
