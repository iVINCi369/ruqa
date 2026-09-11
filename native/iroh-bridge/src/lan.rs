//! Соседи в локальной сети: браузинг по mDNS и приглашения без кода.
//!
//! Отдельный Endpoint на постоянном ключе устройства. Он живёт всё время, пока
//! открыто приложение, и только он светится в mDNS. Сессии передачи по-прежнему
//! поднимают свои Endpoint'ы на разовых ключах — присутствие в списке «Рядом»
//! не должно зависеть от того, идёт ли сейчас передача.
//!
//! Интернет не нужен ни на одном шаге: mDNS работает по мультикасту в пределах
//! сегмента, а соединение встаёт по локальным адресам напрямую.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use futures_lite::StreamExt;
use iroh::address_lookup::UserData;
use iroh::endpoint::{Connection, SendStream, presets};
use iroh::{Endpoint, EndpointAddr, RelayMode, TransportAddr};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{Mutex, broadcast};

use crate::hex_to_key;

/// Свой ALPN: приглашение не должно попасть в приёмник передачи.
const LAN_ALPN: &[u8] = b"ruqa/lan/1";

/// Своё имя службы вместо стандартного `irohv1`, иначе в списке «Рядом» окажется
/// любое приложение на iroh, случайно оказавшееся в этой же сети.
const LAN_SERVICE: &str = "ruqav1";

/// Приглашение ждёт решения человека, но не бесконечно.
const INVITE_TIMEOUT: Duration = Duration::from_secs(60);

/// Входящее приглашение, ждущее ответа. `_conn` держим, потому что со смертью
/// соединения умирает и стрим, в который мы собираемся ответить.
struct Inbound {
    send: SendStream,
    _conn: Connection,
}

pub struct Lan {
    endpoint: Endpoint,
    inbound: Arc<Mutex<HashMap<u64, Inbound>>>,
}

pub type SharedLan = Arc<Mutex<Option<Lan>>>;

/// Имя сессии для канала событий. Клиент отбирает свои события по нему, и
/// соседи не должны сыпаться в мосты передачи и сопряжения.
pub const LAN_SESSION: &str = "lan";

fn emit(events: &broadcast::Sender<String>, mut value: serde_json::Value) {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("session".into(), LAN_SESSION.into());
    }
    let _ = events.send(value.to_string());
}

/// Поднять личность устройства в сети и начать слушать соседей.
///
/// `secret` — постоянный ключ устройства (32 байта hex), `user_data` — то, что
/// увидят соседи до всякого соединения: имя, тип, публичный ключ для сверки с
/// уже запомненными устройствами. Влезает 245 байт, больше mDNS не отдаст.
pub async fn start(
    events: &broadcast::Sender<String>,
    lan: &SharedLan,
    secret_hex: &str,
    user_data: &str,
    offline: bool,
) -> Result<serde_json::Value> {
    stop(lan).await;

    let secret = hex_to_key(secret_hex)?;
    let id = secret.public();

    let ud = UserData::try_from(user_data.to_string())
        .ok()
        .context("user_data не влезает в 245 байт")?;

    let mdns = MdnsAddressLookup::builder()
        .service_name(LAN_SERVICE)
        .build(id)
        .map_err(|e| anyhow::anyhow!("mdns: {e}"))?;

    // Клон уходит в Endpoint как address lookup, оригинал остаётся у нас ради
    // subscribe(): сам Endpoint потока найденных соседей наружу не отдаёт.
    // Пресеты — разные типы, поэтому ветки собираются целиком, а не через
    // общий билдер.
    let endpoint = if offline {
        Endpoint::builder(presets::Minimal)
            .secret_key(secret)
            .alpns(vec![LAN_ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled)
            .user_data_for_address_lookup(ud)
            .address_lookup(mdns.clone())
            .bind()
            .await?
    } else {
        Endpoint::builder(presets::N0)
            .secret_key(secret)
            .alpns(vec![LAN_ALPN.to_vec()])
            .user_data_for_address_lookup(ud)
            .address_lookup(mdns.clone())
            .bind()
            .await?
    };

    let inbound: Arc<Mutex<HashMap<u64, Inbound>>> = Arc::new(Mutex::new(HashMap::new()));

    spawn_browser(events.clone(), mdns);
    spawn_invite_acceptor(events.clone(), endpoint.clone(), inbound.clone());

    let endpoint_id = endpoint.id().to_string();
    *lan.lock().await = Some(Lan { endpoint, inbound });

    Ok(serde_json::json!({ "ok": true, "endpointId": endpoint_id }))
}

pub async fn stop(lan: &SharedLan) {
    let taken = lan.lock().await.take();
    if let Some(l) = taken {
        l.endpoint.close().await;
    }
}

/// Поток появлений и исчезновений соседей.
fn spawn_browser(events: broadcast::Sender<String>, mdns: MdnsAddressLookup) {
    tokio::spawn(async move {
        let mut stream = mdns.subscribe().await;
        while let Some(event) = stream.next().await {
            match event {
                DiscoveryEvent::Discovered { endpoint_info, .. } => {
                    let addrs: Vec<String> = endpoint_info
                        .data
                        .addrs()
                        .filter_map(|a| match a {
                            TransportAddr::Ip(sa) => Some(sa.to_string()),
                            _ => None,
                        })
                        .collect();
                    emit(
                        &events,
                        serde_json::json!({
                            "event": "lan-peer",
                            "endpointId": endpoint_info.endpoint_id.to_string(),
                            "userData": endpoint_info.data.user_data().map(|u| u.as_ref()),
                            "addrs": addrs,
                        }),
                    );
                }
                DiscoveryEvent::Expired { endpoint_id } => emit(
                    &events,
                    serde_json::json!({
                        "event": "lan-peer-gone",
                        "endpointId": endpoint_id.to_string(),
                    }),
                ),
                // enum помечен non_exhaustive: новые события молча пропускаем.
                _ => {}
            }
        }
    });
}

/// Приём приглашений. Ответ отдаёт не этот цикл, а `respond` — между ними
/// стоит человек, и ждать его приходится с открытым стримом.
fn spawn_invite_acceptor(
    events: broadcast::Sender<String>,
    endpoint: Endpoint,
    inbound: Arc<Mutex<HashMap<u64, Inbound>>>,
) {
    let next_id = Arc::new(AtomicU64::new(1));
    tokio::spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            let events = events.clone();
            let inbound = inbound.clone();
            let next_id = next_id.clone();
            tokio::spawn(async move {
                let Ok(conn) = incoming.await else { return };
                let remote = conn.remote_id().to_string();
                let Ok((send, recv)) = conn.accept_bi().await else { return };

                let mut reader = BufReader::new(recv);
                let mut line = String::new();
                if reader.read_line(&mut line).await.is_err() {
                    return;
                }
                let Ok(req) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                    return;
                };
                let Some(topic) = req["topic"].as_str() else { return };

                let request_id = next_id.fetch_add(1, Ordering::Relaxed);
                inbound.lock().await.insert(request_id, Inbound { send, _conn: conn });

                emit(
                    &events,
                    serde_json::json!({
                        "event": "lan-invite",
                        "requestId": request_id,
                        "endpointId": remote,
                        "topic": topic,
                        "displayName": req["displayName"],
                        "deviceType": req["deviceType"],
                        "fileCount": req["fileCount"],
                        "textCount": req["textCount"],
                        "totalSize": req["totalSize"],
                    }),
                );

                // Молчание пользователя — это отказ, иначе стрим висит вечно.
                tokio::time::sleep(INVITE_TIMEOUT).await;
                if let Some(mut pending) = inbound.lock().await.remove(&request_id) {
                    let _ = pending.send.write_all(b"{\"response\":\"declined\"}\n").await;
                    let _ = pending.send.finish();
                    emit(
                        &events,
                        serde_json::json!({
                            "event": "lan-invite-expired",
                            "requestId": request_id,
                        }),
                    );
                }
            });
        }
    });
}

