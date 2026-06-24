#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import re
import socket
import struct
import subprocess
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = Path(__file__).resolve().parent / "static"
SERVER_LOG = ROOT / "server" / "logs" / "latest.log"
TUNNEL_LOG = ROOT / "logs" / "tunnel-loop.log"
BACKUP_DIR = ROOT / "backups" / "world"
BACKUP_CONFIG = ROOT / "panel" / "backup-config.json"
HOST = os.environ.get("PANEL_HOST", "127.0.0.1")
PORT = int(os.environ.get("PANEL_PORT", "8765"))
SLOW_STATS_CACHE = {"at": 0.0, "data": {}}
BACKUP_RUN_LOCK = threading.Lock()
BACKUP_STATE_LOCK = threading.Lock()
BACKUP_JOB = {
    "running": False,
    "started_at": "",
    "finished_at": "",
    "reason": "",
    "message": "",
    "file": "",
    "progress": 0,
    "total": 0,
}
DEFAULT_BACKUP_CONFIG = {
    "enabled": True,
    "mode": "daily",
    "time": "08:00",
    "interval_hours": 24,
    "keep": 7,
    "last_started_at": "",
    "last_success_at": "",
    "last_error": "",
    "last_file": "",
}
SENSITIVE_PROPERTY_KEYS = {
    "rcon.password",
    "management-server-secret",
    "management-server-tls-keystore-password",
}
EDITABLE_PROPERTIES = {
    "motd": {"type": "text", "max": 140},
    "difficulty": {"type": "choice", "choices": {"peaceful", "easy", "normal", "hard"}},
    "gamemode": {"type": "choice", "choices": {"survival", "creative", "adventure", "spectator"}},
    "max-players": {"type": "int", "min": 1, "max": 200},
    "view-distance": {"type": "int", "min": 2, "max": 32},
    "simulation-distance": {"type": "int", "min": 2, "max": 32},
    "spawn-protection": {"type": "int", "min": 0, "max": 64},
    "player-idle-timeout": {"type": "int", "min": 0, "max": 10080},
    "allow-flight": {"type": "bool"},
    "force-gamemode": {"type": "bool"},
    "hardcore": {"type": "bool"},
    "white-list": {"type": "bool"},
    "enforce-whitelist": {"type": "bool"},
    "online-mode": {"type": "bool"},
    "enable-status": {"type": "bool"},
    "hide-online-players": {"type": "bool"},
    "pvp": {"type": "bool"},
}


