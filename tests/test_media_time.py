import datetime as dt
import os
import struct
import tempfile
import time
import unittest

from app import media_time


def tiff_with_capture_time(taken: str, offset: str = "", order: str = "<") -> bytes:
    """A minimal EXIF TIFF block: IFD0 -> Exif IFD -> DateTimeOriginal (+ OffsetTimeOriginal)."""
    marker = b"II" if order == "<" else b"MM"
    entries = [(media_time.TAG_DATETIME_ORIGINAL, taken.encode() + b"\x00")]
    if offset:
        entries.append((media_time.TAG_OFFSET_TIME_ORIGINAL, offset.encode() + b"\x00"))
    ifd0_at = 8
    exif_at = ifd0_at + 2 + 12 + 4
    data_at = exif_at + 2 + 12 * len(entries) + 4
    ifd0 = struct.pack(order + "H", 1) + struct.pack(order + "HHII", media_time.TAG_EXIF_IFD, 4, 1, exif_at) + b"\0\0\0\0"
    exif = struct.pack(order + "H", len(entries))
    blobs = b""
    for tag, value in entries:
        exif += struct.pack(order + "HHII", tag, 2, len(value), data_at + len(blobs))
        blobs += value
    exif += b"\0\0\0\0"
    return marker + struct.pack(order + "HI", 42, ifd0_at) + ifd0 + exif + blobs


def jpeg(tiff: bytes) -> bytes:
    app1 = b"Exif\x00\x00" + tiff
    return b"\xff\xd8" + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + b"\xff\xda\x00\x02" + b"pixels"


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload) + 8) + kind + payload


def heic(tiff: bytes) -> bytes:
    exif_item = struct.pack(">I", 6) + b"Exif\x00\x00" + tiff
    ftyp = box(b"ftyp", b"heic" + b"\0\0\0\0" + b"mif1heic")
    infe = box(b"infe", b"\x02\0\0\0" + struct.pack(">HH", 7, 0) + b"Exif" + b"\x00")
    iinf = box(b"iinf", b"\0\0\0\0" + struct.pack(">H", 1) + infe)

    def iloc(offset):
        return box(b"iloc", b"\0\0\0\0" + bytes([0x44, 0x00]) + struct.pack(">H", 1)
                   + struct.pack(">HHH", 7, 0, 1) + struct.pack(">II", offset, len(exif_item)))

    meta_len = len(box(b"meta", b"\0\0\0\0" + iinf + iloc(0)))
    exif_offset = len(ftyp) + meta_len + 8  # Inside the mdat that follows.
    meta = box(b"meta", b"\0\0\0\0" + iinf + iloc(exif_offset))
    return ftyp + meta + box(b"mdat", exif_item)


def mp4(created_utc: dt.datetime) -> bytes:
    seconds = int(created_utc.timestamp()) + media_time.MAC_EPOCH_OFFSET
    mvhd = box(b"mvhd", b"\0\0\0\0" + struct.pack(">II", seconds, seconds) + b"\0" * 80)
    # moov after the media data, as phones write it.
    return box(b"ftyp", b"qt  \0\0\0\0qt  ") + box(b"mdat", b"frames") + box(b"moov", mvhd)


class MediaTimeTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="crosssync-time-")
        self.addCleanup(self.dir.cleanup)

    def write(self, name, data):
        path = os.path.join(self.dir.name, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def test_jpeg_capture_time_uses_the_recorded_time_zone(self):
        path = self.write("a.jpg", jpeg(tiff_with_capture_time("2024:05:01 08:30:00", "+08:00")))
        expected = dt.datetime(2024, 5, 1, 0, 30, tzinfo=dt.timezone.utc).timestamp()
        self.assertEqual(media_time.capture_time(path), expected)

    def test_jpeg_without_a_zone_is_read_as_local_time(self):
        path = self.write("a.jpg", jpeg(tiff_with_capture_time("2023:12:24 19:05:09", order=">")))
        self.assertEqual(media_time.capture_time(path), dt.datetime(2023, 12, 24, 19, 5, 9).timestamp())

    def test_heic_exif_item_is_found_through_the_item_tables(self):
        path = self.write("a.heic", heic(tiff_with_capture_time("2022:07:15 12:00:00", "-05:00")))
        expected = dt.datetime(2022, 7, 15, 17, 0, tzinfo=dt.timezone.utc).timestamp()
        self.assertEqual(media_time.capture_time(path), expected)

    def test_video_creation_time_comes_from_the_movie_header(self):
        created = dt.datetime(2021, 3, 2, 4, 5, 6, tzinfo=dt.timezone.utc)
        path = self.write("a.mov", mp4(created))
        self.assertEqual(media_time.capture_time(path), created.timestamp())

    def test_unknown_or_broken_files_have_no_capture_time(self):
        for name, data in [("a.png", b"\x89PNG\r\n\x1a\n"), ("b.jpg", b"\xff\xd8\xff"), ("c.heic", b"\0\0\0\x10ftypheic\xff\xff"),
                           ("d.jpg", jpeg(b"garbage")), ("e.txt", b"")]:
            self.assertIsNone(media_time.capture_time(self.write(name, data)), name)

    def test_saved_file_gets_capture_time_else_the_phone_time(self):
        photo = self.write("a.jpg", jpeg(tiff_with_capture_time("2020:01:02 03:04:05")))
        self.assertTrue(media_time.apply_original_time(photo, client_ms=1_700_000_000_000))
        self.assertEqual(os.path.getmtime(photo), dt.datetime(2020, 1, 2, 3, 4, 5).timestamp())

        other = self.write("notes.txt", b"hello")
        self.assertTrue(media_time.apply_original_time(other, client_ms="1600000000000"))
        self.assertEqual(os.path.getmtime(other), 1_600_000_000)

    def test_implausible_times_are_ignored(self):
        path = self.write("notes.txt", b"hello")
        before = os.path.getmtime(path)
        for bad in (None, "", "soon", 0, (time.time() + 7 * 86400) * 1000):
            self.assertFalse(media_time.apply_original_time(path, client_ms=bad), bad)
        self.assertEqual(os.path.getmtime(path), before)


if __name__ == "__main__":
    unittest.main()