/// Позвать соседа. Возвращается уже с его решением — ждать отдельного события
/// не нужно, ответ приходит по тому же стриму.
pub async fn invite(
    lan: &SharedLan,
    endpoint_id: &str,
    hints: Vec<std::net::SocketAddr>,
    payload: serde_json::Value,
) -> Result<serde_json::Value> {
    let endpoint = {
        let guard = lan.lock().await;
        guard.as_ref().context("lan-invite до lan-start")?.endpoint.clone()
    };

    let peer: iroh::EndpointId = endpoint_id.parse().context("плохой endpointId")?;
    let target = if hints.is_empty() {
        EndpointAddr::new(peer)
    } else {
        EndpointAddr::from_parts(peer, hints.into_iter().map(TransportAddr::Ip))
    };

    let conn = endpoint.connect(target, LAN_ALPN).await?;
    let (mut send, recv) = conn.open_bi().await?;
    // accept_bi на той стороне срабатывает только после записи — пишем сразу.
    send.write_all(payload.to_string().as_bytes()).await?;
    send.write_all(b"\n").await?;

    let mut reader = BufReader::new(recv);
    let mut line = String::new();
    let read = tokio::time::timeout(INVITE_TIMEOUT, reader.read_line(&mut line)).await;
    let _ = send.finish();

    match read {
        Ok(Ok(n)) if n > 0 => {
            let reply: serde_json::Value = serde_json::from_str(line.trim())?;
            Ok(serde_json::json!({
                "ok": true,
                "response": reply["response"].as_str().unwrap_or("declined"),
            }))
        }
        _ => Ok(serde_json::json!({ "ok": true, "response": "timeout" })),
    }
}

/// Ответ на входящее приглашение.
pub async fn respond(lan: &SharedLan, request_id: u64, response: &str) -> Result<serde_json::Value> {
    let inbound = {
        let guard = lan.lock().await;
        guard.as_ref().context("lan-respond до lan-start")?.inbound.clone()
    };
    let mut pending = inbound.lock().await.remove(&request_id).context("приглашение истекло")?;
    let reply = serde_json::json!({ "response": response }).to_string();
    pending.send.write_all(reply.as_bytes()).await?;
    pending.send.write_all(b"\n").await?;
    let _ = pending.send.finish();
    Ok(serde_json::json!({ "ok": true }))
}