def run_cmd(args: list[str], timeout: float = 6) -> dict:
    try:
        result = subprocess.run(
            args,
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return {
            "ok": result.returncode == 0,
            "code": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "code": None,
            "stdout": (exc.stdout or "").strip() if isinstance(exc.stdout, str) else "",
            "stderr": "Command timed out",
        }


def read_tail(path: Path, lines: int = 160, max_bytes: int = 240_000) -> str:
    if not path.exists():
        return ""
    size = path.stat().st_size
    with path.open("rb") as handle:
        if size > max_bytes:
            handle.seek(size - max_bytes)
            handle.readline()
        data = handle.read()
    text = data.decode("utf-8", errors="replace")
    return "\n".join(text.splitlines()[-lines:])


def read_from(path: Path, start: int, max_bytes: int = 80_000) -> str:
    if not path.exists():
        return ""
    size = path.stat().st_size
    start = min(max(start, 0), size)
    if size - start > max_bytes:
        start = size - max_bytes
    with path.open("rb") as handle:
        handle.seek(start)
        data = handle.read()
    return data.decode("utf-8", errors="replace")


def parse_screen_sessions(output: str) -> dict:
    sessions = {}
    for line in output.splitlines():
        line = line.strip()
        if ".unmc-" not in line:
            continue
        first = line.split()[0]
        if "." not in first:
            continue
        _pid, name = first.split(".", 1)
        state = "attached" if "(Attached)" in line else "detached"
        sessions[name] = state
    return sessions


def process_snapshot() -> dict:
    ps = run_cmd(["ps", "-axo", "pid,etime,command"], timeout=4)
    java = []
    tunnel = []
    tunnel_loop = []
    panel = []
    for line in ps["stdout"].splitlines():
        if "purpur-26.1.2-2585.jar" in line:
            java.append(line.strip())
        if "0.0.0.0:43027:127.0.0.1:43027" in line and "/usr/bin/ssh -NT" in line:
            tunnel.append(line.strip())
        if "/scripts/tunnel-loop.sh" in line and not line.strip().startswith("rg "):
            tunnel_loop.append(line.strip())
        if "/panel/server.py" in line and ("Python" in line or "python" in line):
            panel.append(line.strip())
    return {"java": java, "tunnel": tunnel, "tunnel_loop": tunnel_loop, "panel": panel}


def process_ids(lines: list[str]) -> list[str]:
    pids = []
    for line in lines:
        parts = line.split(None, 2)
        if parts and parts[0].isdigit():
            pids.append(parts[0])
    return pids


def process_metrics(lines: list[str]) -> list[dict]:
    pids = process_ids(lines)
    if not pids:
        return []
    result = run_cmd(["ps", "-p", ",".join(pids), "-o", "pid=,%cpu=,%mem=,rss=,etime="], timeout=4)
    metrics = []
    for raw in result["stdout"].splitlines():
        parts = raw.split()
        if len(parts) < 5:
            continue
        try:
            rss_kib = int(parts[3])
            metrics.append(
                {
                    "pid": int(parts[0]),
                    "cpu_percent": float(parts[1]),
                    "mem_percent": float(parts[2]),
                    "rss_mb": round(rss_kib / 1024, 1),
                    "etime": parts[4],
                }
            )
        except ValueError:
            continue
    return metrics


def physical_memory_mb() -> int:
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        return round((pages * page_size) / 1024 / 1024)
    except (AttributeError, OSError, ValueError):
        result = run_cmd(["sysctl", "-n", "hw.memsize"], timeout=3)
        try:
            return round(int(result["stdout"].strip()) / 1024 / 1024)
        except ValueError:
            return 0


def server_properties() -> dict:
    props = {}
    path = ROOT / "server" / "server.properties"
    if not path.exists():
        return props
    for raw in path.read_text(errors="replace").splitlines():
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        if key not in SENSITIVE_PROPERTY_KEYS:
            props[key] = value
    return props


def plugin_inventory() -> list[dict]:
    plugins_dir = ROOT / "server" / "plugins"
    if not plugins_dir.exists():
        return []
    plugins = []
    for path in sorted(plugins_dir.iterdir(), key=lambda item: item.name.lower()):
        if not path.is_file():
            continue
        if path.name.startswith("."):
            continue
        enabled = path.name.endswith(".jar")
        disabled = path.name.endswith(".jar.disabled")
        if not enabled and not disabled:
            continue
        display = path.name.removesuffix(".disabled").removesuffix(".jar")
        plugins.append(
            {
                "file": path.name,
                "name": display,
                "enabled": enabled,
                "size": human_size(path.stat().st_size),
                "mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(path.stat().st_mtime)),
                "restart_required": True,
            }
        )
    return plugins


def varint(value: int) -> bytes:
    out = bytearray()
    value &= 0xFFFFFFFF
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def read_varint(sock: socket.socket) -> int:
    number = 0
    shift = 0
    for _ in range(5):
        data = sock.recv(1)
        if not data:
            raise EOFError("closed")
        value = data[0]
        number |= (value & 0x7F) << shift
        if not value & 0x80:
            return number
        shift += 7
    raise ValueError("varint too long")


def packet(packet_id: int, payload: bytes = b"") -> bytes:
    body = varint(packet_id) + payload
    return varint(len(body)) + body


def mc_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return varint(len(encoded)) + encoded


def description_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if "text" in value:
            return str(value["text"])
        if "extra" in value and isinstance(value["extra"], list):
            return "".join(description_text(item) for item in value["extra"])
    return ""


def minecraft_status(host: str, port: int = 43027, timeout: float = 2.5) -> dict:
    started = time.time()
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(
                packet(0, varint(772) + mc_string(host) + struct.pack(">H", port) + varint(1))
            )
            sock.sendall(packet(0))
            read_varint(sock)
            read_varint(sock)
            size = read_varint(sock)
            data = b""
            while len(data) < size:
                chunk = sock.recv(size - len(data))
                if not chunk:
                    raise EOFError("closed during payload")
                data += chunk
            status = json.loads(data.decode("utf-8"))
        players = status.get("players", {})
        sample = players.get("sample") or []
        return {
            "ok": True,
            "host": host,
            "port": port,
            "version": status.get("version", {}).get("name", ""),
            "online": players.get("online"),
            "max": players.get("max"),
            "sample": [
                {"id": str(item.get("id", "")), "name": str(item.get("name", ""))}
                for item in sample
                if isinstance(item, dict) and item.get("name")
            ],
            "motd": description_text(status.get("description")),
            "latency_ms": round((time.time() - started) * 1000),
        }
    except Exception as exc:
        return {"ok": False, "host": host, "port": port, "error": f"{type(exc).__name__}: {exc}"}


def disk_size(path: str) -> str:
    result = run_cmd(["du", "-sh", path], timeout=5)
    if not result["ok"] or not result["stdout"]:
        return ""
    return result["stdout"].split()[0]


def disk_usage(path: str) -> dict:
    result = run_cmd(["du", "-sk", path], timeout=5)
    if not result["ok"] or not result["stdout"]:
        return {"label": "", "kib": 0}
    try:
        kib = int(result["stdout"].split()[0])
    except (ValueError, IndexError):
        return {"label": "", "kib": 0}
    return {"label": human_size(kib * 1024), "kib": kib}


def human_size(size_bytes: int) -> str:
    value = float(size_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.1f}{unit}" if unit in {"GB", "TB"} else f"{round(value)}{unit}"
        value /= 1024


def path_mtime(path: Path) -> str:
    if not path.exists():
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(path.stat().st_mtime))


def safe_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(errors="replace"))
    except (OSError, json.JSONDecodeError):
        return fallback


def local_time_text(timestamp=None) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp or time.time()))


