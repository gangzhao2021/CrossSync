import asyncio
import hashlib
import json
import os
import tempfile
import time
import threading
import errno
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from app.config import settings
import app.main as main
from app.uploader import UploadStore


class ChunkRequest:
    def __init__(self, data, ready=None, release=None):
        self.data = data
        self.headers = {"x-sha256": hashlib.sha256(data).hexdigest()}
        self.ready = ready
        self.release = release

    async def stream(self):
        yield self.data
        if self.ready:
            self.ready.set()
        if self.release:
            await self.release.wait()


def finish_request():
    return Request({"type": "http", "query_string": b"checksum=1", "headers": []})


class UploadReliabilityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="crosssync-regression-"))
        self.destination = os.path.join(root, "downloads")
        self.temp = os.path.join(root, "temp")
        self.metadata = os.path.join(root, "metadata")
        for path in (self.destination, self.temp, self.metadata):
            os.makedirs(path)
        for key, value in {
            "downloads_dir": self.destination, "outbox_dir": self.destination,
            "temp_dir": self.temp, "metadata_dir": self.metadata,
            "min_chunk_size": 1, "min_free_space_reserve": 0,
            "direct_upload_assembly": True, "write_sha256_sidecar": False,
        }.items():
            self.stack.enter_context(patch.object(settings, key, value))
        self.store = UploadStore(os.path.join(self.temp, "uploads"))
        self.stack.enter_context(patch.object(main, "upload_store", self.store))
        self.stack.enter_context(patch.object(main, "upload_slots", asyncio.Semaphore(8)))
        self.stack.enter_context(patch.object(main, "stream_reservations", {}))
        self.payload = {"name": "sample.bin", "size": 8, "chunk_size": 4,
                        "client_id": "test", "resume_key": "asset"}

    async def initialize(self, **overrides):
        return json.loads((await main.init_upload({**self.payload, **overrides})).body)

    async def test_concurrent_finish_and_reselection_reuse_persisted_receipt(self):
        initialized = await self.initialize()
        sid = initialized["upload_id"]
        await asyncio.gather(main.upload_chunk(sid, 0, ChunkRequest(b"abcd")),
                             main.upload_chunk(sid, 1, ChunkRequest(b"efgh")))
        receipts = await asyncio.gather(main.finish_upload(sid, finish_request()),
                                        main.finish_upload(sid, finish_request()))
        first, second = [json.loads(r.body) for r in receipts]
        self.assertEqual(first["saved"], second["saved"])
        self.assertEqual(first["sha256"], hashlib.sha256(b"abcdefgh").hexdigest())
        self.assertEqual(os.listdir(self.destination), ["sample.bin"])
        self.assertEqual(self.store.reserved_bytes(), 0)
        # Simulate a server restart after the success response was lost.
        restarted = UploadStore(self.store.base_dir)
        with patch.object(main, "upload_store", restarted):
            retry = json.loads((await main.finish_upload(sid, finish_request())).body)
            reselected = await self.initialize()
        self.assertEqual(retry["saved"], first["saved"])
        self.assertEqual(reselected["upload_id"], sid)
        self.assertEqual(reselected["missing"], [])
        os.remove(first["saved"])
        self.assertNotEqual((await self.initialize())["upload_id"], sid)

    async def test_concurrent_duplicate_chunks_never_share_staging_file(self):
        sid = (await self.initialize(size=4))["upload_id"]
        ready_a, ready_b, release_a, release_b = [asyncio.Event() for _ in range(4)]
        first = asyncio.create_task(main.upload_chunk(sid, 0, ChunkRequest(b"aaaa", ready_a, release_a)))
        second = asyncio.create_task(main.upload_chunk(sid, 0, ChunkRequest(b"bbbb", ready_b, release_b)))
        await asyncio.wait_for(asyncio.gather(ready_a.wait(), ready_b.wait()), 5)
        staging = [p for p in os.listdir(self.store.session_dir(sid)) if p.endswith(".uploading")]
        self.assertEqual(len(staging), 2)
        release_a.set()
        await first
        release_b.set()
        await second
        receipt = json.loads((await main.finish_upload(sid, finish_request())).body)
        with open(receipt["saved"], "rb") as f:
            self.assertEqual(f.read(), b"aaaa")
        self.assertEqual(receipt["sha256"], hashlib.sha256(b"aaaa").hexdigest())

    async def test_cancellation_prevents_inflight_chunk_commit(self):
        sid = (await self.initialize(size=4))["upload_id"]
        ready, release = asyncio.Event(), asyncio.Event()
        task = asyncio.create_task(main.upload_chunk(sid, 0, ChunkRequest(b"abcd", ready, release)))
        await asyncio.wait_for(ready.wait(), 5)
        await main.cancel_upload(sid.upper())
        release.set()
        with self.assertRaises(HTTPException) as caught:
            await task
        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse(os.path.exists(self.store.session_dir(sid)))
        self.assertEqual(os.listdir(self.destination), [])

    async def test_cleanup_uses_activity_and_never_removes_live_upload(self):
        sid = (await self.initialize(size=4))["upload_id"]
        ready, release = asyncio.Event(), asyncio.Event()
        task = asyncio.create_task(main.upload_chunk(sid, 0, ChunkRequest(b"abcd", ready, release)))
        await asyncio.wait_for(ready.wait(), 5)
        old = time.time() - settings.temp_ttl_seconds - 100
        os.utime(self.store.meta_path(sid), (old, old))
        self.store.cleanup_expired()
        self.assertTrue(os.path.exists(self.store.meta_path(sid)))
        release.set()
        await task
        self.store.cleanup_expired()
        self.assertTrue(os.path.exists(self.store.meta_path(sid)))
        self.store.cleanup_expired(time.time() + settings.temp_ttl_seconds + 1)
        self.assertFalse(os.path.exists(self.store.session_dir(sid)))

    async def test_cross_volume_temp_space_is_checked(self):
        with patch.object(main, "disk_device", side_effect=lambda p: 1 if p == self.temp else 2), patch.object(
            main.shutil, "disk_usage", side_effect=lambda p: SimpleNamespace(free=3 if p == self.temp else 1000)
        ):
            with self.assertRaises(HTTPException) as caught:
                await self.initialize(size=4)
        self.assertEqual(caught.exception.status_code, 507)
        self.assertEqual(self.store.list_sessions(), [])

    async def test_stream_reservations_share_disk_budget(self):
        with patch.object(main.shutil, "disk_usage", return_value=SimpleNamespace(free=10)):
            main.reserve_stream_capacity("one", 6, self.destination)
            with self.assertRaises(HTTPException):
                main.reserve_stream_capacity("two", 6, self.destination)
            main.release_stream_capacity("one")
            main.reserve_stream_capacity("two", 6, self.destination)
            main.release_stream_capacity("two")
        self.assertEqual(main.stream_reservations, {})

    async def test_incomplete_outputs_are_not_listed_downloaded_or_cleared(self):
        for name in ("video.mov.assembling-review.tmp", "video.mov.streaming-review.tmp"):
            full = os.path.join(self.destination, name)
            with open(full, "wb") as f:
                f.write(b"partial")
            self.assertEqual(list(main.iter_files_within(self.destination)), [])
            with self.assertRaises(HTTPException) as caught:
                await main.download_area_file("downloads", name)
            self.assertEqual(caught.exception.status_code, 404)
        await main.api_delete({"area": "downloads", "clear": True})
        self.assertEqual(len(os.listdir(self.destination)), 2)

    async def test_bad_checksum_does_not_create_completed_chunk(self):
        sid = (await self.initialize(size=4))["upload_id"]
        request = ChunkRequest(b"abcd")
        request.headers["x-sha256"] = "0" * 64
        with self.assertRaises(HTTPException):
            await main.upload_chunk(sid, 0, request)
        self.assertEqual(self.store.missing_chunks(sid), [0])
        self.assertFalse(any(p.endswith(".uploading") for p in os.listdir(self.store.session_dir(sid))))

    async def test_buffered_assembly_still_resumes_and_finishes(self):
        with patch.object(settings, "direct_upload_assembly", False):
            sid = (await self.initialize())["upload_id"]
            await main.upload_chunk(sid, 0, ChunkRequest(b"abcd"))
            self.assertEqual((await self.initialize())["missing"], [1])
            await main.upload_chunk(sid, 1, ChunkRequest(b"efgh"))
            receipt = json.loads((await main.finish_upload(sid, finish_request())).body)
        with open(receipt["saved"], "rb") as f:
            self.assertEqual(f.read(), b"abcdefgh")

    async def test_slow_commit_does_not_block_other_requests(self):
        sid = (await self.initialize(size=4))["upload_id"]
        entered, release = threading.Event(), threading.Event()
        original = self.store.commit_streamed_chunk

        def slow_commit(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test failed to release commit")
            return original(*args, **kwargs)

        with patch.object(self.store, "commit_streamed_chunk", side_effect=slow_commit):
            task = asyncio.create_task(main.upload_chunk(sid, 0, ChunkRequest(b"abcd")))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                response = await asyncio.wait_for(main.healthz(), 1)
                self.assertTrue(json.loads(response.body)["ok"])
                self.assertFalse(task.done())
            finally:
                release.set()
                await task

    async def test_disconnected_finish_still_leaves_retryable_receipt(self):
        sid = (await self.initialize(size=4))["upload_id"]
        await main.upload_chunk(sid, 0, ChunkRequest(b"abcd"))
        entered, release = threading.Event(), threading.Event()
        original = self.store.assemble

        def slow_assemble(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test failed to release assembly")
            return original(*args, **kwargs)

        with patch.object(self.store, "assemble", side_effect=slow_assemble):
            task = asyncio.create_task(main.finish_upload(sid, finish_request()))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                task.cancel()
            finally:
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        receipt = json.loads((await main.finish_upload(sid, finish_request())).body)
        self.assertEqual(receipt["path"], "sample.bin")
        self.assertEqual(os.listdir(self.destination), ["sample.bin"])

    async def test_stream_upload_releases_capacity_on_success_and_failure(self):
        good = ChunkRequest(b"abcd")
        good.query_params = {"name": "stream.bin", "size": "4", "checksum": "1"}
        receipt = json.loads((await main.upload_stream(good)).body)
        with open(receipt["saved"], "rb") as f:
            self.assertEqual(f.read(), b"abcd")
        self.assertEqual(main.stream_reservations, {})
        bad = ChunkRequest(b"too long")
        bad.query_params = {"name": "bad.bin", "size": "4"}
        with self.assertRaises(HTTPException):
            await main.upload_stream(bad)
        self.assertEqual(main.stream_reservations, {})
        self.assertFalse(os.path.exists(os.path.join(self.destination, "bad.bin")))

    async def test_cross_volume_assembly_falls_back_to_hidden_copy(self):
        sid = (await self.initialize(size=4))["upload_id"]
        await main.upload_chunk(sid, 0, ChunkRequest(b"abcd"))
        replace = os.replace
        copied = []

        def cross_volume_replace(source, destination):
            if source == self.store.payload_path(sid):
                raise OSError(errno.EXDEV, "simulated cross-device move")
            if ".assembling-" in source:
                copied.append(source)
                self.assertTrue(main.is_hidden_transfer_file(os.path.basename(source)))
            return replace(source, destination)

        with patch.object(os, "replace", side_effect=cross_volume_replace):
            receipt = json.loads((await main.finish_upload(sid, finish_request())).body)
        self.assertEqual(len(copied), 1)
        with open(receipt["saved"], "rb") as f:
            self.assertEqual(f.read(), b"abcd")
        self.assertEqual(os.listdir(self.destination), ["sample.bin"])

    async def test_receipts_do_not_require_directory_scans_on_new_uploads(self):
        sid = (await self.initialize(size=0))["upload_id"]
        await main.finish_upload(sid, finish_request())
        restarted = UploadStore(self.store.base_dir)
        with patch.object(main, "upload_store", restarted), patch.object(
            restarted, "list_sessions", side_effect=AssertionError("unexpected directory scan")
        ):
            self.assertEqual((await self.initialize(size=0))["upload_id"], sid)
            second = await self.initialize(name="second.bin", resume_key="second", size=0)
            self.assertNotEqual(second["upload_id"], sid)


if __name__ == "__main__":
    unittest.main()
