#!/usr/bin/env python3
"""Проверка iroh-bridge между двумя машинами за NAT без приложения.

Поднимает сайдкар, открывает канал событий, делает join и гонит данные одним
bi-stream'ом: гость шлёт заголовок (8 байт, длина) + случайные байты, хост
читает ровно столько, отвечает строкой sha256 и закрывает стрим. Печатает
все события моста с таймингом — главное здесь `conn-type` (relay / direct).

  хост:  nat-probe.py --bin ./iroh-bridge --role host          → печатает КОД (свой EndpointId)
  гость: nat-probe.py --bin ./iroh-bridge --role guest --topic <КОД> [--mb 32] [--addrs ip:port,...]

Код — публичный ключ хоста, он появляется только после подъёма Endpoint'а,
поэтому хост стартует первым.

Только стандартная библиотека: одинаково работает на Windows и на VPS.
"""
import argparse
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

T0 = time.monotonic()


def log(msg):
    print(f"[{time.monotonic() - T0:7.3f}] {msg}", flush=True)


def connect(port):
    s = socket.create_connection(("127.0.0.1", port))
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    return s


def request(port, obj):
    """Одно TCP-соединение к мосту: строка запроса → строка ответа → сырой поток."""
    s = connect(port)
    s.sendall((json.dumps(obj) + "\n").encode())
    f = s.makefile("rb")
    line = f.readline()
    if not line:
        raise RuntimeError(f"мост закрыл соединение на {obj}")
    reply = json.loads(line)
    if not reply.get("ok"):
        raise RuntimeError(f"{obj['op']}: {reply}")
    return s, f, reply


def read_exact(f, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = f.read(min(1 << 20, n - len(buf)))
        if not chunk:
            raise EOFError(f"стрим оборвался на {len(buf)} из {n}")
        buf += chunk
    return bytes(buf)


class Events:
    def __init__(self, port):
        self.sock, self.f, _ = request(port, {"op": "control"})
        self.lock = threading.Condition()
        self.items = []
        self.conn_types = []
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        for line in self.f:
            ev = json.loads(line)
            log(f"event {ev}")
            with self.lock:
                self.items.append(ev)
                if ev.get("event") == "conn-type":
                    self.conn_types.append((time.monotonic() - T0, ev["connectionType"]))
                self.lock.notify_all()

    def wait(self, kind, timeout):
        deadline = time.monotonic() + timeout
        with self.lock:
            while True:
                for ev in self.items:
                    if ev.get("event") == kind:
                        self.items.remove(ev)
                        return ev
                    if ev.get("event") == "error":
                        raise RuntimeError(f"мост сообщил ошибку: {ev.get('message')}")
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f"не дождались события {kind} за {timeout} с")
                self.lock.wait(left)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("--role", choices=["host", "guest"], required=True)
    ap.add_argument("--topic", help="код хоста (его EndpointId, 64 hex); хосту не нужен")
    ap.add_argument("--addrs", default="", help="известные адреса хоста ip:port через запятую")
    ap.add_argument("--mb", type=int, default=32)
    ap.add_argument("--timeout", type=int, default=120, help="ожидание пира, с")
    ap.add_argument("--linger", type=int, default=15, help="сколько ещё смотреть на путь после передачи, с")
    ap.add_argument("--mdns", action="store_true")
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()

    argv = [a.bin, "--bridge-port", "0"]
    if a.mdns:
        argv.append("--mdns")
    if a.offline:
        argv.append("--offline")
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    threading.Thread(
        target=lambda: [log(f"bridge stderr: {l.rstrip()}") for l in proc.stderr], daemon=True
    ).start()
    ready = json.loads(proc.stdout.readline())
    port = ready["bridgePort"]
    log(f"мост поднят: {ready}")

    try:
        events = Events(port)
        join = {"op": "join", "role": a.role}
        if a.topic:
            join["topic"] = a.topic
        elif a.role == "guest":
            ap.error("гостю нужен --topic")
        if a.addrs:
            join["addrs"] = [x.strip() for x in a.addrs.split(",") if x.strip()]
        _, _, reply = request(port, join)
        log(f"join {a.role}: endpointId={reply['endpointId']} addrs={reply['addrs']}")
        if a.role == "host":
            log(f"КОД: {reply['endpointId']}")

        t_join = time.monotonic()
        peer = events.wait("peer", a.timeout)
        t_peer = time.monotonic()
        log(f"ПИР найден за {t_peer - t_join:.2f} с: {peer['endpointId']} ({peer['direction']})")

        if a.role == "guest":
            payload = os.urandom(a.mb << 20)
            digest = hashlib.sha256(payload).hexdigest()
            s, f, _ = request(port, {"op": "open"})
            t0 = time.monotonic()
            s.sendall(struct.pack(">Q", len(payload)) + payload)
            s.shutdown(socket.SHUT_WR)
            answer = f.readline().decode().strip()
            dt = time.monotonic() - t0
            ok = answer == digest
            log(f"передано {a.mb} МБ за {dt:.2f} с = {a.mb / dt:.1f} МБ/с, sha256 {'сошёлся' if ok else 'НЕ СОШЁЛСЯ'}")
            s.close()
        else:
            ev = events.wait("stream", a.timeout)
            s, f, _ = request(port, {"op": "attach", "id": ev["id"]})
            t0 = time.monotonic()
            (n,) = struct.unpack(">Q", read_exact(f, 8))
            data = read_exact(f, n)
            dt = time.monotonic() - t0
            digest = hashlib.sha256(data).hexdigest()
            s.sendall((digest + "\n").encode())
            s.shutdown(socket.SHUT_WR)
            log(f"принято {n >> 20} МБ за {dt:.2f} с = {(n >> 20) / dt:.1f} МБ/с, sha256={digest[:16]}…")
            s.close()

        time.sleep(a.linger)
        log("ИТОГ путей: " + " → ".join(f"{k}@{t:.1f}s" for t, k in events.conn_types))
        request(port, {"op": "leave"})
    finally:
        proc.kill()


if __name__ == "__main__":
    main()
