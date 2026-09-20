use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, Notify, RwLock, broadcast};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use crate::config::{ConfigStore, DisplayConfig};
use crate::wspr::WsprSnapshot;

#[derive(Clone)]
pub struct AppState {
    store: Arc<Mutex<ConfigStore>>,
    updates: broadcast::Sender<DisplayConfig>,
    wspr: Arc<RwLock<WsprSnapshot>>,
    poll_notify: Arc<Notify>,
}

impl AppState {
    pub fn new(store: ConfigStore, wspr: WsprSnapshot) -> Self {
        let (updates, _) = broadcast::channel(32);
        Self {
            store: Arc::new(Mutex::new(store)),
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
    let webgl_prototype = ServeFile::new(web_root.join("webgl-prototype.html"));
    Router::new()
        .route("/api/state", get(get_state).put(put_state))
        .route("/api/health", get(health))
        .route("/api/wspr", get(get_wspr))
        .route("/ws", get(websocket))
        .nest_service("/assets", ServeDir::new(web_root.join("assets")))
        .route_service("/config", ServeFile::new(web_root.join("config.html")))
        .route_service("/webgl-prototype", webgl_prototype)
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
