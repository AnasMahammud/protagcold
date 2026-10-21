"""Minimal, dependency-free RFC 6455 WebSocket implementation for asyncio streams.

Supports: handshake, masked client frames, fragmentation, text/binary, ping/pong, close,
message size limits. Server -> client frames are unmasked as the RFC requires.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import struct

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 64 * 1024

OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WebSocketClosed(Exception):
    pass


def accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def handshake_response(headers: dict) -> bytes | None:
    """Build the 101 response for a valid upgrade request, or None if invalid."""
    if headers.get("upgrade", "").lower() != "websocket":
        return None
    if "upgrade" not in headers.get("connection", "").lower():
        return None
    key = headers.get("sec-websocket-key")
    if not key or headers.get("sec-websocket-version") != "13":
        return None
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n"
    ).encode()


def encode_frame(payload: bytes, opcode: int = OP_TEXT, fin: bool = True, mask: bytes | None = None) -> bytes:
    b0 = (0x80 if fin else 0) | opcode
    n = len(payload)
    mbit = 0x80 if mask else 0
    if n < 126:
        header = struct.pack("!BB", b0, mbit | n)
    elif n < 65536:
        header = struct.pack("!BBH", b0, mbit | 126, n)
    else:
        header = struct.pack("!BBQ", b0, mbit | 127, n)
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return header + mask + payload
    return header + payload


async def read_frame(reader: asyncio.StreamReader, require_mask: bool = True):
    head = await reader.readexactly(2)
    b0, b1 = head[0], head[1]
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack("!H", await reader.readexactly(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", await reader.readexactly(8))[0]
    if n > MAX_MESSAGE:
        raise WebSocketClosed("frame too large")
    if require_mask and not masked:
        raise WebSocketClosed("client frames must be masked")
    mask = await reader.readexactly(4) if masked else None
    data = await reader.readexactly(n) if n else b""
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return fin, opcode, data


class WebSocket:
    """Server-side connection wrapper."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.closed = False
        self._write_lock = asyncio.Lock()
        peer = writer.get_extra_info("peername")
        self.peer = f"{peer[0]}:{peer[1]}" if peer else "?"

    async def recv(self) -> str:
        """Return the next complete text message. Raises WebSocketClosed."""
        buf = bytearray()
        msg_op = None
        while True:
            try:
                fin, op, data = await read_frame(self.reader)
            except (asyncio.IncompleteReadError, ConnectionError) as e:
                self.closed = True
                raise WebSocketClosed(str(e)) from e
            if op == OP_CLOSE:
                await self._send_raw(encode_frame(data[:2], OP_CLOSE))
                self.closed = True
                raise WebSocketClosed("closed by peer")
            if op == OP_PING:
                await self._send_raw(encode_frame(data, OP_PONG))
                continue
            if op == OP_PONG:
                continue
            if op in (OP_TEXT, OP_BIN):
                buf = bytearray(data)
                msg_op = op
            elif op == OP_CONT:
                if msg_op is None:
                    raise WebSocketClosed("unexpected continuation")
                buf.extend(data)
            if len(buf) > MAX_MESSAGE:
                raise WebSocketClosed("message too large")
            if fin:
                if msg_op == OP_BIN:
                    msg_op = None
                    continue  # binary messages are not part of the protocol
                try:
                    return buf.decode("utf-8")
                except UnicodeDecodeError as e:
                    raise WebSocketClosed("invalid utf-8") from e

    async def send_text(self, text: str):
        await self._send_raw(encode_frame(text.encode("utf-8"), OP_TEXT))

    async def send_json(self, obj):
        await self.send_text(json.dumps(obj, separators=(",", ":")))

    async def _send_raw(self, data: bytes):
        if self.closed:
            return
        async with self._write_lock:
            try:
                self.writer.write(data)
                await self.writer.drain()
            except (ConnectionError, RuntimeError):
                self.closed = True

    async def close(self, code: int = 1000, reason: str = ""):
        if self.closed:
            return
        try:
            await self._send_raw(encode_frame(struct.pack("!H", code) + reason.encode()[:120], OP_CLOSE))
        finally:
            self.closed = True
            try:
                self.writer.close()
            except Exception:  # noqa: BLE001 - best effort
                pass
