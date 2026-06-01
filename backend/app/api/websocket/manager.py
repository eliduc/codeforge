"""
WebSocket connection manager for real-time updates.
"""
import asyncio
import json
import logging
from datetime import datetime
from typing import Dict, Set, Optional, Any
from uuid import UUID

from app.core.defaults import (
    WS_MAX_MESSAGE_SIZE_BYTES,
    WS_RECEIVE_TIMEOUT_SEC,
)

# Timeout for waiting on client messages (seconds).
# If a client sends nothing for this long the connection is dropped.
WS_RECEIVE_TIMEOUT = WS_RECEIVE_TIMEOUT_SEC  # 5 minutes

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.api.auth import SESSION_COOKIE_NAME, decode_jwt_token, validate_ws_api_key


def _ws_token(websocket: WebSocket) -> str | None:
    """КАО#SG1-selfxss — resolve the WS auth token.

    Browser clients now authenticate via the httpOnly ``codeforge_session``
    cookie (sent automatically on the same-origin WS handshake), so JS no
    longer needs to put the JWT in the URL. The ``?token=`` query param is
    still honoured first for API-key / programmatic clients.
    """
    return websocket.query_params.get("token") or websocket.cookies.get(SESSION_COOKIE_NAME)

# Maximum incoming WS message size (bytes) — reject oversized payloads
MAX_WS_MESSAGE_SIZE = WS_MAX_MESSAGE_SIZE_BYTES  # 64 KB

logger = logging.getLogger(__name__)


class _SafeEncoder(json.JSONEncoder):
    """JSON encoder that handles UUID, datetime, and other common types."""
    def default(self, obj: Any) -> Any:
        if isinstance(obj, UUID):
            return str(obj)
        if isinstance(obj, datetime):
            return obj.isoformat()
        # Let unknown types raise TypeError via the default JSONEncoder behaviour
        # rather than silently str()-ifying arbitrary objects.
        return super().default(obj)

ws_router = APIRouter()


class ConnectionManager:
    """Manage WebSocket connections and broadcast messages."""

    def __init__(self):
        # session_id -> set of connections
        self.connections: Dict[str, Set[WebSocket]] = {}
        # All connections for global broadcasts
        self.all_connections: Set[WebSocket] = set()
        # Orchestrator references for control
        self.orchestrators: Dict[str, Any] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, session_id: Optional[str] = None) -> None:
        """Accept a new WebSocket connection."""
        await websocket.accept()

        async with self._lock:
            self.all_connections.add(websocket)

            if session_id:
                if session_id not in self.connections:
                    self.connections[session_id] = set()
                self.connections[session_id].add(websocket)

        logger.info(f"WebSocket connected. Session: {session_id or 'global'}")

    async def disconnect(self, websocket: WebSocket, session_id: Optional[str] = None) -> None:
        """Remove a WebSocket connection."""
        async with self._lock:
            self.all_connections.discard(websocket)

            if session_id and session_id in self.connections:
                self.connections[session_id].discard(websocket)
                if not self.connections[session_id]:
                    del self.connections[session_id]

        logger.info(f"WebSocket disconnected. Session: {session_id or 'global'}")

    async def subscribe(self, websocket: WebSocket, session_id: str) -> None:
        """Subscribe a connection to a session's updates."""
        async with self._lock:
            if session_id not in self.connections:
                self.connections[session_id] = set()
            self.connections[session_id].add(websocket)

        logger.info(f"WebSocket subscribed to session: {session_id}")

    async def unsubscribe(self, websocket: WebSocket, session_id: str) -> None:
        """Unsubscribe a connection from a session."""
        async with self._lock:
            if session_id in self.connections:
                self.connections[session_id].discard(websocket)
                if not self.connections[session_id]:
                    del self.connections[session_id]

    async def send_to_session(self, session_id: str, message: dict) -> None:
        """Send a message to all connections watching a session."""
        # Normalise session_id to str (callers may pass UUID objects)
        session_id = str(session_id)

        # Snapshot connections under lock to avoid race with connect/disconnect
        async with self._lock:
            connections = list(self.connections.get(session_id, set()))

        event_type = message.get("type", "?")
        if not connections:
            logger.warning(f"No WS connections for session {session_id}, dropping event: {event_type}")
            return
        logger.info(f"Sending WS event '{event_type}' to {len(connections)} connection(s) for session {session_id}")

        try:
            message_str = json.dumps(message, cls=_SafeEncoder)
        except (TypeError, ValueError) as e:
            logger.error(f"Failed to serialize WS message for session {session_id}: {e}")
            return

        disconnected = []
        for websocket in connections:
            try:
                await websocket.send_text(message_str)
            except Exception as e:
                logger.warning(f"Failed to send to WebSocket: {e}")
                disconnected.append(websocket)

        # Clean up disconnected
        for ws in disconnected:
            await self.disconnect(ws, session_id)

    async def broadcast(self, event_type: str, data: dict) -> None:
        """Broadcast a message to appropriate connections."""
        session_id = data.get("session_id")

        message = {
            "type": event_type,
            "data": data,
        }

        if session_id:
            # Normalise to str for dict lookup
            await self.send_to_session(str(session_id), message)
        else:
            # Global broadcast
            message_str = json.dumps(message, cls=_SafeEncoder)
            disconnected = []

            # list() creates a snapshot of the set, so concurrent connect/disconnect
            # on self.all_connections is safe without holding the lock during iteration.
            for websocket in list(self.all_connections):
                try:
                    await websocket.send_text(message_str)
                except Exception:
                    disconnected.append(websocket)

            for ws in disconnected:
                await self.disconnect(ws)

    async def register_orchestrator(self, session_id: str, orchestrator: Any) -> None:
        """Register an orchestrator for session control."""
        async with self._lock:
            self.orchestrators[session_id] = orchestrator

    async def unregister_orchestrator(self, session_id: str) -> None:
        """Unregister an orchestrator."""
        async with self._lock:
            self.orchestrators.pop(session_id, None)

    async def pause_session(self, session_id: str) -> bool:
        """Pause a running session."""
        orchestrator = self.orchestrators.get(session_id)
        if orchestrator:
            orchestrator.pause()
            return True
        return False

    async def resume_session(self, session_id: str) -> bool:
        """Resume a paused session."""
        orchestrator = self.orchestrators.get(session_id)
        if orchestrator:
            orchestrator.resume()
            return True
        return False

    async def cancel_session(self, session_id: str) -> bool:
        """Cancel a running session."""
        orchestrator = self.orchestrators.get(session_id)
        if orchestrator:
            orchestrator.stop()
            return True
        return False


