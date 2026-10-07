import asyncio
import unittest
import uuid
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.main as main
from app import pairing


class AssetVersionTests(unittest.TestCase):
    def test_pages_and_service_worker_share_asset_version(self):
        with TestClient(main.app) as client:
            headers = {"Authorization": f"Bearer {main.settings.access_token}"}
            page = client.get("/app", headers=headers).text
            worker = client.get("/sw.js").text
        version = main.ASSET_VERSION
        for script in ("core", "wake", "upload", "files"):
            self.assertIn(f"/static/js/{script}.js?v={version}", page)
        self.assertIn(f"/static/styles.css?v={version}", page)
        self.assertIn(f"crosssync-shell-{version}", worker)
        self.assertNotIn("__ASSET_VERSION__", worker)
        self.assertNotIn("figma", page.lower())


class ScanEventTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patcher = patch.object(pairing, "sse_clients", {})
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_rejects_malformed_session_ids(self):
        with self.assertRaises(HTTPException) as caught:
            await pairing.sse_endpoint("../../etc")
        self.assertEqual(caught.exception.status_code, 400)

    async def test_caps_waiting_qr_pages(self):
        for _ in range(pairing.SSE_MAX_CLIENTS):
            pairing.sse_clients[uuid.uuid4().hex] = asyncio.Queue()
        with self.assertRaises(HTTPException) as caught:
            await pairing.sse_endpoint(uuid.uuid4().hex)
        self.assertEqual(caught.exception.status_code, 429)

    async def test_scan_is_delivered_and_waiter_removed(self):
        sid = uuid.uuid4().hex
        response = await pairing.sse_endpoint(sid)
        events = response.body_iterator
        first = asyncio.ensure_future(events.__anext__())
        await asyncio.sleep(0)
        await pairing.api_scanned(sid)
        self.assertEqual(await asyncio.wait_for(first, 2), "data: scanned\n\n")
        with self.assertRaises(StopAsyncIteration):
            await events.__anext__()
        self.assertEqual(pairing.sse_clients, {})

    async def test_idle_waiter_expires_after_keepalives(self):
        sid = uuid.uuid4().hex
        with patch.object(pairing, "SSE_TTL_SECONDS", 0.2), patch.object(pairing, "SSE_KEEPALIVE_SECONDS", 0.05):
            response = await pairing.sse_endpoint(sid)
            chunks = [chunk async for chunk in response.body_iterator]
        self.assertIn(": keepalive\n\n", chunks)
        self.assertEqual(chunks[-1], "event: expired\ndata: expired\n\n")
        self.assertEqual(pairing.sse_clients, {})


if __name__ == "__main__":
    unittest.main()
