"""When a photo or video was taken, read from the file itself.

Saved files should carry the capture time as their modified time, so sorting a
folder by date shows photos in the order they were taken. The phone's own file
time is unreliable: Safari reports when iOS exported the photo, not when it
was shot. The capture time is read from:

- JPEG: EXIF DateTimeOriginal in the APP1 segment
- HEIC / HEIF / AVIF: the same EXIF block, stored as an "Exif" item
- MOV / MP4: the movie header's creation time (UTC)

Only the header bytes are read. Anything unexpected returns None.
"""
import datetime as dt
import os
import struct
import time
from typing import BinaryIO, Optional

JPEG_SCAN_BYTES = 256 * 1024
MAX_EXIF_BYTES = 256 * 1024
MAC_EPOCH_OFFSET = 2_082_844_800  # Seconds from 1904-01-01 to 1970-01-01.
EARLIEST = dt.datetime(1990, 1, 1).timestamp()

TAG_EXIF_IFD = 0x8769
TAG_DATETIME = 0x0132
TAG_DATETIME_ORIGINAL = 0x9003
TAG_OFFSET_TIME_ORIGINAL = 0x9011


def capture_time(path: str) -> Optional[float]:
    """Seconds since the epoch when the photo or video was taken, if the file says."""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
            f.seek(0)
            if head[:2] == b"\xff\xd8":
                found = _jpeg_time(f)
            elif head[4:8] == b"ftyp":
                found = _isobmff_time(f, os.fstat(f.fileno()).st_size)
            else:
                found = None
    except (OSError, ValueError, struct.error):
        return None
    return found if found is not None and _plausible(found) else None


def _plausible(seconds: float) -> bool:
    return EARLIEST <= seconds <= time.time() + 86400


def chosen_time(path: str, client_ms) -> Optional[float]:
    """The time to stamp on a saved file: the capture time, else the phone's file time."""
    found = capture_time(path)
    if found is not None:
        return found
    try:
        seconds = int(client_ms) / 1000
    except (TypeError, ValueError):
        return None
    return seconds if _plausible(seconds) else None


def apply_original_time(path: str, client_ms=None) -> bool:
    """Set the saved file's modified time to when it was taken. Returns True if changed."""
    when = chosen_time(path, client_ms)
    if when is None:
        return False
    try:
        os.utime(path, (time.time(), when))
    except OSError:
        return False
    return True


# ---- JPEG -------------------------------------------------------------------

def _jpeg_time(f: BinaryIO) -> Optional[float]:
    data = f.read(JPEG_SCAN_BYTES)
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            return None
        marker = data[pos + 1]
        if marker in (0xD9, 0xDA):  # End of image, or image data starts: no more metadata.
            return None
        length = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        segment = data[pos + 4:pos + 2 + length]
        if marker == 0xE1 and segment.startswith(b"Exif\x00\x00"):
            return _tiff_time(segment[6:])
        pos += 2 + length
    return None


# ---- HEIC / HEIF / MP4 / MOV (ISO base media file format) --------------------

def _boxes(f: BinaryIO, start: int, end: int):
    """Yield (type, payload_start, payload_end) for the boxes in [start, end)."""
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        header = f.read(16)
        if len(header) < 8:
            return
        size, kind = struct.unpack(">I4s", header[:8])
        header_len = 8
        if size == 1:
            if len(header) < 16:
                return
            size = struct.unpack(">Q", header[8:16])[0]
            header_len = 16
        elif size == 0:
            size = end - pos
        if size < header_len or pos + size > end:
            return
        yield kind, pos + header_len, pos + size
        pos += size


def _isobmff_time(f: BinaryIO, file_size: int) -> Optional[float]:
    for kind, start, end in _boxes(f, 0, file_size):
        if kind == b"meta":
            found = _heif_exif_time(f, start + 4, end)  # meta is a full box: skip version and flags.
            if found is not None:
                return found
        elif kind == b"moov":
            found = _movie_time(f, start, end)
            if found is not None:
                return found
    return None


def _movie_time(f: BinaryIO, start: int, end: int) -> Optional[float]:
    for kind, box_start, box_end in _boxes(f, start, end):
        if kind != b"mvhd":
            continue
        f.seek(box_start)
        version = f.read(1)[0]
        f.read(3)
        if version == 1:
            created = struct.unpack(">Q", f.read(8))[0]
        else:
            created = struct.unpack(">I", f.read(4))[0]
        if created == 0:
            return None
        return created - MAC_EPOCH_OFFSET
    return None