# Global session manager
session_manager = ConnectionManager()


@ws_router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates."""
    # Authenticate via ?token=... or the httpOnly session cookie (КАО#SG1-selfxss).
    token = _ws_token(websocket)
    if not validate_ws_api_key(token):
        await websocket.close(code=4001, reason="Unauthorized")
        return

    # Capture user_id from JWT (if any) so subscribe can enforce ownership.
    # Pure API-key auth produces user_id=None and keeps full access.
    _payload = decode_jwt_token(token) if token else None
    _ws_user_id = _payload.get("sub") if _payload else None

    await session_manager.connect(websocket)

    current_subscriptions: Set[str] = set()

    try:
        while True:
            # Receive message (with timeout to prevent idle connections consuming resources)
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=WS_RECEIVE_TIMEOUT)
            except asyncio.TimeoutError:
                logger.info("WebSocket global endpoint timed out (no message in %ds), closing", WS_RECEIVE_TIMEOUT)
                break

            # Reject oversized messages
            if len(data) > MAX_WS_MESSAGE_SIZE:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": f"Message too large (max {MAX_WS_MESSAGE_SIZE} bytes)",
                }))
                continue

            try:
                message = json.loads(data)
                msg_type = message.get("type")

                if msg_type == "subscribe":
                    session_id = message.get("session_id")
                    if session_id:
                        # Validate session_id is a valid UUID
                        try:
                            UUID(session_id)
                        except ValueError:
                            await websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Invalid session ID format",
                            }))
                            continue

                        # Multi-tenancy: enforce session ownership for JWT users.
                        # API-key callers (_ws_user_id is None) skip this check.
                        if _ws_user_id is not None:
                            from app.db.database import AsyncSessionLocal
                            from app.db.models import Session as SessionModel

                            try:
                                async with AsyncSessionLocal() as db_check:
                                    res = await db_check.execute(
                                        select(SessionModel.user_id).where(
                                            SessionModel.id == session_id
                                        )
                                    )
                                    owner = res.scalar_one_or_none()
                            except Exception as exc:  # noqa: BLE001
                                logger.error(
                                    f"WS subscribe ownership check failed for {session_id}: {exc}"
                                )
                                await websocket.send_text(json.dumps({
                                    "type": "error",
                                    "message": "Internal error during subscribe",
                                }))
                                continue

                            # Same 4004-style "not found" message whether the
                            # session is missing or owned by someone else —
                            # don't leak existence.
                            if owner is None or str(owner) != str(_ws_user_id):
                                await websocket.send_text(json.dumps({
                                    "type": "error",
                                    "message": "Session not found",
                                }))
                                continue

                        await session_manager.subscribe(websocket, session_id)
                        current_subscriptions.add(session_id)
                        await websocket.send_text(json.dumps({
                            "type": "subscribed",
                            "session_id": session_id,
                        }))

                elif msg_type == "unsubscribe":
                    session_id = message.get("session_id")
                    if session_id:
                        await session_manager.unsubscribe(websocket, session_id)
                        current_subscriptions.discard(session_id)
                        await websocket.send_text(json.dumps({
                            "type": "unsubscribed",
                            "session_id": session_id,
                        }))

                elif msg_type == "intervention":
                    # Handle real-time intervention — verify client is subscribed to the session
                    session_id = message.get("session_id")
                    intervention_data = message.get("data")
                    if session_id and intervention_data:
                        if session_id not in current_subscriptions:
                            await websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Not subscribed to this session",
                            }))
                        # Best-effort check: only broadcast if an orchestrator is registered
                        # (i.e. the session is likely RUNNING). This is racy but prevents
                        # obviously stale interventions on completed/failed sessions.
                        elif session_id not in session_manager.orchestrators:
                            await websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Session is not currently running",
                            }))
                        else:
                            # Only pass allowed keys from intervention_data (prevent message spoofing)
                            safe_data = {
                                k: v for k, v in intervention_data.items()
                                if k in ("content", "target_agent_type", "target_agent_index",
                                         "intervention_type", "instruction")
                            }
                            await session_manager.broadcast("intervention", {
                                "session_id": session_id,
                                **safe_data,
                            })

                elif msg_type == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))

            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": "Invalid JSON",
                }))

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up all subscriptions
        for session_id in current_subscriptions:
            await session_manager.unsubscribe(websocket, session_id)
        await session_manager.disconnect(websocket)


@ws_router.websocket("/ws/{session_id}")
async def session_websocket_endpoint(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for a specific session.

    Multi-tenancy: when the token is a JWT, the session must be owned by
    the JWT's user. API-key tokens (no 'sub') keep full access for backwards
    compat. A 4004 close code is used for missing sessions and 4003 for
    forbidden — the close code mirrors HTTP 404/403 semantics but the
    reason string is intentionally generic.
    """
    # Validate session_id is a valid UUID format
    try:
        UUID(session_id)
    except ValueError:
        await websocket.close(code=4002, reason="Invalid session ID format")
        return

    # Authenticate via ?token=... or the httpOnly session cookie (КАО#SG1-selfxss).
    token = _ws_token(websocket)
    if not validate_ws_api_key(token):
        await websocket.close(code=4001, reason="Unauthorized")
        return

    # If the token is a JWT, enforce session ownership before accepting the
    # socket. Pure API-key auth (decode_jwt_token returns None) skips this
    # check so legacy/admin clients keep working.
    payload = decode_jwt_token(token) if token else None
    user_id = payload.get("sub") if payload else None
    if user_id:
        from app.db.database import AsyncSessionLocal
        from app.db.models import Session as SessionModel

        try:
            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(SessionModel.user_id).where(SessionModel.id == session_id)
                )
                owner = result.scalar_one_or_none()
        except Exception as exc:  # noqa: BLE001
            logger.error(f"WS ownership check failed for session {session_id}: {exc}")
            await websocket.close(code=1011, reason="Internal error")
            return

        # Use the same 4004 code for "not found OR not yours" to avoid
        # leaking the existence of other users' sessions.
        if owner is None:
            await websocket.close(code=4004, reason="Session not found")
            return
        if str(owner) != str(user_id):
            await websocket.close(code=4004, reason="Session not found")
            return

    await session_manager.connect(websocket, session_id)

    try:
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=WS_RECEIVE_TIMEOUT)
            except asyncio.TimeoutError:
                logger.info("WebSocket session endpoint timed out (no message in %ds), closing", WS_RECEIVE_TIMEOUT)
                break

            # Reject oversized messages
            if len(data) > MAX_WS_MESSAGE_SIZE:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": f"Message too large (max {MAX_WS_MESSAGE_SIZE} bytes)",
                }))
                continue

            try:
                message = json.loads(data)
                msg_type = message.get("type")

                if msg_type == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))

                elif msg_type == "intervention":
                    intervention_data = message.get("data")
                    if intervention_data:
                        # Best-effort check: only broadcast if an orchestrator is registered
                        if session_id not in session_manager.orchestrators:
                            await websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Session is not currently running",
                            }))
                        else:
                            # Only pass allowed keys (prevent message spoofing)
                            safe_data = {
                                k: v for k, v in intervention_data.items()
                                if k in ("content", "target_agent_type", "target_agent_index",
                                         "intervention_type", "instruction")
                            }
                            await session_manager.broadcast("intervention", {
                                "session_id": session_id,
                                **safe_data,
                            })

            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": "Invalid JSON",
                }))

    except WebSocketDisconnect:
        pass
    finally:
        await session_manager.disconnect(websocket, session_id)
