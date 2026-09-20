use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{Mutex, Notify, RwLock, broadcast};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use crate::config::{ConfigStore, DisplayConfig};
use crate::presets::{PresentationConfig, Preset, PresetStore, apply_preset_to_display};
use crate::wspr::WsprSnapshot;

#[derive(Clone)]
pub struct AppState {
    store: Arc<Mutex<ConfigStore>>,
    presets: Arc<Mutex<PresetStore>>,
    updates: broadcast::Sender<DisplayConfig>,
    wspr: Arc<RwLock<WsprSnapshot>>,
    poll_notify: Arc<Notify>,
}

impl AppState {
    pub fn new(store: ConfigStore, presets: PresetStore, wspr: WsprSnapshot) -> Self {
        let (updates, _) = broadcast::channel(32);
        Self {
            store: Arc::new(Mutex::new(store)),
            presets: Arc::new(Mutex::new(presets)),
            updates,
            wspr: Arc::new(RwLock::new(wspr)),
            poll_notify: Arc::new(Notify::new()),
        }
    }

    pub fn config_handle(&self) -> Arc<Mutex<ConfigStore>> {
        self.store.clone()
    }

    pub fn wspr_handle(&self) -> Arc<RwLock<WsprSnapshot>> {
        self.wspr.clone()
    }

    pub fn poll_notify(&self) -> Arc<Notify> {
        self.poll_notify.clone()
    }
}

pub fn router(state: AppState, web_root: PathBuf) -> Router {
    let display = ServeFile::new(web_root.join("display.html"));
    let canvas_display = ServeFile::new(web_root.join("canvas-display.html"));
    Router::new()
        .route("/api/state", get(get_state).put(put_state))
        .route("/api/presets", get(list_presets).post(create_preset))
        .route(
            "/api/presets/{id}",
            axum::routing::put(update_preset).delete(delete_preset),
        )
        .route("/api/presets/{id}/apply", post(apply_preset))
        .route("/api/health", get(health))
        .route("/api/wspr", get(get_wspr))
        .route("/ws", get(websocket))
        .nest_service("/assets", ServeDir::new(web_root.join("assets")))
        .route_service("/config", ServeFile::new(web_root.join("config.html")))
        .route_service("/canvas-display", canvas_display)
        .fallback_service(display)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn get_state(State(state): State<AppState>) -> Json<DisplayConfig> {
    Json(state.store.lock().await.get())
}

async fn get_wspr(State(state): State<AppState>) -> Json<WsprSnapshot> {
    Json(state.wspr.read().await.clone())
}

async fn put_state(
    State(state): State<AppState>,
    Json(config): Json<DisplayConfig>,
) -> Result<Json<DisplayConfig>, ApiError> {
    let config = state
        .store
        .lock()
        .await
        .replace(config)
        .await
        .map_err(ApiError)?;
    let _ = state.updates.send(config.clone());
    state.poll_notify.notify_one();
    Ok(Json(config))
}

async fn list_presets(State(state): State<AppState>) -> Json<Vec<Preset>> {
    Json(state.presets.lock().await.list())
}

#[derive(Deserialize)]
struct CreatePreset {
    name: String,
}

async fn create_preset(
    State(state): State<AppState>,
    Json(request): Json<CreatePreset>,
) -> Result<Json<Preset>, ApiError> {
    let settings = PresentationConfig::from_display(&state.store.lock().await.get());
    let preset = state
        .presets
        .lock()
        .await
        .create(request.name, settings)
        .await
        .map_err(ApiError)?;
    Ok(Json(preset))
}

#[derive(Deserialize)]
struct UpdatePreset {
    name: Option<String>,
    save_current: bool,
}

async fn update_preset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<UpdatePreset>,
) -> Result<Json<Preset>, ApiError> {
    if request.name.is_none() && !request.save_current {
        return Err(ApiError(anyhow::anyhow!(
            "provide a name or request save_current"
        )));
    }
    let settings = if request.save_current {
        Some(PresentationConfig::from_display(
            &state.store.lock().await.get(),
        ))
    } else {
        None
    };
    let preset = state
        .presets
        .lock()
        .await
        .update(&id, request.name, settings)
        .await
        .map_err(ApiError)?;
    Ok(Json(preset))
}

async fn delete_preset(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .presets
        .lock()
        .await
        .delete(&id)
        .await
        .map_err(ApiError)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn apply_preset(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<DisplayConfig>, ApiError> {
    let preset = state.presets.lock().await.get(&id).map_err(ApiError)?;
    let mut store = state.store.lock().await;
    let mut config = store.get();
    apply_preset_to_display(&mut config, &preset.settings, Utc::now().to_rfc3339());
    let config = store.replace(config).await.map_err(ApiError)?;
    let _ = state.updates.send(config.clone());
    state.poll_notify.notify_one();
    Ok(Json(config))
}

async fn websocket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| websocket_client(socket, state))
}

async fn websocket_client(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let initial = state.store.lock().await.get();
    if sender
        .send(Message::Text(
            serde_json::to_string(&initial).unwrap().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let mut updates = state.updates.subscribe();

    loop {
        tokio::select! {
            update = updates.recv() => match update {
                Ok(config) => {
                    let json = serde_json::to_string(&config).expect("serialize validated configuration");
                    if sender.send(Message::Text(json.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            message = receiver.next() => match message {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

struct ApiError(anyhow::Error);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": self.0.to_string() })),
        )
            .into_response()
    }
}