def _heif_exif_time(f: BinaryIO, start: int, end: int) -> Optional[float]:
    exif_item = None
    locations = {}
    for kind, box_start, box_end in _boxes(f, start, end):
        if kind == b"iinf":
            exif_item = _exif_item_id(f, box_start, box_end)
        elif kind == b"iloc":
            locations = _item_locations(f, box_start)
    if exif_item is None or exif_item not in locations:
        return None
    offset, length = locations[exif_item]
    if length <= 4 or length > MAX_EXIF_BYTES:
        return None
    f.seek(offset)
    data = f.read(length)
    # The item starts with the offset of the TIFF header, usually past "Exif\0\0".
    tiff_offset = struct.unpack(">I", data[:4])[0]
    return _tiff_time(data[4 + tiff_offset:])


def _exif_item_id(f: BinaryIO, start: int, end: int) -> Optional[int]:
    f.seek(start)
    version = f.read(4)[0]
    count_size = 2 if version == 0 else 4
    f.read(count_size)
    for kind, box_start, _ in _boxes(f, start + 4 + count_size, end):
        if kind != b"infe":
            continue
        f.seek(box_start)
        entry_version = f.read(4)[0]
        if entry_version < 2:
            continue
        item_id = struct.unpack(">H" if entry_version == 2 else ">I", f.read(2 if entry_version == 2 else 4))[0]
        f.read(2)  # Protection index.
        if f.read(4) == b"Exif":
            return item_id
    return None


def _item_locations(f: BinaryIO, start: int) -> dict:
    """item_id -> (absolute offset, length) of each item's first extent."""
    f.seek(start)
    version = f.read(4)[0]
    sizes = f.read(2)
    offset_size, length_size = sizes[0] >> 4, sizes[0] & 0x0F
    base_offset_size = sizes[1] >> 4
    index_size = sizes[1] & 0x0F if version in (1, 2) else 0
    count = struct.unpack(">H" if version < 2 else ">I", f.read(2 if version < 2 else 4))[0]

    def number(size: int) -> int:
        return int.from_bytes(f.read(size), "big") if size else 0

    found = {}
    for _ in range(min(count, 10_000)):
        item_id = number(2 if version < 2 else 4)
        if version in (1, 2):
            f.read(2)  # Construction method.
        f.read(2)  # Data reference index.
        base = number(base_offset_size)
        extents = struct.unpack(">H", f.read(2))[0]
        first = None
        for _ in range(extents):
            number(index_size)
            extent_offset = number(offset_size)
            extent_length = number(length_size)
            if first is None:
                first = (base + extent_offset, extent_length)
        if first:
            found[item_id] = first
    return found


# ---- EXIF (TIFF structure) ---------------------------------------------------

def _tiff_time(tiff: bytes) -> Optional[float]:
    if tiff[:2] == b"II":
        order = "<"
    elif tiff[:2] == b"MM":
        order = ">"
    else:
        return None
    first_ifd = struct.unpack(order + "I", tiff[4:8])[0]
    ifd0 = _ifd(tiff, first_ifd, order)
    exif = _ifd(tiff, ifd0[TAG_EXIF_IFD][1], order) if TAG_EXIF_IFD in ifd0 else {}
    raw = _ascii(tiff, exif.get(TAG_DATETIME_ORIGINAL), order) or _ascii(tiff, ifd0.get(TAG_DATETIME), order)
    if not raw:
        return None
    try:
        taken = dt.datetime.strptime(raw[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    offset = _ascii(tiff, exif.get(TAG_OFFSET_TIME_ORIGINAL), order)
    zone = _parse_offset(offset) if offset else None
    if zone is not None:
        return taken.replace(tzinfo=zone).timestamp()
    return taken.timestamp()  # No zone recorded: the phone and computer usually share one.


def _ifd(tiff: bytes, offset: int, order: str) -> dict:
    """tag -> (type, value_or_offset, count) for one image file directory."""
    if offset + 2 > len(tiff):
        return {}
    count = struct.unpack(order + "H", tiff[offset:offset + 2])[0]
    entries = {}
    for index in range(count):
        at = offset + 2 + index * 12
        if at + 12 > len(tiff):
            break
        tag, kind, items = struct.unpack(order + "HHI", tiff[at:at + 8])
        entries[tag] = (kind, struct.unpack(order + "I", tiff[at + 8:at + 12])[0], items, at + 8)
    return entries


def _ascii(tiff: bytes, entry, order: str) -> Optional[str]:
    if not entry or entry[0] != 2:  # 2 = ASCII
        return None
    _, value, items, inline_at = entry
    start = inline_at if items <= 4 else value
    raw = tiff[start:start + items]
    return raw.split(b"\x00", 1)[0].decode("ascii", "ignore").strip() or None


def _parse_offset(text: str) -> Optional[dt.timezone]:
    try:
        sign = -1 if text[0] == "-" else 1
        hours, minutes = int(text[1:3]), int(text[4:6])
    except (IndexError, ValueError):
        return None
    return dt.timezone(sign * dt.timedelta(hours=hours, minutes=minutes))