def parse_local_time(value: str) -> float:
    if not value:
        return 0.0
    try:
        return time.mktime(time.strptime(value, "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return 0.0


def normalize_backup_config(data=None) -> dict:
    raw = {**DEFAULT_BACKUP_CONFIG, **(data or {})}
    enabled = bool(raw.get("enabled", True))
    mode = str(raw.get("mode", "daily")).strip().lower()
    if mode not in {"daily", "interval"}:
        mode = "daily"
    backup_time = str(raw.get("time", "08:00")).strip()
    if not re.match(r"^\d{2}:\d{2}$", backup_time):
        backup_time = "08:00"
    hour, minute = [int(part) for part in backup_time.split(":", 1)]
    if hour > 23 or minute > 59:
        backup_time = "08:00"
    try:
        interval_hours = int(raw.get("interval_hours", 24))
    except (TypeError, ValueError):
        interval_hours = 24
    try:
        keep = int(raw.get("keep", 7))
    except (TypeError, ValueError):
        keep = 7
    return {
        "enabled": enabled,
        "mode": mode,
        "time": backup_time,
        "interval_hours": min(max(interval_hours, 1), 168),
        "keep": min(max(keep, 1), 60),
        "last_started_at": str(raw.get("last_started_at", "")),
        "last_success_at": str(raw.get("last_success_at", "")),
        "last_error": str(raw.get("last_error", "")),
        "last_file": str(raw.get("last_file", "")),
    }


def load_backup_config() -> dict:
    return normalize_backup_config(safe_json(BACKUP_CONFIG, DEFAULT_BACKUP_CONFIG))


def save_backup_config(config: dict) -> dict:
    clean = normalize_backup_config(config)
    BACKUP_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    tmp = BACKUP_CONFIG.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(BACKUP_CONFIG)
    return clean


def update_backup_config(**changes) -> dict:
    config = load_backup_config()
    config.update(changes)
    return save_backup_config(config)


def backup_files() -> list[Path]:
    if not BACKUP_DIR.exists():
        return []
    return sorted(
        [path for path in BACKUP_DIR.glob("world-*.zip") if path.is_file()],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def backup_records(limit: int = 8) -> list[dict]:
    records = []
    for path in backup_files()[:limit]:
        stat = path.stat()
        records.append(
            {
                "name": path.name,
                "size": human_size(stat.st_size),
                "created_at": local_time_text(stat.st_mtime),
            }
        )
    return records


def prune_backups(keep: int) -> list[str]:
    removed = []
    for path in backup_files()[keep:]:
        try:
            path.unlink()
            removed.append(path.name)
        except OSError:
            continue
    return removed


def next_backup_timestamp(config=None):
    config = normalize_backup_config(config or load_backup_config())
    if not config["enabled"]:
        return None
    last_started = parse_local_time(config.get("last_started_at", ""))
    last_success = parse_local_time(config.get("last_success_at", ""))
    last_reference = max(last_started, last_success)
    now = time.time()
    if config["mode"] == "interval":
        if not last_reference:
            return now
        return last_reference + config["interval_hours"] * 3600

    hour, minute = [int(part) for part in config["time"].split(":", 1)]
    local_now = time.localtime(now)
    today_due = time.mktime(
        (
            local_now.tm_year,
            local_now.tm_mon,
            local_now.tm_mday,
            hour,
            minute,
            0,
            local_now.tm_wday,
            local_now.tm_yday,
            local_now.tm_isdst,
        )
    )
    if last_reference >= today_due:
        return today_due + 86400
    if now >= today_due:
        return now
    return today_due


def backup_job_snapshot() -> dict:
    with BACKUP_STATE_LOCK:
        return dict(BACKUP_JOB)


def set_backup_job(**changes) -> None:
    with BACKUP_STATE_LOCK:
        BACKUP_JOB.update(changes)


def send_console_quiet(command: str) -> None:
    sessions = parse_screen_sessions(run_cmd(["screen", "-ls"], timeout=4)["stdout"])
    if "unmc-je" in sessions:
        run_cmd(["screen", "-S", "unmc-je", "-p", "0", "-X", "stuff", "\x15" + command + "\r"], timeout=5)


def create_world_backup(reason: str = "manual") -> dict:
    if not BACKUP_RUN_LOCK.acquire(blocking=False):
        return {"ok": False, "code": None, "stdout": "", "stderr": "已经有一个备份正在运行。"}
    config = update_backup_config(last_started_at=local_time_text(), last_error="")
    set_backup_job(
        running=True,
        started_at=config["last_started_at"],
        finished_at="",
        reason=reason,
        message="正在保存世界...",
        file="",
        progress=0,
        total=0,
    )
    try:
        world_dir = ROOT / "server" / "world"
        if not world_dir.exists():
            raise FileNotFoundError("找不到 server/world")

        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        send_console_quiet("save-all flush")
        time.sleep(1.5)

        files = [path for path in world_dir.rglob("*") if path.is_file()]
        total = len(files)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        filename = f"world-{timestamp}.zip"
        tmp_path = BACKUP_DIR / f".{filename}.tmp"
        final_path = BACKUP_DIR / filename
        set_backup_job(message="正在压缩存档...", file=filename, total=total)

        with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
            for index, path in enumerate(files, start=1):
                try:
                    archive.write(path, Path("world") / path.relative_to(world_dir))
                except FileNotFoundError:
                    continue
                if index == total or index % 120 == 0:
                    set_backup_job(progress=index)

        tmp_path.replace(final_path)
        removed = prune_backups(config["keep"])
        finished = local_time_text()
        update_backup_config(
            last_success_at=finished,
            last_error="",
            last_file=filename,
        )
        set_backup_job(
            running=False,
            finished_at=finished,
            message=f"备份完成：{filename}",
            progress=total,
            file=filename,
        )
        removed_text = f"\n已清理旧备份：{len(removed)} 份。" if removed else ""
        return {"ok": True, "code": 0, "stdout": f"备份完成：{filename}{removed_text}", "stderr": ""}
    except Exception as exc:
        finished = local_time_text()
        update_backup_config(last_error=str(exc))
        set_backup_job(running=False, finished_at=finished, message=f"备份失败：{exc}")
        return {"ok": False, "code": 1, "stdout": "", "stderr": str(exc)}
    finally:
        BACKUP_RUN_LOCK.release()


def start_backup(reason: str = "manual") -> dict:
    if backup_job_snapshot().get("running"):
        return {"ok": True, "code": 0, "stdout": "备份已经在运行。", "stderr": ""}
    thread = threading.Thread(target=create_world_backup, args=(reason,), daemon=True)
    thread.start()
    return {"ok": True, "code": 0, "stdout": "备份已开始，会在后台压缩存档。", "stderr": ""}


def backup_status() -> dict:
    config = load_backup_config()
    next_ts = next_backup_timestamp(config)
    return {
        "config": config,
        "job": backup_job_snapshot(),
        "next_run_at": local_time_text(next_ts) if next_ts else "",
        "directory": str(BACKUP_DIR),
        "backups": backup_records(limit=8),
        "count": len(backup_files()),
    }


def backup_scheduler_loop() -> None:
    while True:
        try:
            config = load_backup_config()
            next_ts = next_backup_timestamp(config)
            if next_ts and time.time() >= next_ts and not backup_job_snapshot().get("running"):
                start_backup("scheduled")
        except Exception:
            pass
        time.sleep(30)


def find_count(args: list[str], timeout: float = 6) -> int:
    result = run_cmd(["find", *args], timeout=timeout)
    if not result["ok"]:
        return 0
    return len([line for line in result["stdout"].splitlines() if line.strip()])


def connection_summary() -> dict:
    result = run_cmd(["lsof", "-nP", "-iTCP:43027"], timeout=4)
    established = [line.strip() for line in result["stdout"].splitlines() if "(ESTABLISHED)" in line]
    return {"established": len(established), "raw": result["stdout"]}


def short_id(uuid: str) -> str:
    return uuid.split("-")[0] if uuid else "unknown"


def pretty_id(value: str) -> str:
    value = value.replace("minecraft:", "")
    return value.replace("_", " ")


def player_names() -> dict:
    names = {}
    for entry in safe_json(ROOT / "server" / "usercache.json", []):
        uuid = entry.get("uuid")
        name = entry.get("name")
        if uuid and name:
            names[uuid] = name
    for entry in safe_json(ROOT / "server" / "ops.json", []):
        uuid = entry.get("uuid")
        name = entry.get("name")
        if uuid and name:
            names.setdefault(uuid, name)
    return names


def leaderboard(rows: list[dict], key: str, limit: int = 5) -> list[dict]:
    return [
        row
        for row in sorted(rows, key=lambda item: item.get(key, 0), reverse=True)[:limit]
        if row.get(key, 0)
    ]


def movement_cm(custom: dict) -> int:
    keys = [
        "minecraft:walk_one_cm",
        "minecraft:sprint_one_cm",
        "minecraft:fly_one_cm",
        "minecraft:fall_one_cm",
        "minecraft:climb_one_cm",
        "minecraft:swim_one_cm",
        "minecraft:walk_under_water_one_cm",
        "minecraft:walk_on_water_one_cm",
        "minecraft:crouch_one_cm",
        "minecraft:boat_one_cm",
        "minecraft:horse_one_cm",
        "minecraft:minecart_one_cm",
        "minecraft:aviate_one_cm",
        "minecraft:happy_ghast_one_cm",
        "minecraft:nautilus_one_cm",
    ]
    return sum(int(custom.get(key, 0)) for key in keys)


def advancement_count(path: Path) -> int:
    data = safe_json(path, {})
    count = 0
    for key, value in data.items():
        if key.startswith("minecraft:recipes/"):
            continue
        if isinstance(value, dict) and value.get("done"):
            count += 1
    return count


def player_stat_summary() -> dict:
    names = player_names()
    stats_dir = ROOT / "server" / "world" / "players" / "stats"
    advancements_dir = ROOT / "server" / "world" / "players" / "advancements"
    rows = []
    mined_items = {}
    crafted_items = {}
    used_items = {}

    for path in sorted(stats_dir.glob("*.json")) if stats_dir.exists() else []:
        uuid = path.stem
        stats = safe_json(path, {}).get("stats", {})
        custom = stats.get("minecraft:custom", {})
        mined = stats.get("minecraft:mined", {})
        crafted = stats.get("minecraft:crafted", {})
        used = stats.get("minecraft:used", {})
        killed = stats.get("minecraft:killed", {})
        killed_by = stats.get("minecraft:killed_by", {})

        for key, value in mined.items():
            mined_items[key] = mined_items.get(key, 0) + int(value)
        for key, value in crafted.items():
            crafted_items[key] = crafted_items.get(key, 0) + int(value)
        for key, value in used.items():
            used_items[key] = used_items.get(key, 0) + int(value)

        play_ticks = int(custom.get("minecraft:play_time", 0))
        distance = movement_cm(custom)
        advancements = advancement_count(advancements_dir / f"{uuid}.json")
        rows.append(
            {
                "uuid": uuid,
                "name": names.get(uuid, short_id(uuid)),
                "play_hours": round(play_ticks / 20 / 3600, 1),
                "deaths": int(custom.get("minecraft:deaths", 0)),
                "mob_kills": int(custom.get("minecraft:mob_kills", 0)),
                "player_kills": int(custom.get("minecraft:player_kills", 0)),
                "jumps": int(custom.get("minecraft:jump", 0)),
                "damage_dealt": int(custom.get("minecraft:damage_dealt", 0)),
                "distance_km": round(distance / 100_000, 1),
                "blocks_mined": sum(int(value) for value in mined.values()),
                "items_crafted": sum(int(value) for value in crafted.values()),
                "items_used": sum(int(value) for value in used.values()),
                "entities_killed": sum(int(value) for value in killed.values()),
                "killed_by": sum(int(value) for value in killed_by.values()),
                "advancements": advancements,
            }
        )

    merged = {}
    numeric_keys = [
        "play_hours",
        "deaths",
        "mob_kills",
        "player_kills",
        "jumps",
        "damage_dealt",
        "distance_km",
        "blocks_mined",
        "items_crafted",
        "items_used",
        "entities_killed",
        "killed_by",
        "advancements",
    ]
    for row in rows:
        target = merged.setdefault(row["name"], {"uuid": row["uuid"], "name": row["name"]})
        for key in numeric_keys:
            target[key] = target.get(key, 0) + row.get(key, 0)
    merged_rows = list(merged.values())
    for row in merged_rows:
        row["play_hours"] = round(row.get("play_hours", 0), 1)
        row["distance_km"] = round(row.get("distance_km", 0), 1)

    def top_item(items: dict) -> dict:
        if not items:
            return {"name": "--", "count": 0}
        key, value = max(items.items(), key=lambda item: item[1])
        return {"name": pretty_id(key), "count": value}

    return {
        "totals": {
            "known_players": len(names),
            "stat_players": len(rows),
            "unique_stat_players": len(merged_rows),
            "play_hours": round(sum(row["play_hours"] for row in rows), 1),
            "deaths": sum(row["deaths"] for row in rows),
            "mob_kills": sum(row["mob_kills"] for row in rows),
            "player_kills": sum(row["player_kills"] for row in rows),
            "distance_km": round(sum(row["distance_km"] for row in rows), 1),
            "blocks_mined": sum(row["blocks_mined"] for row in rows),
            "items_crafted": sum(row["items_crafted"] for row in rows),
            "advancements": sum(row["advancements"] for row in rows),
        },
        "leaderboards": {
            "playtime": leaderboard(merged_rows, "play_hours"),
            "distance": leaderboard(merged_rows, "distance_km"),
            "deaths": leaderboard(merged_rows, "deaths"),
            "mined": leaderboard(merged_rows, "blocks_mined"),
            "mob_kills": leaderboard(merged_rows, "mob_kills"),
            "advancements": leaderboard(merged_rows, "advancements"),
        },
        "items": {
            "most_mined": top_item(mined_items),
            "most_crafted": top_item(crafted_items),
            "most_used": top_item(used_items),
        },
    }


def log_activity_summary() -> dict:
    text = read_tail(SERVER_LOG, lines=900, max_bytes=900_000)
    joined = []
    left = []
    events = []
    chat = []
    for line in text.splitlines():
        join_match = re.search(r"\]: ([A-Za-z0-9_]{3,16}) joined the game", line)
        left_match = re.search(r"\]: ([A-Za-z0-9_]{3,16}) left the game", line)
        chat_match = re.search(r"\]: <([^>]+)> (.+)$", line)
        if join_match:
            event = {"line": line, "name": join_match.group(1), "type": "join"}
            joined.append(event)
            events.append(event)
        if left_match:
            event = {"line": line, "name": left_match.group(1), "type": "left"}
            left.append(event)
            events.append(event)
        if chat_match:
            chat.append({"line": line, "name": chat_match.group(1), "message": chat_match.group(2)})

    online = []
    for event in events:
        name = event["name"]
        if event["type"] == "join" and name not in online:
            online.append(name)
        if event["type"] == "left" and name in online:
            online.remove(name)

    current_day = time.strftime("%Y-%m-%d")
    today_joined = [event for event in joined if current_day in event["line"] or re.match(r"\[\d{2}:\d{2}:\d{2}\]", event["line"])]
    recent = list(reversed(joined[-8:]))
    return {
        "since_start": {
            "join_events": len(joined),
            "unique_joined": len({event["name"] for event in joined}),
            "currently_online_names": online,
        },
        "today": {
            "join_events": len(today_joined),
            "unique_joined": len({event["name"] for event in today_joined}),
        },
        "recent_joins": recent,
        "last_chat": chat[-5:],
    }


def slow_stats() -> dict:
    now = time.time()
    if now - float(SLOW_STATS_CACHE["at"]) < 30:
        return SLOW_STATS_CACHE["data"]

    server_usage = disk_usage("server")
    world_usage = disk_usage("server/world")
    plugins_dir = ROOT / "server" / "plugins"
    playerdata_dirs = [
        ROOT / "server" / "world" / "playerdata",
        ROOT / "server" / "world" / "players" / "data",
    ]
    stats_dirs = [
        ROOT / "server" / "world" / "stats",
        ROOT / "server" / "world" / "players" / "stats",
    ]
    advancement_dirs = [
        ROOT / "server" / "world" / "advancements",
        ROOT / "server" / "world" / "players" / "advancements",
    ]
    data = {
        "disk": {
            "server": server_usage,
            "world": world_usage,
            "logs": disk_usage("server/logs"),
            "plugins": disk_usage("server/plugins"),
        },
        "world": {
            "region_files": find_count(["server/world", "-path", "*/region/*.mca", "-type", "f"]),
            "player_files": sum(len(list(path.glob("*.dat"))) for path in playerdata_dirs if path.exists()),
            "stats_files": sum(len(list(path.glob("*.json"))) for path in stats_dirs if path.exists()),
            "advancement_files": sum(len(list(path.glob("*.json"))) for path in advancement_dirs if path.exists()),
            "level_dat_mtime": path_mtime(ROOT / "server" / "world" / "level.dat"),
        },
        "plugins": {
            "jars": len(list(plugins_dir.glob("*.jar"))) if plugins_dir.exists() else 0,
            "files": plugin_inventory(),
        },
        "players": player_stat_summary(),
        "activity": log_activity_summary(),
    }
    SLOW_STATS_CACHE["at"] = now
    SLOW_STATS_CACHE["data"] = data
    return data


def local_listen() -> dict:
    result = run_cmd(["lsof", "-nP", "-iTCP:43027", "-sTCP:LISTEN"], timeout=4)
    return {"ok": result["ok"] and "java" in result["stdout"], "raw": result["stdout"]}


def status_payload() -> dict:
    screen_result = run_cmd(["screen", "-ls"], timeout=4)
    sessions = parse_screen_sessions(screen_result["stdout"] + "\n" + screen_result["stderr"])
    procs = process_snapshot()
    warnings = []
    if len(procs["tunnel"]) > 1:
        warnings.append(f"duplicate tunnel ssh processes: {len(procs['tunnel'])}")
    checks = [
        minecraft_status("127.0.0.1"),
        minecraft_status("playje.unmcserver.com"),
        minecraft_status("la.playje.unmcserver.com"),
    ]
    slow = slow_stats()
    process_stats = {
        "java": process_metrics(procs["java"]),
        "tunnel": process_metrics(procs["tunnel"]),
        "panel": process_metrics(procs["panel"]),
    }
    try:
        load_1, load_5, load_15 = os.getloadavg()
    except OSError:
        load_1, load_5, load_15 = (0.0, 0.0, 0.0)
    cpu_cores = os.cpu_count() or 1
    memory_mb = physical_memory_mb()
    return {
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "properties": server_properties(),
        "sessions": sessions,
        "processes": procs,
        "process_stats": process_stats,
        "local_listen": local_listen(),
        "minecraft": checks,
        "disk": {"server": disk_size("server"), "world": disk_size("server/world")},
        "stats": {
            **slow,
            "connections": connection_summary(),
            "system": {
                "load": [round(load_1, 2), round(load_5, 2), round(load_15, 2)],
                "cores": cpu_cores,
                "memory_mb": memory_mb,
            },
        },
        "backup": backup_status(),
        "warnings": warnings,
        "running": {
            "server": bool(procs["java"]) and local_listen()["ok"],
            "tunnel": bool(procs["tunnel"]),
            "panel": True,
        },
    }


def action_start_all() -> dict:
    return run_cmd([str(ROOT / "scripts" / "start-all.sh")], timeout=12)


def action_start_server() -> dict:
    sessions = parse_screen_sessions(run_cmd(["screen", "-ls"], timeout=4)["stdout"])
    if "unmc-je" in sessions:
        if process_snapshot()["java"] and local_listen()["ok"]:
            return {"ok": True, "code": 0, "stdout": "Screen session unmc-je is already running.", "stderr": ""}
        for _ in range(12):
            time.sleep(1)
            sessions = parse_screen_sessions(run_cmd(["screen", "-ls"], timeout=4)["stdout"])
            if "unmc-je" not in sessions:
                break
        else:
            run_cmd(["screen", "-S", "unmc-je", "-X", "quit"], timeout=4)
            time.sleep(1)
    return run_cmd(["screen", "-dmS", "unmc-je", str(ROOT / "scripts" / "start-je.sh")], timeout=8)


def action_stop_server() -> dict:
    sessions = parse_screen_sessions(run_cmd(["screen", "-ls"], timeout=4)["stdout"])
    if "unmc-je" not in sessions:
        if process_snapshot()["java"]:
            return {"ok": False, "code": None, "stdout": "", "stderr": "找到 Java 进程，但没有找到 unmc-je 控制台。为避免误杀，请到终端里手动确认。"}
        return {"ok": True, "code": 0, "stdout": "JE is already stopped.", "stderr": ""}
    return run_cmd(["screen", "-S", "unmc-je", "-p", "0", "-X", "stuff", "\x15stop\r"], timeout=5)


def wait_for_server_state(running: bool, timeout: float = 70) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        procs = process_snapshot()
        is_running = bool(procs["java"]) and local_listen()["ok"]
        if is_running == running:
            return True
        time.sleep(1)
    return False


def action_restart_server() -> dict:
    stop = action_stop_server()
    if not stop["ok"]:
        return stop

    stopped = wait_for_server_state(False, timeout=45)
    if not stopped:
        return {
            "ok": False,
            "code": 1,
            "stdout": "\n".join(part for part in [stop.get("stdout", ""), "JE 在 45 秒内没有完全停止，未继续启动。"] if part),
            "stderr": stop.get("stderr", ""),
        }
    start = action_start_server()
    if not start["ok"]:
        return start

    started = wait_for_server_state(True, timeout=90)
    stdout = "\n".join(
        part
        for part in [
            stop.get("stdout", ""),
            "JE 已停止。",
            start.get("stdout", ""),
            "JE 已重新启动。" if started else "JE 启动命令已发送，但暂时还没有监听端口。",
        ]
        if part
    )
    stderr = "\n".join(part for part in [stop.get("stderr", ""), start.get("stderr", "")] if part)
    return {"ok": started and start["ok"], "code": 0 if started and start["ok"] else 1, "stdout": stdout, "stderr": stderr}


def action_start_tunnel() -> dict:
    sessions = parse_screen_sessions(run_cmd(["screen", "-ls"], timeout=4)["stdout"])
    if "unmc-tunnel" in sessions:
        return {"ok": True, "code": 0, "stdout": "Tunnel screen already running.", "stderr": ""}
    return run_cmd(["screen", "-dmS", "unmc-tunnel", str(ROOT / "scripts" / "tunnel-loop.sh")], timeout=5)


def action_stop_tunnel() -> dict:
    return run_cmd([str(ROOT / "scripts" / "stop-tunnel.sh")], timeout=8)


def action_restart_tunnel() -> dict:
    action_stop_tunnel()
    time.sleep(2)
    return action_start_tunnel()


def action_console(command: str) -> dict:
    command = command.strip()
    if not command:
        return {"ok": False, "code": None, "stdout": "", "stderr": "Empty command"}
    if "\n" in command or "\r" in command:
        return {"ok": False, "code": None, "stdout": "", "stderr": "Command must be one line"}
    if len(command) > 220:
        return {"ok": False, "code": None, "stdout": "", "stderr": "Command is too long"}
    sessions = parse_screen_sessions(run_cmd(["screen", "-ls"], timeout=4)["stdout"])
    if "unmc-je" not in sessions:
        return {"ok": False, "code": None, "stdout": "", "stderr": "JE 现在没有运行，先点“启动全部”或“重启 JE”。"}
    log_start = SERVER_LOG.stat().st_size if SERVER_LOG.exists() else 0
    result = run_cmd(["screen", "-S", "unmc-je", "-p", "0", "-X", "stuff", "\x15" + command + "\r"], timeout=5)
    if result["ok"]:
        time.sleep(0.8)
        new_log = read_from(SERVER_LOG, log_start).strip()
        if new_log:
            result["stdout"] = "命令已发送，服务器回执：\n" + "\n".join(new_log.splitlines()[-8:])
        else:
            result["stdout"] = "命令已发送。服务器没有立刻写入新日志，可以看上面的日志区继续确认。"
    return result


def safe_plugin_filename(value: str) -> str:
    name = os.path.basename(value.strip())
    if not name or name != value or "/" in value or "\\" in value:
        raise ValueError("Invalid plugin filename")
    if name.startswith(".") or not (name.endswith(".jar") or name.endswith(".jar.disabled")):
        raise ValueError("Invalid plugin filename")
    return name


def action_toggle_plugin(filename: str, enabled: bool) -> dict:
    try:
        name = safe_plugin_filename(filename)
    except ValueError as exc:
        return {"ok": False, "code": None, "stdout": "", "stderr": str(exc)}

    plugins_dir = ROOT / "server" / "plugins"
    source = plugins_dir / name
    if enabled:
        if name.endswith(".jar"):
            return {"ok": True, "code": 0, "stdout": f"{name} 已经启用。\n重启 JE 后生效。", "stderr": ""}
        target = plugins_dir / name.removesuffix(".disabled")
    else:
        if name.endswith(".jar.disabled"):
            return {"ok": True, "code": 0, "stdout": f"{name} 已经停用。\n重启 JE 后生效。", "stderr": ""}
        target = plugins_dir / f"{name}.disabled"

    if not source.exists():
        return {"ok": False, "code": None, "stdout": "", "stderr": f"找不到插件文件：{name}"}
    if target.exists():
        return {"ok": False, "code": None, "stdout": "", "stderr": f"目标文件已存在：{target.name}"}
    try:
        source.rename(target)
    except OSError as exc:
        return {"ok": False, "code": None, "stdout": "", "stderr": str(exc)}
    SLOW_STATS_CACHE["at"] = 0.0
    action = "启用" if enabled else "停用"
    return {
        "ok": True,
        "code": 0,
        "stdout": f"已{action}插件：{target.name.removesuffix('.disabled')}\n重启 JE 后生效。",
        "stderr": "",
    }


def normalize_property_value(key: str, value: str) -> str:
    schema = EDITABLE_PROPERTIES.get(key)
    if not schema:
        raise ValueError(f"不允许编辑这个配置项：{key}")
    value = str(value).strip()
    if "\n" in value or "\r" in value:
        raise ValueError("配置值不能换行")
    kind = schema["type"]
    if kind == "choice":
        if value not in schema["choices"]:
            raise ValueError(f"{key} 的值不合法")
        return value
    if kind == "bool":
        lowered = value.lower()
        if lowered not in {"true", "false"}:
            raise ValueError(f"{key} 只能是 true 或 false")
        return lowered
    if kind == "int":
        try:
            number = int(value)
        except ValueError as exc:
            raise ValueError(f"{key} 必须是数字") from exc
        if number < int(schema["min"]) or number > int(schema["max"]):
            raise ValueError(f"{key} 必须在 {schema['min']} 到 {schema['max']} 之间")
        return str(number)
    if kind == "text":
        if len(value) > int(schema["max"]):
            raise ValueError(f"{key} 太长了")
        return value
    raise ValueError(f"{key} 暂不支持编辑")


def action_set_property(key: str, value: str) -> dict:
    key = str(key).strip()
    try:
        normalized = normalize_property_value(key, value)
    except ValueError as exc:
        return {"ok": False, "code": None, "stdout": "", "stderr": str(exc)}

    path = ROOT / "server" / "server.properties"
    if not path.exists():
        return {"ok": False, "code": None, "stdout": "", "stderr": "找不到 server.properties"}

    lines = path.read_text(errors="replace").splitlines()
    found = False
    updated = []
    for line in lines:
        if line.startswith("#") or "=" not in line:
            updated.append(line)
            continue
        current_key, _current_value = line.split("=", 1)
        if current_key == key:
            updated.append(f"{key}={normalized}")
            found = True
        else:
            updated.append(line)
    if not found:
        updated.append(f"{key}={normalized}")
    path.write_text("\n".join(updated) + "\n")
    SLOW_STATS_CACHE["at"] = 0.0
    return {"ok": True, "code": 0, "stdout": f"已保存：{key}={normalized}\n重启 JE 后生效。", "stderr": ""}


def action_set_backup_config(payload: dict) -> dict:
    current = load_backup_config()
    requested = {
        **current,
        "enabled": bool(payload.get("enabled", current["enabled"])),
        "mode": str(payload.get("mode", current["mode"])),
        "time": str(payload.get("time", current["time"])),
        "interval_hours": payload.get("interval_hours", current["interval_hours"]),
        "keep": payload.get("keep", current["keep"]),
    }
    saved = save_backup_config(requested)
    return {
        "ok": True,
        "code": 0,
        "stdout": f"已保存备份设置：{'开启' if saved['enabled'] else '关闭'}，保留 {saved['keep']} 份。",
        "stderr": "",
    }


def run_action(payload: dict) -> dict:
    action = payload.get("action", "")
    if action == "start_all":
        return action_start_all()
    if action == "start_server":
        return action_start_server()
    if action == "stop_server":
        return action_stop_server()
    if action == "restart_server":
        return action_restart_server()
    if action == "start_tunnel":
        return action_start_tunnel()
    if action == "stop_tunnel":
        return action_stop_tunnel()
    if action == "restart_tunnel":
        return action_restart_tunnel()
    if action == "console":
        return action_console(str(payload.get("command", "")))
    if action == "toggle_plugin":
        return action_toggle_plugin(str(payload.get("file", "")), bool(payload.get("enabled", False)))
    if action == "set_property":
        return action_set_property(str(payload.get("key", "")), str(payload.get("value", "")))
    if action == "set_backup_config":
        return action_set_backup_config(payload)
    if action == "backup_now":
        return start_backup("manual")
    return {"ok": False, "code": None, "stdout": "", "stderr": f"Unknown action: {action}"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Minecraft-Panel/1.0"

    def log_message(self, fmt: str, *args) -> None:
        return

    def write_json(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.send_static(STATIC_DIR / "index.html")
            return
        if parsed.path.startswith("/static/"):
            requested = (STATIC_DIR / parsed.path.removeprefix("/static/")).resolve()
            if STATIC_DIR.resolve() not in requested.parents and requested != STATIC_DIR.resolve():
                self.send_error(403)
                return
            self.send_static(requested)
            return
        if parsed.path == "/api/status":
            self.write_json(status_payload())
            return
        if parsed.path == "/api/logs":
            query = parse_qs(parsed.query)
            target = query.get("target", ["server"])[0]
            lines = min(max(int(query.get("lines", ["160"])[0]), 20), 800)
            path = SERVER_LOG if target == "server" else TUNNEL_LOG
            self.write_json({"target": target, "text": read_tail(path, lines=lines)})
            return
        self.send_error(404)

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/" or parsed.path.startswith("/static/"):
            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        self.send_error(404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/action":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.write_json({"ok": False, "stderr": "Invalid JSON"}, code=400)
            return
        result = run_action(payload)
        self.write_json({"result": result, "status": status_payload()})


def main() -> None:
    os.chdir(ROOT)
    save_backup_config(load_backup_config())
    threading.Thread(target=backup_scheduler_loop, daemon=True).start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Minecraft panel listening on http://{HOST}:{PORT}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
